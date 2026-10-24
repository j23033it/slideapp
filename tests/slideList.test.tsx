// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SlideList } from '../src/app/SlideList'
import type { RenderedDeck } from '../src/marp/renderer'
import { strings } from '../src/app/strings'

vi.mock('@marp-team/marp-core/browser', () => ({ default: () => ({ update() {}, cleanup() {} }) }))
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  container = document.createElement('div')
  document.body.append(container)
})
afterEach(() => { act(() => render(null, container)); container.remove(); vi.unstubAllGlobals() })
const deck: RenderedDeck = { slides: ['<section>one</section>', '<section>two</section>'], css: '', width: 1280, height: 720 }

it('places add before collapse, requests insertion after the displayed slide and retains collapse', () => {
  const operation = vi.fn(), collapse = vi.fn()
  act(() => render(<SlideList deck={deck} version={1} current={1} onSelect={() => {}} onCollapse={collapse} onSlideOperation={operation} />, container))
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('.sidebar-footer button')]
  expect(buttons[0]!.getAttribute('aria-label')).toBe(strings.slideOperations.labels.add)
  buttons[0]!.click(); buttons[1]!.click()
  expect(operation).toHaveBeenCalledWith({ kind: 'add', index: 1 })
  expect(collapse).toHaveBeenCalledOnce()
})

it.each(['missing-handler', 'readonly', 'no-document'])('disables insertion for %s', mode => {
  const operation = vi.fn()
  act(() => render(<SlideList deck={mode === 'no-document' ? null : deck} version={1} current={0} onSelect={() => {}} onCollapse={() => {}}
    onSlideOperation={mode === 'missing-handler' ? undefined : operation} readOnly={mode === 'readonly'} />, container))
  const add = container.querySelector<HTMLButtonElement>('.sidebar-footer button')!
  expect(add.disabled).toBe(true)
  add.click()
  expect(operation).not.toHaveBeenCalled()
})

it('uses latest callbacks and readonly state without recreating the thumbnail DOM', () => {
  const first = vi.fn(), second = vi.fn()
  const draw = (callback: typeof first, readOnly = false) => act(() => render(
    <SlideList deck={deck} version={1} current={0} onSelect={() => {}} onCollapse={() => {}} onSlideOperation={callback} readOnly={readOnly} />, container))
  draw(first)
  const host = container.querySelector<HTMLElement>('.slide-list-host')!
  const slot = host.shadowRoot!.querySelector<HTMLElement>('.slot')!
  draw(second)
  expect(host.shadowRoot!.querySelector('.slot')).toBe(slot)
  slot.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }))
  expect(second).toHaveBeenCalledWith({ kind: 'duplicate', index: 0 })
  expect(first).not.toHaveBeenCalled()
  draw(second, true)
  slot.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }))
  expect(second).toHaveBeenCalledOnce()
})
