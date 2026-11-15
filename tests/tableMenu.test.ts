// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { attachTableMenu } from '../src/app/tableMenu'

describe('table context menu', () => {
  it('shows refusal reasons, navigates enabled actions and closes on Escape', () => {
    const host = document.createElement('div'); document.body.append(host)
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<table data-sm-element="e1"><thead><tr><th tabindex="0">a</th></tr></thead></table>'
    const cell = root.querySelector('th')!; cell.focus()
    const run = vi.fn()
    const dispose = attachTableMenu(root, { accepts: () => true, reason: (_, command) => command === 'delete-row' ? 'table-header-row' : undefined, run })
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, clientX: 5, clientY: 5 }))
    const menu = root.querySelector('[role="menu"]')!
    const buttons = [...menu.querySelectorAll('button')]
    expect(buttons).toHaveLength(7)
    expect(buttons[4].disabled).toBe(true)
    expect(buttons[4].title).toBe('見出し行は挿入・削除できません')
    expect(root.activeElement).toBe(buttons[0])
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(root.activeElement).toBe(buttons[1])
    buttons[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(run).toHaveBeenCalledWith({ elementId: 'e1', row: 0, column: 0 }, 'insert-row-below')
    cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(root.querySelector('[role="menu"]')).toBeNull()
    dispose(); host.remove()
  })
})
