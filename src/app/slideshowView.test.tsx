// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Slideshow } from './SlideshowView'

const marp = vi.hoisted(() => ({ roots: [] as ShadowRoot[], update: vi.fn(), cleanup: vi.fn() }))
vi.mock('@marp-team/marp-core/browser', () => ({ default: (root: ShadowRoot) => { marp.roots.push(root); return { update: marp.update, cleanup: marp.cleanup } } }))
const deck = { slides: ['<div class="marpit">first</div>', '<div class="marpit">second</div>'], css: '', width: 1280, height: 720 }
const host = document.createElement('div')
document.body.append(host)
afterEach(() => { act(() => render(null, host)); vi.useRealTimers(); marp.roots.length = 0 })
function key(key: string, extra: KeyboardEventInit = {}) { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); window.dispatchEvent(event); return event }

describe('slideshow surface', () => {
  it('uses the rendering shadow root, consumes shortcuts and operates click, wheel and escape', () => {
    const exit = vi.fn(), index = vi.fn(), later = vi.fn()
    act(() => render(<Slideshow deck={deck} current={0} start="first" onExit={exit} onIndex={index} />, host))
    expect(marp.roots.at(-1)?.querySelector('.frame')?.textContent).toBe('first')
    window.addEventListener('keydown', later)
    const event = key('s', { ctrlKey: true })
    expect(event.defaultPrevented).toBe(true); expect(later).not.toHaveBeenCalled()
    const overlay = host.firstElementChild as HTMLElement
    act(() => { overlay.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true, cancelable: true })) })
    expect(index).toHaveBeenLastCalledWith(1)
    act(() => { overlay.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true, cancelable: true })) })
    expect(index).toHaveBeenLastCalledWith(0)
    act(() => overlay.click()); act(() => overlay.click())
    expect(overlay.textContent).toContain('スライドショーの最後です')
    act(() => overlay.click()); expect(exit).toHaveBeenCalledWith(1)
    const context = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); overlay.dispatchEvent(context); expect(context.defaultPrevented).toBe(true)
    act(() => { key('Escape') }); expect(exit).toHaveBeenCalledWith(1)
    window.removeEventListener('keydown', later)
  })
  it('hides the pointer after two seconds and restores it on movement', () => {
    vi.useFakeTimers()
    act(() => render(<Slideshow deck={deck} current={0} start="first" onExit={() => {}} />, host))
    const overlay = host.firstElementChild as HTMLElement
    act(() => { vi.advanceTimersByTime(2000) }); expect(overlay.style.cursor).toBe('none')
    act(() => { overlay.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) }); expect(overlay.style.cursor).toBe('default')
  })
})
