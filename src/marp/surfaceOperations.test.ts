// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderedDeck } from './renderer'
import { SlideSurface } from './surface'

vi.mock('@marp-team/marp-core/browser', () => ({ default: () => ({ update() {}, cleanup() {} }) }))

const surfaces: SlideSurface[] = []
let frames: Map<number, FrameRequestCallback>
let nextFrame = 0

beforeEach(() => {
  frames = new Map()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => {
  for (const surface of surfaces.splice(0)) surface.dispose()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function fixture(count = 3) {
  const host = document.createElement('div')
  document.body.append(host)
  const onOperation = vi.fn(), onSelect = vi.fn()
  let readonly = false
  const surface = new SlideSurface(host, {
    layout: 'list', onSelect, onSlideOperation: onOperation,
    isReadonly: () => readonly,
    labelFor: index => `Slide ${index + 1}`,
    operationLabel: command => command,
  })
  surfaces.push(surface)
  const viewport = surface.root.querySelector<HTMLElement>('.surface')!
  Object.defineProperties(viewport, {
    clientWidth: { value: 180 }, clientHeight: { value: 200 }, scrollHeight: { value: 1000 },
  })
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 180, 200)
  const deck: RenderedDeck = {
    slides: Array.from({ length: count }, (_, index) => `<section>${index}</section>`),
    css: '', width: 1280, height: 720,
  }
  surface.update(deck, 0)
  const rows = [...surface.root.querySelectorAll<HTMLElement>('.slide-row')]
  const slots = [...surface.root.querySelectorAll<HTMLElement>('.slot')]
  for (const [index, row] of rows.entries()) {
    Object.defineProperties(row, { offsetTop: { value: index * 60 }, offsetHeight: { value: 58 } })
    row.getBoundingClientRect = () => new DOMRect(0, index * 60 - viewport.scrollTop, 180, 58)
  }
  const menu = () => surface.root.querySelector<HTMLElement>('.slide-menu')
  const item = (command: string) => menu()?.querySelector<HTMLButtonElement>(`[data-command='${command}']`)
  const key = (key: string, options: KeyboardEventInit = {}, target: HTMLElement = slots[0]!) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...options })
    target.dispatchEvent(event)
    return event
  }
  const context = (index = 0, x = 20, y = 20) => {
    rows[index]!.dispatchEvent(new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true, composed: true, cancelable: true }))
  }
  const pointer = (type: string, x: number, y: number, target: EventTarget = document, pointerId = 1) => {
    target.dispatchEvent(new PointerEvent(type, { pointerId, button: 0, clientX: x, clientY: y, bubbles: true, composed: true, cancelable: true }))
  }
  const tick = () => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  }
  return { surface, viewport, rows, slots, onOperation, onSelect, deck, menu, item, key, context, pointer, tick,
    setReadonly(value: boolean) { readonly = value } }
}

describe('slide list context menu', () => {
  it('selects before opening, shows shortcuts, skips disabled items, executes by keyboard and restores focus', () => {
    const f = fixture()
    f.onSelect.mockImplementation(() => { expect(f.menu()).toBeNull() })
    f.context(2)
    expect(f.onSelect).toHaveBeenCalledWith(2)
    expect(f.menu()?.getAttribute('role')).toBe('menu')
    expect([...f.menu()!.querySelectorAll('kbd')].map(el => el.textContent)).toEqual(['Ctrl+M', 'Ctrl+D', 'Delete', 'Ctrl+↑', 'Ctrl+↓'])
    expect(f.item('moveDown')?.disabled).toBe(true)
    expect(f.surface.root.activeElement).toBe(f.item('add'))
    f.key('ArrowUp', {}, f.item('add')!)
    expect(f.surface.root.activeElement).toBe(f.item('moveUp'))
    f.key('Enter', {}, f.item('moveUp')!)
    expect(f.onOperation.mock.calls).toEqual([[{ kind: 'move', index: 2, to: 1 }]])
    expect(f.menu()).toBeNull()
    expect(f.surface.root.activeElement).toBe(f.slots[2])
  })

  it('disables only structural failures and readonly operations, while forwarding semantic rejections to the host', () => {
    const f = fixture(1)
    f.context()
    expect(f.item('delete')?.disabled).toBe(true)
    expect(f.item('moveUp')?.disabled).toBe(true)
    expect(f.item('moveDown')?.disabled).toBe(true)
    expect(f.item('duplicate')?.disabled).toBe(false)
    const rejection = { ok: false, reason: { code: 'slide-inherited-settings', description: 'settings' } }
    f.onOperation.mockReturnValue(rejection)
    f.item('duplicate')!.click()
    expect(f.onOperation).toHaveReturnedWith(rejection)
    expect(f.menu()).toBeNull()
    f.setReadonly(true)
    f.context()
    expect([...f.menu()!.querySelectorAll<HTMLButtonElement>('button')].every(button => button.disabled)).toBe(true)
    f.item('add')!.click()
    expect(f.onOperation).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape, outside clicks and slide-count changes, but preserves the menu during selection-only updates', () => {
    const f = fixture()
    f.context(1)
    f.surface.update(f.deck, 1)
    expect(f.menu()).not.toBeNull()
    f.key('Escape', {}, f.item('add')!)
    expect(f.menu()).toBeNull()
    expect(f.surface.root.activeElement).toBe(f.slots[1])
    f.context()
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(f.menu()).toBeNull()
    f.context()
    f.surface.update({ ...f.deck, slides: f.deck.slides.slice(0, 2) }, 0)
    expect(f.menu()).toBeNull()
  })

  it('keeps the menu and keyboard focus after selection finishes a pending text edit', async () => {
    const f = fixture()
    let update: Promise<void> | undefined
    f.onSelect.mockImplementation(index => {
      update = Promise.resolve().then(() => f.surface.update({
        ...f.deck, slides: ['<section>Edited text</section>', ...f.deck.slides.slice(1)],
      }, index))
    })
    f.context(1)
    const menu = f.menu(), focused = f.item('add')
    await update
    expect(f.menu()).toBe(menu)
    expect(f.surface.root.activeElement).toBe(focused)
    f.key('ArrowDown', {}, focused!)
    f.key('Enter', {}, f.item('duplicate')!)
    expect(f.onOperation).toHaveBeenCalledWith({ kind: 'duplicate', index: 1 })
  })

  it('clamps the menu to the viewport on all edges', () => {
    const original = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('slide-menu') ? new DOMRect(0, 0, 240, 170) : original.call(this)
    })
    const f = fixture()
    f.context(0, window.innerWidth - 1, window.innerHeight - 1)
    expect(f.menu()?.style.left).toBe(`${window.innerWidth - 240}px`)
    expect(f.menu()?.style.top).toBe(`${window.innerHeight - 170}px`)
    f.context(0, -10, -10)
    expect(f.menu()?.style.left).toBe('0px'); expect(f.menu()?.style.top).toBe('0px')
  })

  it('supports the keyboard context menu and rechecks readonly state at execution', () => {
    const f = fixture()
    expect(f.key('F10', { shiftKey: true }, f.slots[1]).defaultPrevented).toBe(true)
    expect(f.onSelect).toHaveBeenCalledWith(1)
    f.setReadonly(true)
    f.item('duplicate')!.click()
    expect(f.onOperation).not.toHaveBeenCalled()
  })
})

describe('slide list keyboard operations', () => {
  it.each([
    ['Delete', {}, { kind: 'delete', index: 1 }],
    ['Backspace', {}, { kind: 'delete', index: 1 }],
    ['d', { ctrlKey: true }, { kind: 'duplicate', index: 1 }],
    ['D', { ctrlKey: true }, { kind: 'duplicate', index: 1 }],
    ['m', { ctrlKey: true }, { kind: 'add', index: 1 }],
    ['ArrowUp', { ctrlKey: true }, { kind: 'move', index: 1, to: 0 }],
    ['ArrowDown', { ctrlKey: true }, { kind: 'move', index: 1, to: 2 }],
  ] as const)('requests %s while a thumbnail is focused', (key, options, operation) => {
    const f = fixture()
    expect(f.key(key, options, f.slots[1]).defaultPrevented).toBe(true)
    expect(f.onOperation.mock.calls).toEqual([[operation]])
  })

  it('guards readonly, boundaries, final-slide deletion and IME/modifier keys', () => {
    const f = fixture(1)
    f.key('Delete'); f.key('ArrowUp', { ctrlKey: true }); f.key('ArrowDown', { ctrlKey: true })
    f.key('d', { ctrlKey: true, isComposing: true })
    f.key('d', { ctrlKey: true, keyCode: 229 })
    f.key('d', { ctrlKey: true, altKey: true })
    f.key('d', { ctrlKey: true, shiftKey: true })
    f.setReadonly(true)
    f.key('m', { ctrlKey: true }); f.key('d', { ctrlKey: true })
    expect(f.onOperation).not.toHaveBeenCalled()
  })

  it('uses the active slide for shortcuts on the viewport itself', () => {
    const f = fixture()
    f.surface.setActive(2)
    f.key('m', { ctrlKey: true }, f.viewport)
    expect(f.onOperation).toHaveBeenCalledWith({ kind: 'add', index: 2 })
  })

  it('keeps keyboard focus on the moved slide so repeated shortcuts operate on that slide', () => {
    const f = fixture()
    f.slots[0]!.focus()
    f.onOperation.mockImplementation(operation => {
      f.surface.update({ ...f.deck }, operation.to)
    })
    f.key('ArrowDown', { ctrlKey: true })
    expect(f.surface.root.activeElement).toBe(f.slots[1])
    f.key('ArrowDown', { ctrlKey: true }, f.surface.root.activeElement as HTMLElement)
    expect(f.onOperation.mock.calls).toEqual([
      [{ kind: 'move', index: 0, to: 1 }], [{ kind: 'move', index: 1, to: 2 }],
    ])
  })

  it('restores focus to the remaining selected thumbnail when the last focused slide is deleted', () => {
    const f = fixture()
    f.slots[2]!.focus()
    f.surface.update({ ...f.deck, slides: f.deck.slides.slice(0, 2) }, 1)
    expect(f.surface.root.activeElement).toBe(f.slots[1])
    expect(f.slots[1]!.getAttribute('aria-current')).toBe('page')
  })
})

describe('slide list pointer reorder', () => {
  it.each(['during-selection', 'after-selection'] as const)('keeps dragging when a text-edit update arrives %s', async timing => {
    const f = fixture()
    const update = () => f.surface.update({
      ...f.deck, slides: ['<section>Edited text</section>', ...f.deck.slides.slice(1)],
    }, 0)
    let pending: Promise<void> | undefined
    f.onSelect.mockImplementation(() => {
      if (timing === 'during-selection') update()
      else pending = Promise.resolve().then(update)
    })
    f.pointer('pointerdown', 20, 20, f.rows[0])
    f.pointer('pointermove', 20, 40)
    await pending
    expect(f.surface.root.querySelector('.slide-drop-line')).not.toBeNull()
    f.pointer('pointermove', 20, 175)
    f.pointer('pointerup', 20, 175)
    expect(f.onOperation).toHaveBeenCalledWith({ kind: 'move', index: 0, to: 2 })
  })

  it('keeps movements below 4px as clicks and starts a drag at exactly 4px', () => {
    const f = fixture()
    f.pointer('pointerdown', 20, 20, f.rows[0])
    f.pointer('pointermove', 23, 20)
    expect(f.surface.root.querySelector('.slide-drop-line')).toBeNull()
    f.pointer('pointerup', 23, 20)
    f.slots[0]!.click()
    expect(f.onSelect).toHaveBeenCalledTimes(1)
    f.pointer('pointerdown', 20, 20, f.rows[0])
    f.pointer('pointermove', 24, 20)
    expect(f.surface.root.querySelector('.slide-drop-line')).not.toBeNull()
    f.pointer('pointerup', 24, 20)
    expect(f.onOperation).not.toHaveBeenCalled()
  })

  it.each([[0, 175, 2], [2, 5, 0], [0, 100, 1]])('maps row gaps to final move indices (%s to y=%s)', (index, y, to) => {
    const f = fixture()
    f.pointer('pointerdown', 20, index * 60 + 20, f.rows[index])
    f.pointer('pointermove', 20, y)
    const line = f.surface.root.querySelector<HTMLElement>('.slide-drop-line')!
    expect(line.dataset.boundary).toBe(String(to > index ? to + 1 : to))
    expect(getComputedStyle(line).height).toBe('2px')
    expect(getComputedStyle(line).pointerEvents).toBe('none')
    f.pointer('pointerup', 20, y)
    f.slots[index]!.click() // The synthetic click following pointerup must not select an old row.
    expect(f.onSelect).toHaveBeenCalledTimes(1)
    expect(f.onOperation.mock.calls).toEqual([[{ kind: 'move', index, to }]])
    expect(f.surface.root.querySelector('.slide-drop-line')).toBeNull()
    expect(frames.size).toBe(0)
  })

  it.each(['escape', 'cancel', 'outside', 'readonly', 'replace', 'blur', 'dispose'])('cancels drag without mutation on %s', mode => {
    const f = fixture()
    f.pointer('pointerdown', 20, 20, f.rows[0])
    f.pointer('pointermove', 20, 175)
    if (mode === 'escape') f.key('Escape')
    if (mode === 'cancel') f.pointer('pointercancel', 20, 175)
    if (mode === 'readonly') { f.setReadonly(true); f.surface.refreshOperations() }
    if (mode === 'replace') f.surface.update({ ...f.deck, slides: f.deck.slides.slice(0, 2) }, 0)
    if (mode === 'blur') window.dispatchEvent(new Event('blur'))
    if (mode === 'dispose') f.surface.dispose()
    f.pointer('pointerup', mode === 'outside' ? 250 : 20, 175)
    expect(f.onOperation).not.toHaveBeenCalled()
    expect(f.surface.root.querySelector('.slide-drop-line')).toBeNull()
    expect(frames.size).toBe(0)
  })

  it('autoscrolls near both edges, recomputes drop boundaries and leaves selection scrolling intact afterwards', () => {
    const f = fixture(12)
    f.pointer('pointerdown', 20, 20, f.rows[0])
    f.pointer('pointermove', 20, 198)
    f.tick()
    expect(f.viewport.scrollTop).toBeGreaterThan(0)
    const scroll = f.viewport.scrollTop
    f.pointer('pointermove', 20, 2)
    f.tick()
    expect(f.viewport.scrollTop).toBeLessThan(scroll)
    f.key('Escape')
    f.surface.setActive(11)
    expect(f.viewport.scrollTop).toBe(11 * 60 + 58 - 200)
  })

  it('ignores readonly drags and unrelated pointer IDs', () => {
    const f = fixture()
    f.setReadonly(true)
    f.pointer('pointerdown', 20, 20, f.rows[0]); f.pointer('pointermove', 20, 175)
    expect(f.surface.root.querySelector('.slide-drop-line')).toBeNull()
    f.setReadonly(false)
    f.pointer('pointerdown', 20, 20, f.rows[0]); f.pointer('pointermove', 20, 175, document, 2)
    f.pointer('pointerup', 20, 175, document, 2)
    expect(f.onOperation).not.toHaveBeenCalled()
    f.pointer('pointermove', 20, 175); f.pointer('pointerup', 20, 175)
    expect(f.onOperation).toHaveBeenCalledWith({ kind: 'move', index: 0, to: 2 })
  })
})
