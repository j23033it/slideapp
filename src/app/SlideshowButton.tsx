import { useEffect, useRef, useState } from 'preact/hooks'
import type { SlideshowStart } from './slideshow'
import { strings } from './strings'

/** Toolbar split button; the menu follows the existing slide/table menus. */
export function SlideshowButton({ disabled, onStart }: { disabled: boolean; onStart(start: SlideshowStart): void }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const element = menu.current
    if (!element) return
    const rect = button.current!.getBoundingClientRect()
    const size = element.getBoundingClientRect()
    element.style.left = `${Math.max(0, Math.min(rect.left, window.innerWidth - size.width))}px`
    element.style.top = `${Math.max(0, Math.min(rect.bottom, window.innerHeight - size.height))}px`
    element.querySelector<HTMLButtonElement>('button')?.focus()
    const outside = (event: Event) => { if (!event.composedPath().includes(element) && !event.composedPath().includes(button.current!)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); button.current?.focus() } }
    const blur = () => setOpen(false)
    document.addEventListener('pointerdown', outside, true); document.addEventListener('click', outside, true); document.addEventListener('keydown', key, true); window.addEventListener('blur', blur)
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('click', outside, true); document.removeEventListener('keydown', key, true); window.removeEventListener('blur', blur) }
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <span style={{ display: 'inline-flex' }}>
    <button type="button" class="toolbar-button" disabled={disabled} title={disabled ? strings.toolbar.noFile : strings.toolbar.slideshowTitle} onClick={() => onStart('first')}>{strings.toolbar.slideshow}</button>
    <button ref={button} type="button" class="toolbar-button" disabled={disabled} title={disabled ? strings.toolbar.noFile : strings.toolbar.slideshow} aria-label={strings.toolbar.slideshow} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>▼</button>
    {open && !disabled ? <div ref={menu} role="menu" style={{ position: 'fixed', zIndex: 1000, boxSizing: 'border-box', minWidth: 'min(232px, 100vw)', maxWidth: '100vw', maxHeight: '100vh', overflow: 'auto', padding: '4px', border: '1px solid var(--sm-border)', borderRadius: '4px', background: 'var(--sm-surface)', color: 'var(--sm-text)', font: '12px/1.4 var(--sm-font-ui)' }} onKeyDown={event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]; const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus() }
      else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); (document.activeElement as HTMLButtonElement)?.click() }
      else if (event.key === 'Tab') setOpen(false)
      event.stopPropagation()
    }}>
      <style>{`.slideshow-menu-item{display:flex;justify-content:space-between;align-items:center;gap:20px;box-sizing:border-box;width:100%;min-height:30px;padding:5px 8px;border:0;border-radius:2px;background:transparent;color:inherit;font:inherit;text-align:left}.slideshow-menu-item:hover,.slideshow-menu-item:focus-visible{background:var(--sm-hover)}.slideshow-menu-item:focus-visible{outline:2px solid var(--sm-accent);outline-offset:-2px}.slideshow-menu-item kbd{color:var(--sm-text-muted);font:inherit;white-space:nowrap}`}</style>
      {([['first', strings.slideshow.first, strings.slideshow.firstTitle, 'F5'], ['current', strings.slideshow.current, strings.slideshow.currentTitle, 'Shift+F5']] as const).map(([kind, label, title, shortcut]) => <button type="button" class="slideshow-menu-item" role="menuitem" tabIndex={-1} title={title} onClick={() => { setOpen(false); button.current?.focus(); onStart(kind) }}><span>{label}</span><kbd>{shortcut}</kbd></button>)}
    </div> : null}
  </span>
}
