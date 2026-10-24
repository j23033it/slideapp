import browser, { type MarpCoreBrowser } from '@marp-team/marp-core/browser'

import { applyJapaneseFonts, ensureDocumentImports, splitCssImports } from './fonts'
import type { RenderedDeck } from './renderer'

export type SurfaceLayout = 'single' | 'list'

export interface SlideSurfaceOptions {
  layout: SurfaceLayout
  /** サムネイルの読み上げラベル */
  labelFor?: (index: number) => string
  onSelect?: (index: number) => void
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

      const select = () => this.options.onSelect?.(index)
      row.addEventListener('click', select)
      slot.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          select()
        }
      })
      this.surface.append(row)
    } else {
      this.surface.append(slot)
    }

    this.slots.push(slot)
    this.frames.push(frame)
    this.htmlCache.push('')
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
    if (this.options.layout !== 'list') return
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
