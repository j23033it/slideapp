import type { TableCommand, TableOperation, TableReasonCode } from '../editing/tableOperations'
import { strings } from './strings'

type Command = TableCommand | 'delete-table'
export interface TableMenuTarget { elementId: string; row: number; column: number }
export interface TableMenuOptions {
  /** Host checks editing/selection state and current revision. */
  accepts(target: TableMenuTarget): boolean
  reason(target: TableMenuTarget, command: Command): TableReasonCode | undefined
  run(target: TableMenuTarget, command: Command): void
}

/** Install in the stage shadow root; dispose with the editor. */
export function attachTableMenu(root: ShadowRoot, options: TableMenuOptions): () => void {
  let menu: HTMLDivElement | undefined
  let returnFocus: HTMLElement | null = null
  const close = (restore: boolean) => { menu?.remove(); menu = undefined; if (restore) returnFocus?.focus({ preventScroll: true }); returnFocus = null }
  const outside = (event: Event) => { if (menu && !event.composedPath().includes(menu)) close(false) }
  const key = (event: KeyboardEvent) => {
    if (menu && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
  }
  const blur = () => close(false)
  const context = (raw: Event) => {
    const event = raw as MouseEvent
    const node = event.composedPath()[0]
    const cell = node instanceof Element ? node.closest<HTMLElement>('td, th') : null
    const table = cell?.closest<HTMLElement>('table[data-sm-element]')
    const tr = cell?.closest('tr')
    if (!cell || !table || !tr || cell.closest('table') !== table) return
    const elementId = table.dataset.smElement
    const rows = [...table.querySelectorAll('tr')].filter(row => row.closest('table') === table)
    const cells = [...tr.children].filter(child => child.matches('th,td'))
    const target = { elementId: elementId ?? '', row: rows.indexOf(tr), column: cells.indexOf(cell) }
    if (!elementId || target.row < 0 || target.column < 0 || !options.accepts(target)) return
    event.preventDefault(); event.stopPropagation(); close(false)
    returnFocus = root.activeElement as HTMLElement | null
    menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.dataset.smTableMenu = ''
    Object.assign(menu.style, { position: 'fixed', zIndex: '1000', boxSizing: 'border-box', minWidth: 'min(232px, 100vw)', maxWidth: '100vw', maxHeight: '100vh', overflow: 'auto', padding: '4px', border: '1px solid var(--sm-border)', borderRadius: '4px', background: 'var(--sm-surface)', color: 'var(--sm-text)', font: '12px/1.4 var(--sm-font-ui)' })
    const style = document.createElement('style')
    style.textContent = `.table-menu-item { display:flex; justify-content:space-between; align-items:center; gap:20px; box-sizing:border-box; width:100%; min-height:30px; padding:5px 8px; border:0; border-radius:2px; background:transparent; color:inherit; font:inherit; text-align:left } .table-menu-item:hover:enabled, .table-menu-item:focus-visible { background:var(--sm-hover) } .table-menu-item:focus-visible { outline:2px solid var(--sm-accent); outline-offset:-2px } .table-menu-item:disabled { color:var(--sm-text-muted); opacity:.5 }`
    menu.append(style)
    const commands: Command[] = ['insert-row-above', 'insert-row-below', 'insert-column-left', 'insert-column-right', 'delete-row', 'delete-column', 'delete-table']
    for (const command of commands) {
      const button = document.createElement('button'), reason = options.reason(target, command)
      button.type = 'button'; button.className = 'table-menu-item'; button.setAttribute('role', 'menuitem'); button.tabIndex = -1
      button.textContent = strings.tableOperations.labels[command]
      button.title = reason ? strings.tableOperations.reasons[reason] : strings.tableOperations.descriptions[command]
      button.disabled = !!reason
      button.addEventListener('click', () => { close(false); options.run(target, command) })
      const wrapper = document.createElement('div')
      wrapper.title = button.title
      wrapper.append(button)
      menu.append(wrapper)
    }
    menu.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const buttons = [...menu!.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.disabled)
        const index = buttons.indexOf(root.activeElement as HTMLButtonElement)
        buttons[index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); (root.activeElement as HTMLButtonElement | null)?.click() }
      else if (event.key === 'Tab') close(false)
      event.stopPropagation()
    })
    root.append(menu)
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(0, Math.min(event.clientX, innerWidth - rect.width))}px`
    menu.style.top = `${Math.max(0, Math.min(event.clientY, innerHeight - rect.height))}px`
    const first = menu.querySelector<HTMLButtonElement>('button:not(:disabled)')
    if (first) first.focus(); else { menu.tabIndex = -1; menu.focus() }
  }
  root.addEventListener('contextmenu', context)
  document.addEventListener('pointerdown', outside, true); document.addEventListener('click', outside, true)
  document.addEventListener('keydown', key, true); window.addEventListener('blur', blur)
  return () => { close(false); root.removeEventListener('contextmenu', context); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('click', outside, true); document.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur) }
}

export function tableMenuOperation(target: TableMenuTarget, command: TableCommand): TableOperation { return { ...target, command } }
