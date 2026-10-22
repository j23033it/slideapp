import browser, { type MarpCoreBrowser } from '@marp-team/marp-core/browser'

import { ensureDocumentImports, splitCssImports } from './fonts'
import type { RenderedDeck } from './renderer'

export type SurfaceLayout = 'single' | 'list'

export interface SlideSurfaceOptions {
  layout: SurfaceLayout
  /** サムネイルの読み上げラベル */
  labelFor?: (index: number) => string
  onSelect?: (index: number) => void
}

const BASE_CSS = `
:host { display: block; position: relative; width: 100%; height: 100%; }
.surface { box-sizing: border-box; position: relative; display: flex; width: 100%; height: 100%; overflow: hidden; }
.surface[data-layout='single'] { align-items: center; justify-content: center; padding: 16px; }
.surface[data-layout='list'] {
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 12px 16px;
  gap: 8px;
}
.slot { position: relative; flex: 0 0 auto; overflow: hidden; background: #fff; }
.frame { position: absolute; top: 0; left: 0; transform-origin: top left; }
.frame > div.marpit { width: 100%; height: 100%; }
.frame div.marpit > svg[data-marpit-svg] { display: block; width: 100%; height: 100%; }
.surface[data-layout='list'] .slot { cursor: pointer; }
.surface[data-layout='list'] .slot[data-active='true'] { outline: 2px solid var(--sm-accent, #0f6cbd); outline-offset: -2px; }
.surface[data-layout='list'] .slot:focus-visible { outline: 2px solid var(--sm-accent, #0f6cbd); outline-offset: -2px; }
`

function roundScale(value: number): number {
  return Math.round(value * 100) / 100
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

    if (changed) this.browserHandle.update()

    this.setActive(activeIndex, { scroll: true })
    this.applySizes()
  }

  setActive(index: number, { scroll = false }: { scroll?: boolean } = {}): void {
    const total = this.slots.length
    const clamped = total === 0 ? 0 : Math.min(Math.max(index, 0), total - 1)

    for (let i = 0; i < total; i += 1) {
      const slot = this.slots[i]
      if (!slot) continue
      slot.dataset.active = i === clamped ? 'true' : 'false'
      if (this.options.layout === 'single') {
        slot.style.display = i === clamped ? '' : 'none'
      }
    }

    if (scroll && this.options.layout === 'list') {
      const slot = this.slots[clamped]
      if (slot) {
        const top = slot.offsetTop
        const bottom = top + slot.offsetHeight
        if (top < this.surface.scrollTop) {
          this.surface.scrollTop = Math.max(0, top - 8)
        } else if (bottom > this.surface.scrollTop + this.surface.clientHeight) {
          this.surface.scrollTop = bottom - this.surface.clientHeight + 8
        }
      }
    }
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
      slot.tabIndex = 0
      slot.setAttribute('role', 'button')
      const label = this.options.labelFor?.(index)
      if (label) slot.setAttribute('aria-label', label)

      const select = () => this.options.onSelect?.(index)
      slot.addEventListener('click', select)
      slot.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          select()
        }
      })
    }

    this.surface.append(slot)
    this.slots.push(slot)
    this.frames.push(frame)
    this.htmlCache.push('')
  }

  private applySizes(): void {
    const deck = this.deck
    if (!deck) return

    const padding = this.options.layout === 'single' ? 16 : 12
    const availableWidth = Math.max(0, this.surface.clientWidth - padding * 2)
    const availableHeight = Math.max(0, this.surface.clientHeight - padding * 2)

    let scale =
      this.options.layout === 'single'
        ? Math.min(availableWidth / deck.width, availableHeight / deck.height)
        : availableWidth / deck.width

    if (!Number.isFinite(scale) || scale <= 0) scale = 0
    scale = roundScale(scale)

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
  }
}
