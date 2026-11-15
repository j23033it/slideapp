// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { beginHandleDrag } from '../src/app/handleDrag'

describe('handle drag', () => {
  it('converts viewport movement to slide coordinates and commits once', () => {
    const frame = document.createElement('div')
    Object.defineProperties(frame, { offsetWidth: { value: 1000 }, offsetHeight: { value: 500 } })
    frame.getBoundingClientRect = () => ({ width: 500, height: 250 } as DOMRect)
    const move = vi.fn(), finish = vi.fn(), cancel = vi.fn()
    beginHandleDrag(new PointerEvent('pointerdown', { pointerId: 4, clientX: 10, clientY: 20 }), frame, { move, finish, cancel })
    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 4, clientX: 30, clientY: 35 }))
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 4 }))
    expect(move).toHaveBeenCalledWith(40, 30)
    expect(finish).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
  })
  it('cancels with Escape and suppresses the following click', () => {
    const frame = document.createElement('div')
    Object.defineProperties(frame, { offsetWidth: { value: 100 }, offsetHeight: { value: 100 } })
    frame.getBoundingClientRect = () => ({ width: 50, height: 50 } as DOMRect)
    const finish = vi.fn(), cancel = vi.fn(), click = vi.fn()
    document.addEventListener('click', click, { once: true })
    beginHandleDrag(new PointerEvent('pointerdown', { pointerId: 2 }), frame, { move: () => {}, finish, cancel })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }))
    document.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(cancel).toHaveBeenCalledOnce()
    expect(finish).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
    document.removeEventListener('click', click)
  })
})
