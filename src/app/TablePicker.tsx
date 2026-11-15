import { useEffect, useRef, useState } from 'preact/hooks'
import { strings } from './strings'

export interface TablePickerProps {
  disabled?: boolean
  disabledReason?: string
  onOpen?: () => void
  onInsert: (columns: number, rows: number) => void
}

export function TablePicker({ disabled = false, disabledReason, onOpen, onInsert }: TablePickerProps) {
  const [open, setOpen] = useState(false)
  const [size, setSize] = useState({ columns: 1, rows: 2 })
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  useEffect(() => {
    if (!open) return
    grid.current?.focus()
    const close = (event: PointerEvent) => { if (!event.composedPath().includes(root.current!)) setOpen(false) }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [open])
  const insert = () => { setOpen(false); onInsert(size.columns, size.rows) }
  return <div ref={root} title={disabledReason} style={{ position: 'relative' }}>
    <button ref={trigger} type="button" class="toolbar-button" title={disabledReason ?? strings.toolbar.tableTitle}
      disabled={disabled} aria-expanded={open} aria-haspopup="dialog" onPointerDown={() => { if (!open) onOpen?.() }} onClick={event => { if (!open && event.detail === 0) onOpen?.(); setOpen(!open) }}>{strings.toolbar.table}</button>
    {open && <div role="dialog" aria-label={strings.tableOperations.sizeDescription}
      style={{ position: 'absolute', zIndex: 1000, top: '100%', left: 0, padding: 8, background: 'var(--sm-surface)', color: 'var(--sm-text)', border: '1px solid var(--sm-border)', borderRadius: 4 }}>
      <div aria-live="polite">{strings.tableOperations.size(size.columns, size.rows)}</div>
      <div ref={grid} role="grid" tabIndex={0} aria-label={strings.tableOperations.sizeDescription}
        style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 20px)', gap: 3, marginTop: 6 }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return }
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); insert(); return }
          const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
          const move = delta[event.key]; if (!move) return
          event.preventDefault(); event.stopPropagation()
          setSize(previous => ({ columns: Math.max(1, Math.min(10, previous.columns + move[0])), rows: Math.max(2, Math.min(8, previous.rows + move[1])) }))
        }}>
        {Array.from({ length: 80 }, (_, index) => {
          const columns = index % 10 + 1, rows = Math.floor(index / 10) + 1
          return <button type="button" role="gridcell" tabIndex={-1} aria-label={strings.tableOperations.size(columns, Math.max(2, rows))}
            aria-selected={columns <= size.columns && rows <= size.rows}
            style={{ width: 20, height: 20, padding: 0, border: '1px solid var(--sm-border)', background: columns <= size.columns && rows <= size.rows ? 'var(--sm-accent)' : 'transparent' }}
            onPointerEnter={() => setSize({ columns, rows: Math.max(2, rows) })}
            onClick={() => { setOpen(false); onInsert(columns, Math.max(2, rows)) }} />
        })}
      </div>
    </div>}
  </div>
}
