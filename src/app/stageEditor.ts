/**
 * 表示中のスライド（Shadow DOM）と編集エンジンをつなぐ。
 * クリック位置のキャレット、読み取り専用の理由、ランの境界での削除、
 * 編集終了時のスライド単位の再描画を持つ。
 */
import type { Cursor } from '../document'
import { type Analysis, type EditingEngine, type EditResult, type ReadonlyCode } from '../editing'
import { bindEditing } from '../editing/dom'
import type { RenderedDeck } from '../marp/renderer'
import type { SlideSurface } from '../marp/surface'
import {
  caretInRun,
  offsetInRun,
  runElementOf,
  selectionInRun,
  setCaretInRun,
} from './caret'
import { planBoundaryDeletion } from './runDeletion'
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

  private readonly onClick = (raw: Event): void => {
    const event = raw as MouseEvent
    if (event.button !== 0) return
    const target = event.composedPath()[0]
    const element = target instanceof Element ? target : null
    if (!element || !this.root.contains(element)) return

    const runElement = element.closest<HTMLElement>('[data-sm-run]')
    const run = runElement
      ? this.analysis.runs.find((entry) => entry.id === runElement.dataset.smRun)
      : undefined

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
      if (!existing || existing.collapsed) {
        const point = caretInRun(fresh, event.clientX, event.clientY, this.root)
        if (point) {
          this.root.ownerDocument
            .getSelection()
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

  private readonly onKeyDown = (raw: Event): void => {
    const event = raw as KeyboardEvent
    if (event.isComposing || !this.editing) return
    if (event.key !== 'Backspace' && event.key !== 'Delete') return
    const selection = this.root.ownerDocument.getSelection()
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
    // IME変換中は最初の beforeinput の位置を履歴の起点にする
    if (this.pendingBefore && event instanceof InputEvent && event.isComposing) return
    if (!this.pendingBefore) this.pendingBefore = this.currentCursor(false)
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
    root.addEventListener('click', this.onClick)
    root.addEventListener('keydown', this.onKeyDown, true)
    root.addEventListener('beforeinput', this.onBeforeInputCapture, true)
    root.addEventListener('paste', this.onBeforeInputCapture, true)
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

  /** 編集中なら終了する（再描画は onFinish 経由） */
  endEditing(): void {
    this.adapter?.finish()
  }

  dispose(): void {
    const root = this.root
    root.removeEventListener('click', this.onClick)
    root.removeEventListener('keydown', this.onKeyDown, true)
    root.removeEventListener('beforeinput', this.onBeforeInputCapture, true)
    root.removeEventListener('paste', this.onBeforeInputCapture, true)
    this.endEditingSilently()
  }

  private bindEditingSession(analysis: Analysis): void {
    this.adapter = bindEditing(this.root as unknown as HTMLElement, this.engine, {
      analysis,
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
        this.options.onHistory(direction)
      },
      onFinish: () => this.handleFinish(),
    })
  }

  /** 編集終了: 最新の解析結果でスライドだけを差し替え、サムネイル更新を依頼する */
  private handleFinish(): void {
    if (this.suppressFinish) return
    const latest = this.options.latest()
    this.analysis = latest.analysis
    this.deck = latest.deck
    this.surface.update(this.deck, this.current)
    this.decorate(this.analysis)
    this.editing = false
    this.pendingBefore = undefined
    this.options.onEnd()
  }

  private endEditingSilently(): void {
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
    const selection = this.root.ownerDocument.getSelection()
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
