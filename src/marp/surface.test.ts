// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RenderedDeck } from './renderer'
import { SlideSurface, scrollTopForVisibleRow } from './surface'

vi.mock('@marp-team/marp-core/browser', () => ({
  default: () => ({ update: vi.fn(), cleanup: vi.fn() }),
}))

const surfaces: SlideSurface[] = []
let resize: () => void
const disconnect = vi.fn()

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect = disconnect
  })
})

afterEach(() => {
  for (const surface of surfaces.splice(0)) surface.dispose()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('style')
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function deck(count = 3): RenderedDeck {
  return {
    slides: Array.from({ length: count }, (_, index) => `<section>Slide ${index + 1}</section>`),
    css: '', width: 1280, height: 720,
  }
}

function setup(layout: 'single' | 'list' = 'list') {
  const host = document.createElement('div')
  document.body.append(host)
  const onSelect = vi.fn()
  let total = 3
  const surface = new SlideSurface(host, {
    layout, onSelect, labelFor: index => `Slide ${index + 1} of ${total}`,
  })
  surfaces.push(surface)
  const viewport = surface.root.querySelector<HTMLElement>('.surface')!
  let width = 180
  let height = 200
  Object.defineProperties(viewport, {
    clientWidth: { get: () => width },
    clientHeight: { get: () => height },
  })
  const slots = () => [...surface.root.querySelectorAll<HTMLElement>('.slot')]
  const rows = () => [...surface.root.querySelectorAll<HTMLElement>('.slide-row')]
  // Happy DOMには配置計算がないので、適用したサムネイルの大きさから行の寸法を作る。
  function measureRows() {
    for (const [index, row] of rows().entries()) {
      const rowHeight = () => Number.parseFloat(slots()[index]!.style.height) + 12
      Object.defineProperties(row, {
        offsetTop: { configurable: true, get: () => 8 + index * (rowHeight() + 2) },
        offsetHeight: { configurable: true, get: rowHeight },
      })
    }
  }
  return {
    surface, viewport, slots, rows, onSelect, measureRows,
    setTotal(value: number) { total = value },
    setSize(w: number, h: number) { width = w; height = h },
  }
}

describe('scrollTopForVisibleRow', () => {
  it.each([
    [100, 200, 100, 80, 100], // flush with the top
    [100, 200, 220, 80, 100], // flush with the bottom
    [100, 200, 150, 80, 100], // already fully visible
    [100, 200, 80, 80, 80], // partially above
    [100, 200, 280, 80, 160], // partially below
    [100, 200, 800, 80, 680], // far below
    [500, 200, 8, 80, 8], // far above
    [100, 0, 800, 80, 100], // sidebar hidden
    [100, 200, 800, 0, 100], // layout not ready
    [100, 40, 80, 100, 80], // oversized row: align to its top
    [80, 40, 80, 100, 80], // repeated oversized measurement stays put
  ])('reveals rows with minimal movement (%j, %j, %j, %j)', (scroll, height, top, rowHeight, expected) => {
    expect(scrollTopForVisibleRow(scroll, height, top, rowHeight)).toBe(expected)
  })
})

describe('SlideSurface list appearance and interaction', () => {
  it('numbers each thumbnail and synchronizes selection and aria-current', () => {
    const s = setup()
    s.surface.update(deck(), 1)
    expect(s.rows().map(row => row.querySelector('.slide-number')!.textContent)).toEqual(['1', '2', '3'])
    expect(s.rows().map(row => row.dataset.active)).toEqual(['false', 'true', 'false'])
    expect(s.slots().map(slot => slot.getAttribute('aria-current'))).toEqual([null, 'page', null])
    expect(s.slots()[1]!.getAttribute('aria-label')).toBe('Slide 2 of 3')
    expect(s.rows()[1]!.querySelector('.slide-number')!.getAttribute('aria-hidden')).toBe('true')

    s.surface.setActive(2)
    expect(s.rows().map(row => row.dataset.active)).toEqual(['false', 'false', 'true'])
    expect(s.slots().map(slot => slot.getAttribute('aria-current'))).toEqual([null, null, 'page'])
  })

  it.each(['light', 'dark'])('uses theme tokens for the selected row, number, and 3px border in %s mode', theme => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.setProperty('--sm-accent', theme === 'dark' ? '#4aa3f0' : '#0f6cbd')
    document.documentElement.style.setProperty('--sm-accent-subtle', theme === 'dark' ? '#173b59' : '#dceafa')
    document.documentElement.style.setProperty('--sm-text-muted', theme === 'dark' ? '#b0b0b0' : '#5f5f5f')
    const s = setup()
    s.surface.update(deck(), 1)
    const border = s.slots()[1]!.querySelector<HTMLElement>('.thumbnail-selection')!
    expect(getComputedStyle(border).borderTopWidth).toBe('3px')
    expect(getComputedStyle(border).borderTopStyle).toBe('solid')
    expect(getComputedStyle(border).borderTopColor).toBe(theme === 'dark' ? '#4aa3f0' : '#0f6cbd')
    expect(getComputedStyle(border).pointerEvents).toBe('none')
    expect(getComputedStyle(s.slots()[0]!.querySelector('.thumbnail-selection')!).borderTopColor).toBe('transparent')
    expect(getComputedStyle(s.rows()[1]!).backgroundColor).toBe(theme === 'dark' ? '#173b59' : '#dceafa')
    expect(getComputedStyle(s.rows()[1]!.querySelector('.slide-number')!).fontWeight).toBe('700')
    expect(getComputedStyle(s.rows()[1]!.querySelector('.slide-number')!).color).toBe(theme === 'dark' ? '#4aa3f0' : '#0f6cbd')
    expect(getComputedStyle(s.rows()[0]!.querySelector('.slide-number')!).color).toBe(theme === 'dark' ? '#b0b0b0' : '#5f5f5f')
  })

  it('keeps thumbnail clicks and Enter/Space selection, including clicks on the number', () => {
    const s = setup()
    s.surface.update(deck(), 0)
    s.slots()[1]!.click()
    s.rows()[2]!.querySelector<HTMLElement>('.slide-number')!.click()
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      s.slots()[1]!.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(s.onSelect.mock.calls).toEqual([[1], [2], [1], [1]])
    expect(s.slots().every(slot => slot.tabIndex === 0 && slot.getAttribute('role') === 'button')).toBe(true)
  })

  it('reserves the number gutter and keeps the thumbnail aspect ratio inside 180px', () => {
    const s = setup()
    s.surface.update(deck(), 0)
    const slot = s.slots()[0]!
    const width = Number.parseFloat(slot.style.width)
    const height = Number.parseFloat(slot.style.height)
    expect(width).toBeLessThanOrEqual(180 - 24 - 20 - 8)
    expect(width / height).toBeCloseTo(1280 / 720, 3)
    expect(slot.querySelector<HTMLElement>('.frame')!.style.transform).toBe(`scale(${width / 1280})`)

    s.setTotal(120)
    s.surface.update(deck(120), 119)
    expect(s.viewport.style.getPropertyValue('--slide-number-width')).toBe('24px')
    expect(s.rows()[119]!.querySelector('.slide-number')!.textContent).toBe('120')
    expect(Number.parseFloat(s.slots()[0]!.style.width)).toBeLessThanOrEqual(180 - 24 - 24 - 8)
  })

  it('removes rows and updates current state and accessible labels after deck replacement', () => {
    const s = setup()
    s.surface.update(deck(), 2)
    s.setTotal(2)
    s.surface.update(deck(2), 10)
    expect(s.rows()).toHaveLength(2)
    expect(s.slots()[1]!.getAttribute('aria-current')).toBe('page')
    expect(s.slots()[0]!.getAttribute('aria-label')).toBe('Slide 1 of 2')
    s.surface.update(deck(0), 0)
    expect(s.rows()).toHaveLength(0)
    expect(s.slots()).toHaveLength(0)
  })

  it('preserves the single-slide DOM and fit calculation', () => {
    const s = setup('single')
    s.setSize(1312, 752)
    s.surface.update(deck(), 1)
    expect(s.rows()).toHaveLength(0)
    expect(s.slots().map(slot => slot.style.display)).toEqual(['none', '', 'none'])
    expect(s.slots()[1]!.style.width).toBe('1280px')
    expect(s.slots()[1]!.style.height).toBe('720px')
    expect(s.surface.root.querySelector('[aria-current]')).toBeNull()
  })
})

describe('SlideSurface active row visibility', () => {
  it('reveals a changed slide and leaves an already visible slide stationary', () => {
    const s = setup()
    s.surface.update(deck(8), 0)
    s.measureRows()
    s.surface.update(deck(8), 7)
    const last = s.rows()[7]!
    expect(s.viewport.scrollTop).toBe(last.offsetTop + last.offsetHeight - 200)
    const scrollTop = s.viewport.scrollTop
    s.surface.update(deck(8), 7)
    expect(s.viewport.scrollTop).toBe(scrollTop)
    s.surface.setActive(0)
    expect(s.viewport.scrollTop).toBe(8)
  })

  it('measures after sizing when the sidebar width or deck size changes', () => {
    const s = setup()
    s.surface.update(deck(8), 0)
    s.measureRows()
    s.setSize(280, 200)
    s.surface.update(deck(8), 7)
    const last = s.rows()[7]!
    expect(s.viewport.scrollTop).toBe(last.offsetTop + last.offsetHeight - 200)
    s.setSize(320, 200)
    resize()
    expect(s.viewport.scrollTop).toBe(last.offsetTop + last.offsetHeight - 200)
  })

  it('reveals the current slide after becoming visible and after a height resize', () => {
    const s = setup()
    s.setSize(0, 0)
    s.surface.update(deck(8), 7)
    s.measureRows()
    expect(s.viewport.scrollTop).toBe(0)
    s.setSize(180, 200)
    resize()
    const last = s.rows()[7]!
    expect(s.viewport.scrollTop).toBe(last.offsetTop + last.offsetHeight - 200)
    s.setSize(180, 150)
    resize()
    expect(s.viewport.scrollTop).toBe(last.offsetTop + last.offsetHeight - 150)
    const scrollTop = s.viewport.scrollTop
    resize()
    expect(s.viewport.scrollTop).toBe(scrollTop)
  })
})
