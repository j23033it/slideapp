import browser, { type MarpCoreBrowser } from '@marp-team/marp-core/browser'

import { applyJapaneseFonts, ensureDocumentImports, splitCssImports } from './fonts'
import type { SlideOperation, SlideOperationResult } from '../editing'
import type { RenderedDeck } from './renderer'

export type SurfaceLayout = 'single' | 'list'
export type SlideListCommand = 'add' | 'duplicate' | 'delete' | 'moveUp' | 'moveDown'
/** The host owns IME settlement, session updates and rejection notifications. */
export type SlideOperationHandler = (operation: SlideOperation) => void | SlideOperationResult | Promise<void | SlideOperationResult>


export interface SlideSurfaceOptions {
  layout: SurfaceLayout
  /** サムネイルの読み上げラベル */
  labelFor?: (index: number) => string
  onSelect?: (index: number) => void
  onSlideOperation?: SlideOperationHandler
  isReadonly?: () => boolean
  operationLabel?: (command: SlideListCommand) => string
}

const LIST_INLINE_PADDING = 12
const LIST_NUMBER_GAP = 8

const BASE_CSS = `
:host { display: block; position: relative; width: 100%; height: 100%; }
.surface { box-sizing: border-box; position: relative; display: flex; width: 100%; height: 100%; overflow: hidden; }
.surface[data-layout='single'] { align-items: center; justify-content: center; padding: 16px; }
.surface[data-layout='list'] {
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 0 16px;
  gap: 2px;
}
.slide-row {
  box-sizing: border-box;
  position: relative;
  display: grid;
  grid-template-columns: var(--slide-number-width, 20px) minmax(0, 1fr);
  align-items: start;
  gap: ${LIST_NUMBER_GAP}px;
  flex: 0 0 auto;
  padding: 6px ${LIST_INLINE_PADDING}px;
  cursor: pointer;
}
.surface[data-layout='list'] .slide-row { touch-action: none; user-select: none; }
.surface[data-layout='list'] .frame { pointer-events: none; }
.slide-drop-line {
  position: absolute; left: 12px; right: 12px; height: 2px;
  background: var(--sm-accent, #0f6cbd); z-index: 2; pointer-events: none;
}
.slide-menu {
  position: fixed; z-index: 1000; box-sizing: border-box; min-width: min(232px, 100vw);
  max-width: 100vw; max-height: 100vh; overflow: auto; padding: 4px;
  border: 1px solid var(--sm-border); border-radius: 4px;
  background: var(--sm-surface); color: var(--sm-text);
  font: 12px/1.4 var(--sm-font-ui);
}
.slide-menu button {
  display: flex; justify-content: space-between; align-items: center; gap: 20px;
  box-sizing: border-box; width: 100%; min-height: 30px; padding: 5px 8px;
  border: 0; border-radius: 2px; background: transparent; color: inherit;
  font: inherit; text-align: left;
}
.slide-menu button:hover:enabled, .slide-menu button:focus-visible { background: var(--sm-hover); }
.slide-menu button:focus-visible { outline: 2px solid var(--sm-accent); outline-offset: -2px; }
.slide-menu button:disabled { color: var(--sm-text-muted); opacity: 0.5; }
.slide-menu kbd { color: var(--sm-text-muted); font: inherit; white-space: nowrap; }
.slide-row:hover { background: var(--sm-hover, rgba(0, 0, 0, 0.07)); }
.slide-row[data-active='true'] { background: var(--sm-accent-subtle, #dceafa); }
.slide-row[data-active='true']::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--sm-accent, #0f6cbd);
}
.slide-number {
  padding-top: 3px;
  color: var(--sm-text-muted, #5f5f5f);
  font: 12px/1.4 var(--sm-font-ui, 'Segoe UI', sans-serif);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.slide-row[data-active='true'] .slide-number { color: var(--sm-accent, #0f6cbd); font-weight: 700; }
.slot { position: relative; flex: 0 0 auto; overflow: hidden; background: #fff; }
.frame { position: absolute; top: 0; left: 0; transform-origin: top left; }
.frame > div.marpit { width: 100%; height: 100%; }
.frame div.marpit > svg[data-marpit-svg] { display: block; width: 100%; height: 100%; }
.surface[data-layout='list'] .slot { cursor: pointer; }
.thumbnail-selection {
  box-sizing: border-box;
  position: absolute;
  inset: 0;
  z-index: 1;
  border: 3px solid transparent;
  pointer-events: none;
}
.slot[data-active='true'] > .thumbnail-selection { border-color: var(--sm-accent, #0f6cbd); }
.surface[data-layout='list'] .slot:focus-visible { box-shadow: 0 0 0 2px var(--sm-accent, #0f6cbd); }
/* 閲覧中も本文をドラッグ選択・コピーできるようにする。 */
.surface[data-layout='single'] .frame {
  -webkit-user-select: text;
  user-select: text;
}
/* 編集状態: 編集中のブロックは細い枠、カーソルは文字用にする */
.surface[data-layout='single'] .frame [data-sm-block][contenteditable='true'] {
  outline: 1px solid var(--sm-accent, #0f6cbd);
  outline-offset: 2px;
  cursor: text;
  -webkit-user-select: text;
  user-select: text;
}
.surface[data-layout='single'] .frame [data-sm-block][contenteditable='true'] * {
  -webkit-user-select: text;
  user-select: text;
}
/* 読み取り専用: ポインターを重ねたら点線の枠 */
.surface[data-layout='single'] .frame [data-sm-readonly]:hover,
.surface[data-layout='single'] .frame section table:hover,
.surface[data-layout='single'] .frame section pre:hover,
.surface[data-layout='single'] .frame section code:hover,
.surface[data-layout='single'] .frame section img:hover,
.surface[data-layout='single'] .frame section mjx-container:hover {
  outline: 1px dotted var(--sm-readonly, #b45309);
  outline-offset: 1px;
}
`

function roundScale(value: number): number {
  return Math.round(value * 100) / 100
}

/** 行全体が見える最も近いスクロール位置を返す。すでに見えていれば動かさない */
export function scrollTopForVisibleRow(
  scrollTop: number,
  viewportHeight: number,
  rowTop: number,
  rowHeight: number,
): number {
  if (viewportHeight <= 0 || rowHeight <= 0) return scrollTop
  // 表示範囲より高い行は収まらないので、先頭を見せて往復しないようにする。
  if (rowHeight > viewportHeight || rowTop < scrollTop) return Math.max(0, rowTop)
  if (rowTop + rowHeight > scrollTop + viewportHeight) {
    return Math.max(0, rowTop + rowHeight - viewportHeight)
  }
  return scrollTop
}

/**
 * Shadow DOMの中でMarpのスライドを表示する。
 * - `single`: 選択中の1枚だけを、縦横比を保って最大表示する
 * - `list`: すべてのスライドを縦に並べ、幅に合わせて縮小する（スライド一覧）
 *
 * 前回と同じHTMLのスライドはDOMを差し替えない。
 */
export class SlideSurface {
  private readonly shadow: ShadowRoot
  private readonly marpStyle: HTMLStyleElement
  private readonly surface: HTMLDivElement
  private readonly slots: HTMLDivElement[] = []
  private readonly frames: HTMLDivElement[] = []
  private readonly rows: HTMLDivElement[] = []
  private activeIndex = 0
  private menu: HTMLDivElement | null = null
  private menuIndex = 0
  private drag?: { index: number; pointerId: number; x: number; y: number; clientY: number; clientX: number; boundary: number; active: boolean }
  private dropLine: HTMLDivElement | null = null
  private scrollFrame?: number
  private suppressClick = false
  private suppressTimer?: ReturnType<typeof setTimeout>
  private htmlCache: string[] = []
  private deck: RenderedDeck | null = null
  private readonly resizeObserver: ResizeObserver
  private readonly browserHandle: MarpCoreBrowser

  constructor(
    host: HTMLElement,
    private readonly options: SlideSurfaceOptions,
  ) {
    this.shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })

    this.marpStyle = document.createElement('style')
    this.marpStyle.dataset.role = 'marp'

    const baseStyle = document.createElement('style')
    baseStyle.textContent = BASE_CSS

    this.surface = document.createElement('div')
    this.surface.className = 'surface'
    this.surface.dataset.layout = options.layout

    this.shadow.append(this.marpStyle, baseStyle, this.surface)
    if (options.layout === 'list') {
      this.surface.tabIndex = 0
      this.surface.addEventListener('keydown', this.onListKeyDown)
      this.surface.addEventListener('dragstart', event => event.preventDefault())
      document.addEventListener('pointerdown', this.onOutsidePointer, true)
      document.addEventListener('click', this.onOutsidePointer, true)
      document.addEventListener('keydown', this.onEscape, true)
      document.addEventListener('pointermove', this.onPointerMove, true)
      document.addEventListener('pointerup', this.onPointerUp, true)
      document.addEventListener('pointercancel', this.onPointerCancel, true)
      window.addEventListener('blur', this.onWindowBlur)
    }

    this.browserHandle = browser(this.shadow)
    this.resizeObserver = new ResizeObserver(() => this.applySizes())
    this.resizeObserver.observe(host)
    this.resizeObserver.observe(this.surface)
  }

  /** 編集エンジンがDOMを探索・検証するためのルート */
  get root(): ShadowRoot {
    return this.shadow
  }

  /** 描画結果を反映する。変わったスライドだけDOMを差し替える */
  update(deck: RenderedDeck, activeIndex: number): void {
    const focused = this.shadow.activeElement
    const restoreListFocus = this.options.layout === 'list' && this.deck !== deck && !!focused &&
      (this.surface.contains(focused) || !!this.menu?.contains(focused))
    // Finishing text editing refreshes thumbnails after a menu/drag has started.
    // Index-based operations remain valid while the slide count is unchanged.
    if (this.deck && this.deck.slides.length !== deck.slides.length) {
      this.closeMenu(false)
      this.cancelDrag()
    }
    this.deck = deck

    const { imports, css } = splitCssImports(deck.css)
    ensureDocumentImports(imports)
    if (this.marpStyle.textContent !== css) {
      this.marpStyle.textContent = css
    }

    while (this.slots.length < deck.slides.length) this.createSlot(this.slots.length)
    while (this.slots.length > deck.slides.length) {
      const slot = this.slots.pop()
      this.rows.pop()?.remove()
      slot?.remove()
      this.frames.pop()
      this.htmlCache.pop()
    }

    let changed = false
    for (let i = 0; i < deck.slides.length; i += 1) {
      const html = deck.slides[i]
      const frame = this.frames[i]
      if (html === undefined || frame === undefined) continue
      if (this.htmlCache[i] === html) continue
      frame.innerHTML = html
      this.htmlCache[i] = html
      changed = true
    }

    applyJapaneseFonts(this.shadow)
    if (changed) this.browserHandle.update()

    this.setActive(activeIndex, { scroll: false })
    this.applySizes()
    if (restoreListFocus && !this.menu) (this.slots[this.activeIndex] ?? this.surface).focus({ preventScroll: true })
  }

  setActive(index: number, { scroll = true }: { scroll?: boolean } = {}): void {
    const total = this.slots.length
    const clamped = total === 0 ? 0 : Math.min(Math.max(index, 0), total - 1)
    this.activeIndex = clamped

    for (let i = 0; i < total; i += 1) {
      const slot = this.slots[i]
      if (!slot) continue
      slot.dataset.active = i === clamped ? 'true' : 'false'
      if (this.options.layout === 'single') {
        slot.style.display = i === clamped ? '' : 'none'
      } else {
        const row = this.rows[i]
        if (row) row.dataset.active = slot.dataset.active
        if (i === clamped) slot.setAttribute('aria-current', 'page')
        else slot.removeAttribute('aria-current')
        const label = this.options.labelFor?.(i)
        if (label) slot.setAttribute('aria-label', label)
      }
    }

    if (scroll) this.revealActiveRow()
  }

  dispose(): void {
    this.closeMenu(false)
    this.cancelDrag()
    clearTimeout(this.suppressTimer)
    this.surface.removeEventListener('keydown', this.onListKeyDown)
    document.removeEventListener('pointerdown', this.onOutsidePointer, true)
    document.removeEventListener('click', this.onOutsidePointer, true)
    document.removeEventListener('keydown', this.onEscape, true)
    document.removeEventListener('pointermove', this.onPointerMove, true)
    document.removeEventListener('pointerup', this.onPointerUp, true)
    document.removeEventListener('pointercancel', this.onPointerCancel, true)
    window.removeEventListener('blur', this.onWindowBlur)
    this.resizeObserver.disconnect()
    this.browserHandle.cleanup()
  }

  private createSlot(index: number): void {
    const slot = document.createElement('div')
    slot.className = 'slot'
    slot.dataset.index = String(index)

    const frame = document.createElement('div')
    frame.className = 'frame'
    slot.append(frame)

    if (this.options.layout === 'list') {
      // 選択の枠を、絶対配置のMarp描画より前に重ねる。
      const selection = document.createElement('div')
      selection.className = 'thumbnail-selection'
      selection.setAttribute('aria-hidden', 'true')
      slot.append(selection)

      const row = document.createElement('div')
      row.className = 'slide-row'
      const number = document.createElement('span')
      number.className = 'slide-number'
      number.textContent = String(index + 1)
      number.setAttribute('aria-hidden', 'true')
      row.append(number, slot)
      this.rows.push(row)

      slot.tabIndex = 0
      slot.setAttribute('role', 'button')
      const label = this.options.labelFor?.(index)
      if (label) slot.setAttribute('aria-label', label)

      row.addEventListener('click', event => {
        if (this.suppressClick) { event.preventDefault(); event.stopPropagation(); return }
        this.select(index)
      })
      row.addEventListener('contextmenu', event => {
        event.preventDefault()
        this.cancelDrag()
        this.select(index)
        this.openMenu(index, event.clientX, event.clientY)
      })
      row.addEventListener('pointerdown', event => {
        if (event.button !== 0 || this.menu?.contains(event.target as Node)) return
        this.suppressClick = false
        clearTimeout(this.suppressTimer)
        if (!this.canOperate()) return
        this.drag = { index, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
          clientX: event.clientX, clientY: event.clientY, boundary: index, active: false }
      })
      this.surface.append(row)
    } else {
      this.surface.append(slot)
    }

    this.slots.push(slot)
    this.frames.push(frame)
    this.htmlCache.push('')
  }

  /** Refresh after host read-only/availability changes without rebuilding Marp DOM. */
  refreshOperations(): void {
    this.closeMenu(false)
    this.cancelDrag()
  }

  private canOperate(): boolean {
    return !!this.options.onSlideOperation && !this.options.isReadonly?.()
  }

  private enabled(operation: SlideOperation): boolean {
    if (!this.canOperate() || operation.index < 0 || operation.index >= this.slots.length) return false
    if (operation.kind === 'delete') return this.slots.length > 1
    if (operation.kind === 'move') return operation.to >= 0 && operation.to < this.slots.length && operation.to !== operation.index
    return true
  }

  private request(operation: SlideOperation): void {
    if (this.enabled(operation)) void this.options.onSlideOperation?.(operation)
  }

  private select(index: number): void {
    this.slots[index]?.focus({ preventScroll: true })
    this.options.onSelect?.(index)
  }

  private commandOperation(command: SlideListCommand, index: number): SlideOperation {
    if (command === 'moveUp' || command === 'moveDown') return { kind: 'move', index, to: index + (command === 'moveUp' ? -1 : 1) }
    return { kind: command, index }
  }

  private onListKeyDown = (event: KeyboardEvent): void => {
    if (event.isComposing || event.keyCode === 229 || this.drag?.active || event.altKey || event.metaKey) return
    const slot = (event.target as Element).closest<HTMLElement>('.slot')
    const index = slot ? Number(slot.dataset.index) : this.activeIndex
    let command: SlideListCommand | undefined
    if (event.ctrlKey && !event.shiftKey) {
      if (event.key.toLowerCase() === 'm') command = 'add'
      else if (event.key.toLowerCase() === 'd') command = 'duplicate'
      else if (event.key === 'ArrowUp') command = 'moveUp'
      else if (event.key === 'ArrowDown') command = 'moveDown'
    } else if (!event.ctrlKey && !event.shiftKey && (event.key === 'Delete' || event.key === 'Backspace')) command = 'delete'
    if (command) {
      event.preventDefault()
      event.stopPropagation()
      this.request(this.commandOperation(command, index))
    } else if (slot && !event.ctrlKey && !event.shiftKey && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      this.select(index)
    } else if (slot && (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const rect = slot.getBoundingClientRect()
      this.select(index)
      this.openMenu(index, rect.left, rect.bottom)
    }
  }

  private openMenu(index: number, x: number, y: number): void {
    this.closeMenu(false)
    this.menuIndex = index
    const menu = document.createElement('div')
    menu.className = 'slide-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', this.options.labelFor?.(index) ?? '')
    const commands: [SlideListCommand, string][] = [
      ['add', 'Ctrl+M'], ['duplicate', 'Ctrl+D'], ['delete', 'Delete'], ['moveUp', 'Ctrl+↑'], ['moveDown', 'Ctrl+↓'],
    ]
    for (const [command, shortcut] of commands) {
      const operation = this.commandOperation(command, index)
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('role', 'menuitem')
      button.tabIndex = -1
      button.dataset.command = command
      button.disabled = !this.enabled(operation)
      const label = document.createElement('span')
      label.textContent = this.options.operationLabel?.(command) ?? command
      const key = document.createElement('kbd')
      key.textContent = shortcut
      button.append(label, key)
      button.addEventListener('click', () => {
        this.closeMenu(true)
        this.request(operation)
      })
      menu.append(button)
    }
    menu.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const buttons = [...menu.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.disabled)
        const current = buttons.indexOf(this.shadow.activeElement as HTMLButtonElement)
        const next = current < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        ;(this.shadow.activeElement as HTMLButtonElement | null)?.click()
      } else if (event.key === 'Tab') this.closeMenu(false)
      // Do not let menu shortcuts reach the list or App shortcut handlers.
      event.stopPropagation()
    })
    this.menu = menu
    this.shadow.append(menu)
    menu.style.left = '0px'
    menu.style.top = '0px'
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width))}px`
    menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height))}px`
    const first = [...menu.querySelectorAll<HTMLButtonElement>('button')].find(button => !button.disabled)
    if (first) first.focus()
    else { menu.tabIndex = -1; menu.focus() }
  }

  private closeMenu(restore: boolean): void {
    if (!this.menu) return
    this.menu.remove()
    this.menu = null
    if (restore) this.slots[this.menuIndex]?.focus({ preventScroll: true })
  }

  private onOutsidePointer = (event: Event): void => {
    if (this.menu && !event.composedPath().includes(this.menu)) this.closeMenu(false)
  }

  private onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || (!this.menu && !this.drag)) return
    event.preventDefault()
    event.stopPropagation()
    this.closeMenu(true)
    if (this.drag) { this.blockDragClick(); this.cancelDrag() }
  }

  private onWindowBlur = (): void => {
    this.closeMenu(false)
    this.cancelDrag()
  }

  private onPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.drag?.pointerId) { this.blockDragClick(); this.cancelDrag() }
  }

  private onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.pointerId) return
    if (!this.canOperate()) { this.cancelDrag(); return }
    drag.clientY = event.clientY
    drag.clientX = event.clientX
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return
      drag.active = true
      this.closeMenu(false)
      this.select(drag.index)
      if (this.drag !== drag) return
      this.dropLine = document.createElement('div')
      this.dropLine.className = 'slide-drop-line'
      this.dropLine.setAttribute('aria-hidden', 'true')
      this.surface.append(this.dropLine)
      this.scrollFrame = requestAnimationFrame(this.autoScroll)
    }
    event.preventDefault()
    this.positionDropLine()
  }

  private positionDropLine(): void {
    const drag = this.drag
    if (!drag?.active || !this.dropLine) return
    const boundary = this.rows.findIndex(row => drag.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2)
    drag.boundary = boundary < 0 ? this.rows.length : boundary
    const row = this.rows[drag.boundary] ?? this.rows.at(-1)
    const top = row ? row.offsetTop + (drag.boundary === this.rows.length ? row.offsetHeight : 0) : 0
    this.dropLine.style.top = `${top - 1}px`
    this.dropLine.dataset.boundary = String(drag.boundary)
  }

  private autoScroll = (): void => {
    this.scrollFrame = undefined
    const drag = this.drag
    if (!drag?.active) return
    if (!this.canOperate()) { this.cancelDrag(); return }
    const rect = this.surface.getBoundingClientRect()
    const edge = Math.min(28, rect.height / 2)
    const delta = drag.clientY < rect.top + edge ? -Math.min(12, (rect.top + edge - drag.clientY) / 2)
      : drag.clientY > rect.bottom - edge ? Math.min(12, (drag.clientY - rect.bottom + edge) / 2) : 0
    if (edge > 0 && drag.clientX >= rect.left && drag.clientX <= rect.right && delta) {
      this.surface.scrollTop = Math.max(0, Math.min(this.surface.scrollTop + delta, Math.max(0, this.surface.scrollHeight - this.surface.clientHeight)))
      this.positionDropLine()
    }
    this.scrollFrame = requestAnimationFrame(this.autoScroll)
  }

  private onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag
    if (!drag || event.pointerId !== drag.pointerId) return
    if (drag.active) {
      drag.clientY = event.clientY
      this.positionDropLine()
      const rect = this.surface.getBoundingClientRect()
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      const to = drag.boundary > drag.index ? drag.boundary - 1 : drag.boundary
      this.blockDragClick()
      this.cancelDrag()
      if (inside && to !== drag.index) this.request({ kind: 'move', index: drag.index, to })
    } else this.cancelDrag()
  }

  private blockDragClick(): void {
    this.suppressClick = true
    clearTimeout(this.suppressTimer)
    this.suppressTimer = setTimeout(() => { this.suppressClick = false }, 0)
  }

  private cancelDrag(): void {
    this.drag = undefined
    this.dropLine?.remove()
    this.dropLine = null
    if (this.scrollFrame !== undefined) cancelAnimationFrame(this.scrollFrame)
    this.scrollFrame = undefined
  }

  private applySizes(): void {
    const deck = this.deck
    if (!deck) return

    const padding = this.options.layout === 'single' ? 16 : LIST_INLINE_PADDING
    const numberWidth = Math.max(20, String(this.slots.length).length * 8)
    const numberSpace = this.options.layout === 'list' ? numberWidth + LIST_NUMBER_GAP : 0
    if (this.options.layout === 'list') {
      this.surface.style.setProperty('--slide-number-width', `${numberWidth}px`)
    }
    const availableWidth = Math.max(0, this.surface.clientWidth - padding * 2 - numberSpace)
    const availableHeight = Math.max(0, this.surface.clientHeight - padding * 2)

    let scale =
      this.options.layout === 'single'
        ? Math.min(availableWidth / deck.width, availableHeight / deck.height)
        : availableWidth / deck.width

    if (!Number.isFinite(scale) || scale <= 0) scale = 0
    scale = roundScale(scale)
    // 丸めで番号の列へはみ出したり、右端が欠けたりしないようにする。
    if (this.options.layout === 'list') scale = Math.min(scale, availableWidth / deck.width)

    const width = roundScale(deck.width * scale)
    const height = roundScale(deck.height * scale)

    for (let i = 0; i < this.frames.length; i += 1) {
      const slot = this.slots[i]
      const frame = this.frames[i]
      if (!slot || !frame) continue
      slot.style.width = `${width}px`
      slot.style.height = `${height}px`
      frame.style.width = `${deck.width}px`
      frame.style.height = `${deck.height}px`
      frame.style.transform = `scale(${scale})`
    }

    this.revealActiveRow()
  }

  private revealActiveRow(): void {
    if (this.options.layout !== 'list' || this.drag?.active) return
    const row = this.rows[this.activeIndex]
    if (!row) return
    const scrollTop = scrollTopForVisibleRow(
      this.surface.scrollTop,
      this.surface.clientHeight,
      row.offsetTop,
      row.offsetHeight,
    )
    if (scrollTop !== this.surface.scrollTop) this.surface.scrollTop = scrollTop
  }
}
