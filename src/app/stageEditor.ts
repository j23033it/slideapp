/**
 * 表示中のスライド（Shadow DOM）と編集エンジンをつなぐ。
 * クリック位置のキャレット、読み取り専用の理由、ランの境界での削除、
 * 編集終了時のスライド単位の再描画を持つ。
 */
import type { Cursor, SourceEdit } from '../document'
import { resolveCursor, type Analysis, type EditingEngine, type EditResult, type ElementKind, type ReadonlyCode } from '../editing'
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
import { limitBoxPosition, selectionOutlineWidth, toSlideRect } from './elementGeometry'
import { beginHandleDrag } from './handleDrag'
import type { BoxGeometry } from '../editing/boxPosition'

export type EditSuccess = Extract<EditResult<SourceEdit | readonly SourceEdit[]>, { ok: true }>

export interface EditingCursors {
  before?: Cursor
  after?: Cursor
}

export interface StageFocus {
  seq: number
  cursor: Cursor
  selectionEnd?: Cursor
}

export interface StageEditorOptions {
  /** 直近に採用された解析結果とデッキ（編集終了時の再描画に使う） */
  latest(): { analysis: Analysis; deck: RenderedDeck }
  onBegin(label: string, elementId?: string): void
  onEnd(): void
  onNotice(code: ReadonlyCode): void
  onCommit(result: EditSuccess, cursors: EditingCursors): void
  onCrossRun(result: EditSuccess, target: Cursor, before?: Cursor, selectionEnd?: Cursor): void
  onElementBold?(result: EditSuccess, elementId: string): void
  canBold?(): boolean
  onBoldState?(active: boolean): void
  onHistory(direction: 'undo' | 'redo'): void
  onElementDelete?(id: string): boolean
  onElementSelect?(kind: ElementKind | null, id?: string): void
  onImageResize?(id: string, width: number, slideWidth: number): void
  onBoxPlace?(id: string, geometry: BoxGeometry): void
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
  private compositionEndTimer: ReturnType<typeof setTimeout> | null = null
  private suppressEnterUntil = 0
  private recoveringDraftSelection = false
  private pointerSelection: Range | null | undefined
  private selectedElement: string | null = null
  private pendingElementSelection: string | null = null
  private selectedStyle?: { element: HTMLElement; outline: string; outlinePriority: string; offset: string; offsetPriority: string; tabindex: string | null }
  private imageHandles?: HTMLDivElement
  private cancelHandleDrag?: () => void
  private resizeObserver?: ResizeObserver
  private readonly onResize = (): void => {
    const element = this.root.querySelector<HTMLElement>('[data-sm-selected]')
    if (!element) return
    const width = selectionOutlineWidth(element)
    element.style.outlineWidth = `${width}px`
    element.style.outlineOffset = `${width}px`
    this.positionImageHandles(element)
  }

  private positionImageHandles(element: HTMLElement): void {
    const frame = element.closest<HTMLElement>('.frame'), handles = this.imageHandles
    if (!frame || !handles) return
    const rect = toSlideRect(element.getBoundingClientRect(), frame.getBoundingClientRect(), frame.offsetWidth, frame.offsetHeight)
    if (!rect) return
    Object.assign(handles.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    for (const handle of handles.children) {
      const size = 8 / rect.scaleX
      Object.assign((handle as HTMLElement).style, { width: `${size}px`, height: `${size}px`, borderWidth: `${1 / rect.scaleX}px` })
    }
  }

  private clearElementSelection(notify = true): void {
    this.cancelHandleDrag?.()
    this.cancelHandleDrag = undefined
    const hadSelection = !!this.selectedElement
    const saved = this.selectedStyle
    const element = saved?.element
    if (element && saved) {
      element.removeAttribute('data-sm-selected')
      if (saved.outline) element.style.setProperty('outline', saved.outline, saved.outlinePriority)
      else element.style.removeProperty('outline')
      if (saved.offset) element.style.setProperty('outline-offset', saved.offset, saved.offsetPriority)
      else element.style.removeProperty('outline-offset')
      if (saved.tabindex === null) element.removeAttribute('tabindex')
      else element.setAttribute('tabindex', saved.tabindex)
    }
    this.selectedStyle = undefined
    this.imageHandles?.remove()
    this.imageHandles = undefined
    this.selectedElement = null
    if (notify && hadSelection) { this.options.onElementSelect?.(null); this.options.onBoldState?.(false) }
  }

  private selectElement(id: string, notify = true): void {
    this.clearElementSelection(false)
    const source = this.analysis.elementSources?.elements.find(entry => entry.id === id && entry.slide === this.current)
    const container = this.root.querySelector<HTMLElement>(`[data-sm-element="${id}"]`)
    const element = source?.kind === 'image' ? container?.querySelector<HTMLElement>('img') : container
    if (!element || !source) return
    this.selectedElement = id
    this.selectedStyle = { element, outline: element.style.getPropertyValue('outline'), outlinePriority: element.style.getPropertyPriority('outline'),
      offset: element.style.getPropertyValue('outline-offset'), offsetPriority: element.style.getPropertyPriority('outline-offset'), tabindex: element.getAttribute('tabindex') }
    element.dataset.smSelected = ''
    // The frame is scaled to fit. Keep the outline two screen pixels wide.
    const width = selectionOutlineWidth(element)
    element.style.outline = `${width}px solid var(--sm-accent, #0f6cbd)`
    element.style.outlineOffset = `${width}px`
    element.tabIndex = -1
    element.focus({ preventScroll: true })
    if (source.kind === 'image') {
      const frame = element.closest<HTMLElement>('.frame')
      if (frame) {
        const handles = document.createElement('div')
        handles.setAttribute('aria-hidden', 'true')
        Object.assign(handles.style, { position: 'absolute', pointerEvents: 'none' })
        for (const [x, y] of [['0', '0'], ['100%', '0'], ['0', '100%'], ['100%', '100%']]) {
          const handle = document.createElement('span')
          Object.assign(handle.style, { position: 'absolute', left: x, top: y, transform: 'translate(-50%, -50%)', boxSizing: 'border-box', background: 'white', borderStyle: 'solid', borderColor: 'var(--sm-accent, #0f6cbd)' })
          if (this.options.onImageResize) {
            handle.style.pointerEvents = 'auto'
            handle.style.cursor = x === y ? 'nwse-resize' : 'nesw-resize'
            handle.addEventListener('pointerdown', event => {
              if (event.button !== 0) return
              const rect = toSlideRect(element.getBoundingClientRect(), frame.getBoundingClientRect(), frame.offsetWidth, frame.offsetHeight)
              if (!rect || rect.width <= 0 || rect.height <= 0 || this.deck.width < 16) return
              event.preventDefault(); event.stopPropagation()
              const widthStyle = element.style.getPropertyValue('width'), widthPriority = element.style.getPropertyPriority('width')
              const heightStyle = element.style.getPropertyValue('height'), heightPriority = element.style.getPropertyPriority('height')
              const restore = () => {
                if (widthStyle) element.style.setProperty('width', widthStyle, widthPriority); else element.style.removeProperty('width')
                if (heightStyle) element.style.setProperty('height', heightStyle, heightPriority); else element.style.removeProperty('height')
                this.positionImageHandles(element)
                this.cancelHandleDrag = undefined
              }
              const ratio = rect.height / rect.width, signX = x === '0' ? -1 : 1, signY = y === '0' ? -1 : 1
              let width = rect.width
              this.cancelHandleDrag = beginHandleDrag(event, frame, {
                move: (dx, dy) => {
                  width = Math.max(16, Math.min(this.deck.width, rect.width + (dx * signX + dy * signY * ratio) / (1 + ratio * ratio)))
                  element.style.setProperty('width', `${width}px`, 'important')
                  element.style.setProperty('height', `${width * ratio}px`, 'important')
                  this.positionImageHandles(element)
                },
                finish: () => { restore(); if (Math.round(width) !== Math.round(rect.width)) this.options.onImageResize?.(id, width, this.deck.width) },
                cancel: restore,
              })
            })
          }
          handles.append(handle)
        }
        frame.append(handles)
        this.imageHandles = handles
        this.positionImageHandles(element)
      }
    }
    if (source.kind === 'box') {
      const frame = element.closest<HTMLElement>('.frame')
      if (frame) {
        const handles = document.createElement('div')
        handles.setAttribute('aria-hidden', 'true')
        Object.assign(handles.style, { position: 'absolute', pointerEvents: 'none' })
        for (const side of ['left', 'right'] as const) {
          const handle = document.createElement('span')
          handle.dataset.smBoxHandle = side
          Object.assign(handle.style, { position: 'absolute', left: side === 'left' ? '0' : '100%', top: '50%', transform: 'translate(-50%, -50%)', boxSizing: 'border-box', background: 'white', borderStyle: 'solid', borderColor: 'var(--sm-accent, #0f6cbd)', pointerEvents: 'auto', cursor: 'ew-resize' })
          handle.addEventListener('pointerdown', event => {
            if (event.button !== 0 || this.hasPendingComposition()) return
            event.preventDefault(); event.stopPropagation()
            this.beginBoxGesture(event, element, id, side)
          })
          handles.append(handle)
        }
        frame.append(handles)
        this.imageHandles = handles
        this.positionImageHandles(element)
      }
    }
    this.options.onBoldState?.(this.engine.isElementBold(id))
    if (notify) this.options.onElementSelect?.(source.kind, id)
  }

  private limitPosition(geometry: BoxGeometry, height: number): BoxGeometry {
    return limitBoxPosition(geometry, height, this.deck.width, this.deck.height)
  }

  private beginBoxGesture(event: PointerEvent, element: HTMLElement, id: string, mode: 'move' | 'left' | 'right', clickThrough = false): void {
    const frame = element.closest<HTMLElement>('.frame')
    const source = this.analysis.elementSources?.elements.find(entry => entry.id === id && entry.slide === this.current)
    if (!frame || !source || !this.options.onBoxPlace) return
    const rect = toSlideRect(element.getBoundingClientRect(), frame.getBoundingClientRect(), frame.offsetWidth, frame.offsetHeight)
    if (!rect) return
    const original = source.boxStyle ? { left: source.boxStyle.left, top: source.boxStyle.top, width: source.boxStyle.width } :
      { left: Math.round(rect.x), top: Math.round(rect.y), width: Math.max(40, Math.round(rect.width)) }
    const saved = element.getAttribute('style')
    let geometry = original, moved = false
    const restore = () => {
      if (saved === null) element.removeAttribute('style'); else element.setAttribute('style', saved)
      this.positionImageHandles(element)
      this.cancelHandleDrag = undefined
    }
    this.cancelHandleDrag = beginHandleDrag(event, frame, {
      move: (dx, dy) => {
        if (!moved && Math.hypot(dx * rect.scaleX, dy * rect.scaleY) < 4) return
        moved = true
        if (mode === 'move') geometry = this.limitPosition({ ...original, left: original.left + dx, top: original.top + dy }, rect.height)
        else if (mode === 'right') geometry = this.limitPosition({ ...original, width: Math.max(40, original.width + dx) }, rect.height)
        else {
          const width = Math.max(40, original.width - dx)
          geometry = this.limitPosition({ ...original, left: original.left + original.width - width, width }, rect.height)
        }
        if (source.kind === 'box') {
          element.style.setProperty('width', `${geometry.width}px`, 'important')
          const resizedHeight = element.getBoundingClientRect().height / rect.scaleY
          geometry = this.limitPosition(geometry, resizedHeight)
          element.style.setProperty('left', `${geometry.left}px`, 'important')
          element.style.setProperty('top', `${geometry.top}px`, 'important')
        } else element.style.transform = `translate(${geometry.left - original.left}px, ${geometry.top - original.top}px)`
        this.positionImageHandles(element)
      },
      finish: () => { restore(); if (moved) this.options.onBoxPlace?.(id, geometry) },
      cancel: restore,
      clickThrough: () => clickThrough && !moved,
    })
  }

  private readonly onPointerDown = (raw: Event): void => {
    const event = raw as PointerEvent
    const selection = selectionFor(this.root)
    this.pointerSelection = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null
    if (event.button !== 0 || this.hasPendingComposition()) return
    const target = event.composedPath()[0]
    if (!(target instanceof Element)) return
    const selected = this.selectedElement && this.selectedStyle?.element
    if (!this.editing && selected && (selected === target || selected.contains(target))) {
      this.beginBoxGesture(event, selected, this.selectedElement!, 'move', true)
      return
    }
    // Hit-test both sides of the six-screen-pixel border, including outside the element.
    const boxes = [...this.root.querySelectorAll<HTMLElement>('[data-box][data-sm-element]')].reverse()
    const box = boxes.find(item => {
      const r = item.getBoundingClientRect(), x = event.clientX, y = event.clientY
      return x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 6 && y <= r.bottom + 6 &&
        (Math.abs(x - r.left) <= 6 || Math.abs(x - r.right) <= 6 || Math.abs(y - r.top) <= 6 || Math.abs(y - r.bottom) <= 6)
    })
    const id = box?.dataset.smElement
    if (!box || !id) return
    if (this.editing) this.endEditing()
    this.selectElement(id)
    const fresh = this.selectedStyle?.element
    if (!fresh) return
    event.preventDefault(); event.stopPropagation()
    this.beginBoxGesture(event, fresh, id, 'move')
  }

  private readonly suppressConfirmationEnter = (): void => {
    this.suppressEnterUntil = performance.now() + 100
  }

  private hasPendingComposition(): boolean {
    return this.composition.isComposing || (this.adapter?.hasPendingComposition() ?? false)
  }

  private readonly onCompositionStart = (): void => {
    this.clearCompositionEndTimer()
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
    if (token === null) return
    this.clearCompositionEndTimer()
    // Native dispatch can checkpoint microtasks between compositionend and the
    // final input. Keep the save gate closed until the next task, even if no
    // final input is sent. A new composition invalidates this completion.
    this.compositionEndTimer = setTimeout(() => {
      this.compositionEndTimer = null
      if (token !== this.composition.markEnded()) return
      this.adapter?.settleComposition()
      this.composition.flush(token)
    }, 0)
  }

  private clearCompositionEndTimer(): void {
    if (this.compositionEndTimer === null) return
    clearTimeout(this.compositionEndTimer)
    this.compositionEndTimer = null
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
    // A save shortcut or blur during compositionend settlement must not bypass
    // the task boundary reserved for the final input.
    if (this.compositionEndTimer === null) this.composition.flush(token)
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

    const candidate = element.closest<HTMLElement>('[data-sm-element]')
    const sourceElement = this.analysis.elementSources?.elements.find(entry => entry.id === candidate?.dataset.smElement)
    this.clearElementSelection()
    if (sourceElement?.kind === 'image' && element.closest('img')) {
      this.endEditing()
      this.selectElement(sourceElement.id)
      return
    }

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
      this.options.onBegin(labelForBlock(block), fresh.closest<HTMLElement>('[data-sm-element]')?.dataset.smElement)
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
    if (sourceElement && (!element.closest('img') || sourceElement.kind === 'image')) this.selectElement(sourceElement.id)
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
    if (event.composedPath().some(node => node instanceof Element && node.hasAttribute('data-sm-table-menu'))) return
    if ((this.editing || this.selectedElement) && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'b') {
      event.preventDefault(); event.stopPropagation()
      if (!event.isComposing && event.keyCode !== 229 && !this.hasPendingComposition()) this.toggleBold()
      return
    }
    if (event.key === 'Tab' && this.editing) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      event.preventDefault()
      event.stopPropagation()
      if (event.isComposing || event.keyCode === 229 || this.hasPendingComposition()) return
      this.settleComposition()
      this.changeListIndent(event.shiftKey ? 'outdent' : 'indent')
      return
    }
    if (event.isComposing || event.keyCode === 229) return
    const wasComposing = this.hasPendingComposition()
    if (event.key === 'Enter' && performance.now() <= this.suppressEnterUntil) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    this.settleComposition()
    this.cancelAbandonedDraft()
    if (event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (this.editing) {
        const selected = runElementOf(selectionFor(this.root)?.focusNode ?? null)?.closest<HTMLElement>('[data-sm-element]')?.dataset.smElement
        event.preventDefault(); event.stopPropagation()
        this.endEditing()
        if (selected) this.selectElement(selected)
      } else if (this.selectedElement) {
        event.preventDefault(); event.stopPropagation(); this.clearElementSelection()
      }
      return
    }
    if (!this.editing && this.selectedElement && !event.ctrlKey && !event.metaKey && !event.altKey &&
        ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      const source = this.analysis.elementSources?.elements.find(entry => entry.id === this.selectedElement && entry.kind === 'box')
      const element = this.selectedStyle?.element, frame = element?.closest<HTMLElement>('.frame')
      if (source?.boxStyle && element && frame) {
        event.preventDefault(); event.stopPropagation()
        if (wasComposing) return
        const rect = toSlideRect(element.getBoundingClientRect(), frame.getBoundingClientRect(), frame.offsetWidth, frame.offsetHeight)
        if (!rect) return
        const step = event.shiftKey ? 1 : 10, style = source.boxStyle
        const geometry = this.limitPosition({ left: style.left + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
          top: style.top + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0), width: style.width }, rect.height)
        this.options.onBoxPlace?.(source.id, geometry)
        return
      }
    }
    if (!this.editing && this.selectedElement && (event.key === 'Delete' || event.key === 'Backspace') && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation()
      if (this.options.onElementDelete?.(this.selectedElement)) this.clearElementSelection()
      return
    }
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
    const atBoundary = direction === 'backward' ? point.offset === 0 : point.offset === run.text.length
    if (atBoundary && this.analysis.blocks.find(block => block.id === run.blockId)?.tableCell) {
      const result = this.engine.applyTableBreakDeletion(this.analysis.text, run.id, direction)
      event.preventDefault()
      event.stopPropagation()
      if (!result.ok) { this.options.onNotice(result.reason.code); return }
      const before: Cursor = { runId: run.id, offset: point.offset }
      this.analysis = result.analysis
      this.endEditingSilently()
      this.options.onCrossRun(result, result.cursor, before)
      return
    }
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

  private readonly onSelectionChange = (): void => {
    this.cancelAbandonedDraft()
    const selection = selectionFor(this.root)
    const run = runElementOf(selection?.focusNode ?? null)
    this.options.onBoldState?.(this.selectedElement ? this.engine.isElementBold(this.selectedElement) : !!run && this.root.contains(run) && this.engine.isBold(run.dataset.smRun ?? ''))
  }

  toggleBold(): void {
    if (this.hasPendingComposition()) return
    if (!this.options.canBold?.()) { this.options.onNotice('element-readonly'); return }
    if (this.selectedElement) {
      if (!this.options.onElementBold) return
      const result = this.engine.applyElementBold(this.analysis.text, this.selectedElement)
      if (!result.ok) { this.options.onNotice(result.reason.code); return }
      this.pendingElementSelection = result.elementId
      this.options.onElementBold(result, result.elementId)
      return
    }
    const before = this.currentCursor(false), end = this.currentCursor(true)
    if (!before || !end) { this.options.onNotice('bold-multiple-runs'); return }
    const result = this.engine.applyBold(this.analysis.text, before, end)
    if (!result.ok) { this.options.onNotice(result.reason.code); return }
    this.analysis = result.analysis
    this.endEditingSilently()
    this.options.onCrossRun(result, result.cursor, before, result.selectionEnd)
  }

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

  private changeListIndent(direction: 'indent' | 'outdent'): void {
    const before = this.currentCursor(false), end = this.currentCursor(true)
    if (!before || !end) { this.options.onNotice('list-indent-target'); return }
    const result = this.engine.applyListIndent(this.analysis.text, before.runId, before.offset, direction, end.runId)
    if (!result.ok) { this.options.onNotice(result.reason.code); return }
    this.analysis = result.analysis
    this.endEditingSilently()
    this.options.onCrossRun(result, result.cursor, before)
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
    root.ownerDocument.defaultView?.addEventListener('resize', this.onResize)
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.onResize)
      this.resizeObserver.observe(root.host)
    }
  }

  get root(): ShadowRoot {
    return this.surface.root
  }

  /** デッキを反映し、編集アダプタを作り直す。`focus` があればその位置へカーソルを戻す */
  render(deck: RenderedDeck, analysis: Analysis, current: number, focus?: StageFocus): void {
    const hadSelection = !!this.selectedElement
    const selected = current === this.current && analysis === this.analysis ? this.selectedElement : null
    this.clearElementSelection(false)
    this.endEditingSilently()
    this.analysis = analysis
    this.deck = deck
    this.current = current
    this.surface.update(deck, current)
    this.bindEditingSession(analysis)
    this.decorate(this.analysis)
    this.selectedElement = null
    if (this.pendingElementSelection) {
      const pending = this.pendingElementSelection
      this.pendingElementSelection = null
      this.selectElement(pending)
    } else if (selected) this.selectElement(selected, false)
    else if (hadSelection) this.options.onElementSelect?.(null)
    if (focus && focus.seq !== this.lastFocusSeq) {
      this.lastFocusSeq = focus.seq
      this.focusRun(focus.cursor)
      if (focus.selectionEnd) {
        const first = this.runElement(focus.cursor.runId), last = this.runElement(focus.selectionEnd.runId)
        const a = first && pointInRun(first, focus.cursor.offset), b = last && pointInRun(last, focus.selectionEnd.offset)
        if (a && b) selectionFor(this.root)?.setBaseAndExtent(a.node, a.offset, b.node, b.offset)
      }
    }
  }

  /** Capture before moving focus to a toolbar or context menu. */
  insertionAnchor(): string | undefined {
    if (this.selectedElement) return this.selectedElement
    const node = selectionFor(this.root)?.focusNode ?? null
    return runElementOf(node)?.closest<HTMLElement>('[data-sm-element]')?.dataset.smElement
  }

  isTableActive(id: string): boolean {
    return this.selectedElement === id || (this.editing && this.insertionAnchor() === id)
  }

  selectElementOnRender(id: string): void { this.pendingElementSelection = id }

  cancelDrag(): void { this.cancelHandleDrag?.(); this.cancelHandleDrag = undefined }

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
    this.clearElementSelection(false)
    this.clearCompositionEndTimer()
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
    root.ownerDocument.defaultView?.removeEventListener('resize', this.onResize)
    this.resizeObserver?.disconnect()
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
        if (result.cursor) {
          this.endEditingSilently()
          this.options.onCrossRun(result, result.cursor, before)
          return
        }
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
    this.options.onBegin(labelForBlock(block), fresh.closest<HTMLElement>('[data-sm-element]')?.dataset.smElement)
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
