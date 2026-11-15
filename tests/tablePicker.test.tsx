// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { expect, it, vi } from 'vitest'
import { TablePicker } from '../src/app/TablePicker'

it('selects a bounded size with the keyboard and inserts it', () => {
  const host = document.createElement('div'); document.body.append(host)
  const insert = vi.fn(), open = vi.fn()
  act(() => render(<TablePicker onOpen={open} onInsert={insert} />, host))
  act(() => host.querySelector('button')!.click())
  expect(open).toHaveBeenCalledOnce()
  const grid = host.querySelector('[role="grid"]')!
  act(() => { grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
  expect(host.textContent).toContain('2 × 3 の表')
  act(() => { grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  expect(insert).toHaveBeenCalledWith(2, 3)
  expect(host.querySelector('[role="grid"]')).toBeNull()
  act(() => render(null, host)); host.remove()
})
