import type { RenderedDeck } from '../marp/renderer'

export type SlideshowStart = 'first' | 'current'
export interface SlideshowState { index: number; total: number; blank: 'black' | 'white' | null; digits: string; ended: boolean; exit: boolean }
export type SlideshowAction = 'next' | 'previous' | 'home' | 'end' | 'black' | 'white' | 'enter' | 'escape' | { digit: string }

export function snapshotDeck(deck: RenderedDeck): RenderedDeck {
  return { ...deck, slides: [...deck.slides] }
}
export function startSlideshow(total: number, current: number, start: SlideshowStart): SlideshowState {
  const count = Math.max(0, total)
  return { index: start === 'first' ? 0 : Math.max(0, Math.min(current, count - 1)), total: count, blank: null, digits: '', ended: count === 0, exit: false }
}
export function slideshowAction(state: SlideshowState, action: SlideshowAction): SlideshowState {
  if (state.exit) return state
  if (typeof action !== 'string') return { ...state, digits: (state.digits + action.digit).slice(-12) }
  if (action === 'escape') return { ...state, exit: true }
  if (action === 'black' || action === 'white') return { ...state, blank: state.blank === action ? null : action, digits: '' }
  if (action === 'enter' && state.digits) {
    const page = Number(state.digits)
    return { ...state, digits: '', blank: null, ...(page >= 1 && page <= state.total ? { index: page - 1, ended: false } : {}) }
  }
  if (action === 'enter') action = 'next'
  const next = { ...state, blank: null, digits: '' }
  if (action === 'next') {
    if (state.ended) return { ...next, exit: true }
    if (state.index >= state.total - 1) return { ...next, ended: true }
    return { ...next, index: state.index + 1 }
  }
  if (action === 'previous') return { ...next, ended: false, index: state.ended ? Math.max(0, state.total - 1) : Math.max(0, state.index - 1) }
  if (action === 'home') return { ...next, ended: state.total === 0, index: 0 }
  if (action === 'end') return { ...next, ended: state.total === 0, index: Math.max(0, state.total - 1) }
  return state
}
export function slideshowKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>): SlideshowAction | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null
  const key = event.key.toLowerCase()
  if (/^[0-9]$/.test(key)) return { digit: key }
  if (['arrowright', 'arrowdown', ' ', 'pagedown', 'n'].includes(key)) return 'next'
  if (['arrowleft', 'arrowup', 'backspace', 'pageup', 'p'].includes(key)) return 'previous'
  if (key === 'enter') return 'enter'
  if (key === 'home' || key === 'end') return key
  if (key === 'b') return 'black'
  if (key === 'w') return 'white'
  if (key === 'escape') return 'escape'
  return null
}

export interface SlideshowWindow {
  isFullscreen(): Promise<boolean>
  isMaximized(): Promise<boolean>
  setFullscreen(value: boolean): Promise<void>
  maximize(): Promise<void>
  unmaximize(): Promise<void>
}
export interface WindowState { fullscreen: boolean; maximized: boolean }
export async function enterFullscreen(window: SlideshowWindow): Promise<WindowState> {
  const fullscreen = await window.isFullscreen()
  const maximized = await window.isMaximized()
  if (!fullscreen) await window.setFullscreen(true)
  return { fullscreen, maximized }
}
export async function restoreFullscreen(window: SlideshowWindow, state: WindowState): Promise<void> {
  if (state.fullscreen) return
  await window.setFullscreen(false)
  if (state.maximized) await window.maximize()
  else if (await window.isMaximized()) await window.unmaximize()
}
