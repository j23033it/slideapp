/**
 * 表示中のスライド（Shadow DOM）と編集エンジンをつなぐ。
 * クリック位置のキャレット、読み取り専用の理由、ランの境界での削除、
 * 編集終了時のスライド単位の再描画を持つ。
 */
import type { Cursor } from '../document'
import { resolveCursor, type Analysis, type EditingEngine, type EditResult, type ReadonlyCode } from '../editing'
import { bindEditing } from '../editing/dom'
import { selectionFor } from '../editing/dom/selection'
import type { RenderedDeck } from '../marp/renderer'
import type { SlideSurface } from '../marp/surface'
import {
  caretInRun,
  offsetInRun,
  pointInRun,
  runElementOf,
  selectionInRun,
  setCaretInRun,
} from './caret'
import { planBoundaryDeletion, areRunsDomAdjacent } from './runDeletion'
import { CompositionGate } from './session'
import { strings } from './strings'

export type EditSuccess = Extract<EditResult, { ok: true }>

export interface EditingCursors {
  before?: Cursor
  after?: Cursor
}

export interface StageFocus {
  seq: number
  cursor: Cursor
}

export interface StageEditorOptions {
  /** 直近に採用された解析結果とデッキ（編集終了時の再描画に使う） */
  latest(): { analysis: Analysis; deck: RenderedDeck }
  onBegin(label: string): void
  onEnd(): void
  onNotice(code: ReadonlyCode): void
  onCommit(result: EditSuccess, cursors: EditingCursors): void
  onCrossRun(result: EditSuccess, target: Cursor, before?: Cursor): void
  onHistory(direction: 'undo' | 'redo'): void
}

function labelForBlock(block: HTMLElement | null): string {
  const tag = block?.tagName.toLowerCase() ?? ''
  if (/^h[1-6]$/.test(tag)) return strings.status.editing.heading(Number(tag.slice(1)))
  if (tag === 'li') return strings.status.editing.listItem
  return strings.status.editing.paragraph
}

/** 読み取り専用の要素から理由コードを推定する（エンジンが対応表を持つものはそちらを優先） */
function reasonForElement(element: Element): ReadonlyCode {
  const marked = element.closest<HTMLElement>('[data-sm-readonly]')?.dataset.smReadonly
  if (marked) return marked as ReadonlyCode
  if (element.closest('table')) return 'table'
  if (element.closest('pre, code')) return 'code'
  if (element.closest('img, picture')) return 'image'
  if (element.closest('mjx-container, .math, math, [data-math]')) return 'math'
  return 'generated'
}

export class StageEditor {
  private adapter: ReturnType<typeof bindEditing> | null = null
  private analysis: Analysis
  private deck: RenderedDeck
  private current = 0
  private editing = false
  private suppressFinish = false
  private pendingBefore: Cursor | undefined
  private lastFocusSeq = -1
  private readonly composition = new CompositionGate()
  private compositionEndToken: number | null = null
  private suppressEnterUntil = 0
  private recoveringDraftSelection = false
  private pointerSelection: Range | null | undefined

  private readonly onPointerDown = (): void => {
    const selection = selectionFor(this.root)
    this.pointerSelection = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
  }

  private readonly suppressConfirmationEnter = (): void => {
    this.suppressEnterUntil = performance.now() + 100
  }

  private hasPendingComposition(): boolean {
    return this.composition.isComposing || (this.adapter?.hasPendingComposition() ?? false)
  }

  private readonly onCompositionStart = (): void => {
    this.suppressEnterUntil = 0
    this.composition.start()
  }

  private readonly onCompositionEnd = (): void => {
    // Some TSF IMEs replay the confirmation Enter as an ordinary keydown.
    this.suppressConfirmationEnter()
    // WebView2 では capture 側のマイクロタスクが、アダプタの bubble 側
    // compositionend より先に実行されることがある。解除はアダプタの後で行う。
    this.compositionEndToken = this.composition.markEnded()
  }

  private readonly onCompositionEndSettled = (): void => {
    const token = this.compositionEndToken
    this.compositionEndToken = null
    if (token !== null) queueMicrotask(() => this.composition.flush(token))
  }

  private readonly onBlur = (event: Event): void => {
    this.settleComposition()
    if (!this.analysis.draft) return
    // 同じ空行ブロック内でのフォーカス移動では下書きを取り消さない
    const next = (event as FocusEvent).relatedTarget
    const draftBlock = this.runElement(this.analysis.draft.runId)?.closest('[data-sm-block]')
    if (next instanceof Node && draftBlock?.contains(next)) return
    this.adapter?.finish()
  }

  /** Commit the retained DOM before releasing save/navigation waiters. */
  private settleComposition(): void {
    const pending = this.hasPendingComposition()
    const token = this.composition.markEnded()
    this.adapter?.settleComposition()
    if (pending && token === this.composition.markEnded()) this.suppressConfirmationEnter()
    this.composition.flush(token)
  }

  private readonly onClick = (raw: Event): void => {
    const event = raw as MouseEvent
    if (event.button !== 0) return
    this.suppressEnterUntil = 0
    this.settleComposition()
    const target = event.composedPath()[0]
    const element = target instanceof Element ? target : null
    if (!element || !this.root.contains(element)) return
    // ドラッグやダブルクリックで作った選択を、その直後の click で崩さない。
    // 選択の置換は今回の対象外なので、編集を始めずそのまま残す。
    const previousSelection = this.pointerSelection
    this.pointerSelection = undefined
    if (this.clickEndsSelection(element, event, previousSelection)) return

    let runElement = element.closest<HTMLElement>('[data-sm-run]')
    const clickedId = runElement?.dataset.smRun
    let run = this.analysis.runs.find((entry) => entry.id === clickedId)
    if (this.analysis.draft && run?.id !== this.analysis.draft.runId) {
      const insertion = this.analysis.draft.edit
      const oldSource = run?.segments[0]?.start
      const source = oldSource === undefined ? undefined : oldSource >= insertion.start + insertion.insert.length ? oldSource - insertion.insert.length : oldSource
      this.endEditing()
      run = source === undefined ? undefined : this.analysis.runs.find(entry => entry.segments[0]?.start === source)
      runElement = run ? this.runElement(run.id) : null
    }

    if (runElement && run?.editable) {
      const id = run.id
      if (!this.adapter?.begin(runElement)) return
      this.editing = true
      const fresh = this.runElement(id)
      if (!fresh) return
      const block = fresh.closest<HTMLElement>('[data-sm-block]')
      block?.focus({ preventScroll: true })
      this.options.onBegin(labelForBlock(block))
      const existing = selectionInRun(this.root, fresh)
      if (!existing || existing.collapsed || previousSelection !== undefined) {
        const point = caretInRun(fresh, event.clientX, event.clientY, this.root)
        if (point) {
          selectionFor(this.root)
            ?.setBaseAndExtent(point.node, point.offset, point.node, point.offset)
        }
      }
      return
    }

    const blockElement = element.closest<HTMLElement>('[data-sm-block]')
    const block = blockElement
      ? this.analysis.blocks.find((entry) => entry.id === blockElement.dataset.smBlock)
      : undefined
    const structural = element.closest('table, pre, code, img, picture, mjx-container, .math, math, [data-sm-readonly]')
    if (!runElement && !blockElement && !structural) {
      // 余白のクリックは編集終了だけ
      this.endEditing()
      return
    }

    const code = run?.reason?.code ?? block?.reason?.code ?? reasonForElement(element)
    this.endEditing()
    this.options.onNotice(code)
  }

  /**
   * click がドラッグ・ダブルクリックによる選択の終わりかどうか。
   * 選択がこの編集面の中で新しく作られた場合に、選択を保つ。
   */
  private clickEndsSelection(element: Element, event: MouseEvent, previousSelection: Range | null | undefined): boolean {
    const selection = selectionFor(this.root)
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return false
    const range = selection.getRangeAt(0)
    // A click can leave an old selection visible (especially across editing hosts).
    // Only a newly-created range or a multi-click should bypass normal caret placement.
    if (event.detail < 2 && previousSelection &&
        range.startContainer === previousSelection.startContainer && range.startOffset === previousSelection.startOffset &&
        range.endContainer === previousSelection.endContainer && range.endOffset === previousSelection.endOffset) return false
    const inside = (node: Node | null): boolean =>
      !!node && (node === this.root || this.root.contains(node))
    if (!inside(range.startContainer) || !inside(range.endContainer)) return false
    if (previousSelection === undefined && event.detail < 2) {
      const block = element.closest('[data-sm-block]')
      if (!block || !range.intersectsNode(block)) return false
    }
    return true
  }

  private readonly onKeyDown = (raw: Event): void => {
    const event = raw as KeyboardEvent
    if (event.isComposing || event.keyCode === 229) return
    const wasComposing = this.hasPendingComposition()
    if (event.key === 'Enter' && performance.now() <= this.suppressEnterUntil) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    this.settleComposition()
    this.cancelAbandonedDraft()
    if (!this.editing) return
    // 未入力の空行（段落・softbreak）の先頭での Backspace は、改行の仮編集を取り消す。
    if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey && this.cancelDraftAtLineStart()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      event.stopPropagation()
      if (wasComposing) return
      this.insertNewline(event.shiftKey ? 'line' : 'paragraph')
      return
    }
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    const selection = selectionFor(this.root)
    if (!selection || selection.rangeCount !== 1) return
    const range = selection.getRangeAt(0)
    const runElement = runElementOf(range.startContainer)
    if (!runElement || !this.root.contains(runElement)) return
    const point = selectionInRun(this.root, runElement)
    if (!point || !point.collapsed) return
    const run = this.analysis.runs.find((entry) => entry.id === point.runId)
    if (!run?.editable) return

    const direction = event.key === 'Backspace' ? 'backward' : 'forward'
    const plan = planBoundaryDeletion(this.analysis, run, point.offset, direction)
    if (plan.kind === 'none') return
    event.preventDefault()
    event.stopPropagation()
    if (plan.kind === 'reject') {
      this.options.onNotice('cross-run')
      return
    }

    const neighborElement = this.runElement(plan.run.id)
    const [leftElement, rightElement] =
      direction === 'backward' ? [neighborElement, runElement] : [runElement, neighborElement]
    if (!leftElement || !rightElement || !areRunsDomAdjacent(leftElement, rightElement)) {
      this.options.onNotice('cross-run')
      return
    }

    const result = this.engine.applyRunEdit(this.analysis.text, plan.run.id, plan.text)
    if (!result.ok) {
      this.options.onNotice(result.reason.code)
      return
    }
    const before: Cursor = { runId: run.id, offset: point.offset }
    this.analysis = result.analysis
    this.endEditingSilently()
    this.options.onCrossRun(result, { runId: plan.run.id, offset: plan.offset }, before)
  }

  private readonly onBeforeInputCapture = (event: Event): void => {
    if (!this.editing) return
    if (!(event instanceof InputEvent && event.isComposing) && this.cancelAbandonedDraft() && event instanceof InputEvent) {
      // The event's original target was removed by rollback. Replay text into the
      // restored selection rather than letting a native edit mutate detached DOM.
      event.preventDefault()
      event.stopImmediatePropagation()
      this.pendingBefore = this.currentCursor(false)
      if (event.inputType === 'insertText' && event.data !== null) this.adapter?.insertText(event.data)
      else if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') this.insertNewline(event.inputType === 'insertLineBreak' ? 'line' : 'paragraph')
      else this.options.onNotice('unsupported-input')
      return
    }
    if (event instanceof InputEvent && ['insertParagraph', 'insertLineBreak'].includes(event.inputType)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (event.isComposing) return
      if (this.hasPendingComposition()) { this.settleComposition(); return }
      if (performance.now() <= this.suppressEnterUntil) return
      this.insertNewline(event.inputType === 'insertLineBreak' ? 'line' : 'paragraph')
      return
    }
    // IME変換中は最初の beforeinput の位置を履歴の起点にする
    if (this.pendingBefore && event instanceof InputEvent && event.isComposing) return
    if (!this.pendingBefore) this.pendingBefore = this.currentCursor(false)
  }

  private readonly onSelectionChange = (): void => { this.cancelAbandonedDraft() }

  /** Roll back an unfilled line after navigation, retaining the actual selection. */
  private cancelAbandonedDraft(): boolean {
    const draft = this.analysis.draft
    if (!draft || !this.editing || !this.adapter || this.recoveringDraftSelection || this.hasPendingComposition()) return false
    const selection = selectionFor(this.root)
    if (!selection?.rangeCount) return false
    const capture = (node: Node | null, offset: number): Cursor | undefined => {
      const element = runElementOf(node)
      if (!element || !this.root.contains(element)) return
      const position = offsetInRun(element, node, offset)
      if (position !== null) return { runId: element.dataset.smRun!, offset: position }
    }
    const anchor = capture(selection.anchorNode, selection.anchorOffset)
    const focus = capture(selection.focusNode, selection.focusOffset)
    if (anchor?.runId === draft.runId && focus?.runId === draft.runId) return false
    const oldRuns = this.analysis.runs
    this.recoveringDraftSelection = true
    try {
      this.endEditing()
      const restore = (cursor: Cursor | undefined): Cursor | undefined => {
        if (!cursor) return
        if (cursor.runId === draft.runId) return resolveCursor(this.analysis, draft.before)
        const start = oldRuns.find(run => run.id === cursor.runId)?.segments[0]?.start
        if (start === undefined) return
        const source = start >= draft.edit.start + draft.edit.insert.length ? start - draft.edit.insert.length : start
        const run = this.analysis.runs.find(run => run.editable && run.segments[0]?.start === source)
        return run ? { runId: run.id, offset: cursor.offset } : undefined
      }
      const nextAnchor = restore(anchor), nextFocus = restore(focus)
      if (nextAnchor && nextFocus) {
        this.focusRun(nextAnchor)
        const anchorElement = this.runElement(nextAnchor.runId), focusElement = this.runElement(nextFocus.runId)
        const a = anchorElement && pointInRun(anchorElement, nextAnchor.offset), f = focusElement && pointInRun(focusElement, nextFocus.offset)
        if (a && f) selection.setBaseAndExtent(a.node, a.offset, f.node, f.offset)
      }
    } finally { this.recoveringDraftSelection = false }
    return true
  }

  /**
   * 未入力の空行の先頭で Backspace を押したら、改行の仮編集だけを取り消す。
   * 段落・softbreak のどちらも、改行を消して元のキャレットへ戻す。
   */
  private cancelDraftAtLineStart(): boolean {
    const draft = this.analysis.draft
    if (!draft || !this.adapter) return false
    const selection = selectionFor(this.root)
    if (!selection || selection.rangeCount !== 1 || !selection.isCollapsed) return false
    const range = selection.getRangeAt(0)
    const runElement = runElementOf(range.startContainer)
    const block = this.runElement(draft.runId)?.closest<HTMLElement>('[data-sm-block]') ?? null
    const atStart = runElement
      ? runElement.dataset.smRun === draft.runId && offsetInRun(runElement, range.startContainer, range.startOffset) === 0
      : !!block && range.startContainer === block && range.startOffset === 0
    if (!atStart) return false
    const result = this.engine.cancelDraft(this.analysis.text)
    if (!result.ok) { this.options.onNotice(result.reason.code); return true }
    this.analysis = result.analysis
    this.endEditingSilently()
    this.options.onCrossRun(result, result.cursor)
    return true
  }

  private insertNewline(kind: 'line' | 'paragraph'): void {
    const selection = selectionFor(this.root)
    const before = this.currentCursor(false)
    if (!selection?.isCollapsed || !before) {
      this.options.onNotice('cross-run')
      return
    }
    const result = this.engine.applyNewline(this.analysis.text, before.runId, before.offset, kind)
    if (!result.ok) { this.options.onNotice(result.reason.code); return }
    this.analysis = result.analysis
    this.endEditingSilently()
    this.options.onCrossRun(result, result.cursor, before)
  }

  constructor(
    private readonly surface: SlideSurface,
    private readonly engine: EditingEngine,
    private readonly options: StageEditorOptions,
  ) {
    const latest = options.latest()
    this.analysis = latest.analysis
    this.deck = latest.deck
    const root = this.root
    root.addEventListener('pointerdown', this.onPointerDown)
    root.addEventListener('click', this.onClick)
    root.addEventListener('keydown', this.onKeyDown, true)
    root.addEventListener('beforeinput', this.onBeforeInputCapture, true)
    root.addEventListener('paste', this.onBeforeInputCapture, true)
    root.addEventListener('compositionstart', this.onCompositionStart, true)
    root.addEventListener('compositionend', this.onCompositionEnd, true)
    root.addEventListener('blur', this.onBlur, true)
    root.ownerDocument.addEventListener('selectionchange', this.onSelectionChange)
  }

  get root(): ShadowRoot {
    return this.surface.root
  }

  /** デッキを反映し、編集アダプタを作り直す。`focus` があればその位置へカーソルを戻す */
  render(deck: RenderedDeck, analysis: Analysis, current: number, focus?: StageFocus): void {
    this.endEditingSilently()
    this.analysis = analysis
    this.deck = deck
    this.current = current
    this.surface.update(deck, current)
    this.bindEditingSession(analysis)
    this.decorate(this.analysis)
    if (focus && focus.seq !== this.lastFocusSeq) {
      this.lastFocusSeq = focus.seq
      this.focusRun(focus.cursor)
    }
  }

  /** 編集中なら残ったDOMをコミットして終了する（再描画は onFinish 経由）。 */
  endEditing(): void {
    this.settleComposition()
    this.adapter?.finish()
  }

  /** IME変換中か */
  isComposing(): boolean {
    return this.composition.isComposing
  }

  /** 変換中なら操作を予約して true。確定とコミットの後にまとめて実行する */
  deferWhileComposing(action: () => void): boolean {
    return this.composition.defer(action)
  }

  dispose(): void {
    const root = this.root
    root.removeEventListener('pointerdown', this.onPointerDown)
    root.removeEventListener('click', this.onClick)
    root.removeEventListener('keydown', this.onKeyDown, true)
    root.removeEventListener('beforeinput', this.onBeforeInputCapture, true)
    root.removeEventListener('paste', this.onBeforeInputCapture, true)
    root.removeEventListener('compositionstart', this.onCompositionStart, true)
    root.removeEventListener('compositionend', this.onCompositionEnd, true)
    root.removeEventListener('blur', this.onBlur, true)
    root.ownerDocument.removeEventListener('selectionchange', this.onSelectionChange)
    this.endEditingSilently()
  }

  private bindEditingSession(analysis: Analysis): void {
    this.adapter = bindEditing(this.root as unknown as HTMLElement, this.engine, {
      analysis,
      onCompositionSettled: this.suppressConfirmationEnter,
      onCommit: (result) => {
        this.analysis = result.analysis
        const before = this.pendingBefore
        this.pendingBefore = undefined
        this.options.onCommit(result, { before, after: this.currentCursor(true) })
      },
      onReject: (why) => {
        this.pendingBefore = undefined
        this.options.onNotice(why.code)
      },
      onHistory: (direction) => {
        this.pendingBefore = undefined
        if (this.analysis.draft) {
          if (direction === 'redo') { this.endEditing(); this.options.onHistory(direction); return }
          const result = this.engine.cancelDraft(this.analysis.text)
          if (!result.ok) { this.options.onNotice(result.reason.code); return }
          this.analysis = result.analysis
          this.endEditingSilently()
          this.options.onCrossRun(result, result.cursor)
          return
        }
        this.options.onHistory(direction)
      },
      onFinish: () => this.handleFinish(),
    })
    // bindEditing が先に登録した bubble listener の後に実行し、
    // commit または commit 不要の判定が済んだ compositionend を受け取る。
    this.root.addEventListener('compositionend', this.onCompositionEndSettled)
  }

  /** 編集終了: 最新の解析結果でスライドだけを差し替え、サムネイル更新を依頼する */
  private handleFinish(): void {
    if (this.suppressFinish) return
    const cancelled = !!this.analysis.draft
    if (this.analysis.draft) {
      const result = this.engine.cancelDraft(this.analysis.text)
      if (!result.ok) { this.options.onNotice(result.reason.code); return }
      this.analysis = result.analysis
      this.options.onCommit(result, {})
    }
    const latest = this.options.latest()
    this.analysis = latest.analysis
    this.deck = latest.deck
    this.surface.update(this.deck, this.current)
    if (cancelled) {
      this.endEditingSilently()
      this.bindEditingSession(this.analysis)
    }
    this.decorate(this.analysis)
    this.editing = false
    this.pendingBefore = undefined
    this.options.onEnd()
  }

  private endEditingSilently(): void {
    this.root.removeEventListener('compositionend', this.onCompositionEndSettled)
    if (!this.adapter) {
      this.editing = false
      return
    }
    this.suppressFinish = true
    try {
      this.adapter.dispose()
    } finally {
      this.suppressFinish = false
      this.adapter = null
      this.editing = false
      this.pendingBefore = undefined
    }
  }

  private runElement(runId: string): HTMLElement | null {
    return this.root.querySelector<HTMLElement>(`[data-sm-run="${runId}"]`)
  }

  private focusRun(cursor: Cursor): void {
    const run = this.analysis.runs.find((entry) => entry.id === cursor.runId)
    if (!run?.editable) return
    const element = this.runElement(run.id)
    if (!element || !this.adapter?.begin(element)) return
    this.editing = true
    const fresh = this.runElement(run.id)
    if (!fresh) return
    const block = fresh.closest<HTMLElement>('[data-sm-block]')
    block?.focus({ preventScroll: true })
    setCaretInRun(fresh, cursor.offset)
    this.options.onBegin(labelForBlock(block))
  }

  private currentCursor(end: boolean): Cursor | undefined {
    const selection = selectionFor(this.root)
    if (!selection || selection.rangeCount !== 1) return
    const range = selection.getRangeAt(0)
    const runElement = runElementOf(end ? range.endContainer : range.startContainer)
    if (!runElement || !this.root.contains(runElement)) return
    const offset = offsetInRun(runElement, end ? range.endContainer : range.startContainer, end ? range.endOffset : range.startOffset)
    if (offset === null) return
    return { runId: runElement.dataset.smRun ?? '', offset }
  }

  /** 読み取り専用のラン・ブロックに印を付ける（ホバーの点線と理由表示に使う） */
  private decorate(analysis: Analysis): void {
    for (const run of analysis.runs) {
      const element = this.runElement(run.id)
      if (!element) continue
      if (run.editable) element.removeAttribute('data-sm-readonly')
      else element.setAttribute('data-sm-readonly', run.reason?.code ?? 'ambiguous-source')
    }
    for (const block of analysis.blocks) {
      const element = this.root.querySelector<HTMLElement>(`[data-sm-block="${block.id}"]`)
      if (!element) continue
      if (block.editable) element.removeAttribute('data-sm-readonly')
      else element.setAttribute('data-sm-readonly', block.reason?.code ?? 'ambiguous-source')
    }
  }
}
