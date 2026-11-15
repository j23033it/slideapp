import { useEffect, useRef, useState } from 'preact/hooks'
import browser from '@marp-team/marp-core/browser'
import { applyJapaneseFonts, ensureDocumentImports, splitCssImports } from '../marp/fonts'
import type { RenderedDeck } from '../marp/renderer'
import { slideshowAction, slideshowKey, startSlideshow, type SlideshowAction, type SlideshowStart } from './slideshow'
import { strings } from './strings'

export interface SlideshowProps {
  /** A snapshot taken after finishing editing. Never replace it during the show. */
  deck: RenderedDeck
  current: number
  start: SlideshowStart
  onExit(index: number): void
  onIndex?(index: number): void
}

export function Slideshow({ deck, current, start, onExit, onIndex }: SlideshowProps) {
  const [state, setState] = useState(() => startSlideshow(deck.slides.length, current, start))
  const stateRef = useRef(state)
  const exitRef = useRef(onExit)
  const hostRef = useRef<HTMLDivElement>(null)
  const indexRef = useRef(onIndex)
  indexRef.current = onIndex
  const [hidden, setHidden] = useState(false)
  stateRef.current = state
  exitRef.current = onExit

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    const { css, imports } = splitCssImports(deck.css)
    ensureDocumentImports(imports)
    const style = document.createElement('style')
    style.textContent = css
    const base = document.createElement('style')
    base.textContent = `:host{display:flex;width:100%;height:100%;align-items:center;justify-content:center;overflow:hidden;user-select:none;-webkit-user-select:none}.slot{position:relative;overflow:hidden;flex:none}.frame{position:absolute;top:0;left:0;transform-origin:top left}.frame>div.marpit,.frame div.marpit>svg[data-marpit-svg]{display:block;width:100%;height:100%}*{user-select:none!important;-webkit-user-select:none!important}`
    const slot = document.createElement('div')
    slot.className = 'slot'
    const frame = document.createElement('div')
    frame.className = 'frame'
    frame.style.width = `${deck.width}px`; frame.style.height = `${deck.height}px`
    slot.append(frame); root.append(style, base, slot)
    const marp = browser(root)
    const resize = () => {
      const scale = Math.min(host.clientWidth / deck.width, host.clientHeight / deck.height)
      const valid = Number.isFinite(scale) && scale > 0 ? scale : 0
      slot.style.width = `${deck.width * valid}px`; slot.style.height = `${deck.height * valid}px`
      frame.style.transform = `scale(${valid})`
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host)
    const render = (index: number) => {
      frame.innerHTML = deck.slides[index] ?? ''
      applyJapaneseFonts(root)
      marp.update()
      resize()
    }
    render(stateRef.current.index)
    const listener = (event: Event) => render((event as CustomEvent<number>).detail)
    host.addEventListener('slideshow-slide', listener)
    return () => { host.removeEventListener('slideshow-slide', listener); observer.disconnect(); marp.cleanup(); root.replaceChildren() }
  }, [deck])

  useEffect(() => {
    hostRef.current?.dispatchEvent(new CustomEvent('slideshow-slide', { detail: state.index }))
  }, [state.index])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const move = () => { setHidden(false); clearTimeout(timer); timer = setTimeout(() => setHidden(true), 2000) }
    const act = (action: SlideshowAction) => {
      const next = slideshowAction(stateRef.current, action)
      stateRef.current = next
      indexRef.current?.(next.index)
      if (next.exit) exitRef.current(next.index)
      else setState(next)
    }
    const key = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopImmediatePropagation()
      if (event.isComposing || event.keyCode === 229) return
      const action = slideshowKey(event)
      if (action) act(action)
    }
    const wheel = (event: WheelEvent) => { event.preventDefault(); event.stopPropagation(); if (event.deltaY) act(event.deltaY > 0 ? 'next' : 'previous') }
    const click = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); if (event.button === 0) act('next') }
    const context = (event: Event) => { event.preventDefault(); event.stopPropagation() }
    const host = hostRef.current?.parentElement
    if (!host) return
    window.addEventListener('keydown', key, true)
    host.addEventListener('wheel', wheel, { passive: false })
    host.addEventListener('click', click)
    host.addEventListener('contextmenu', context)
    host.addEventListener('mousemove', move)
    move()
    return () => { clearTimeout(timer); window.removeEventListener('keydown', key, true); host.removeEventListener('wheel', wheel); host.removeEventListener('click', click); host.removeEventListener('contextmenu', context); host.removeEventListener('mousemove', move) }
  }, [])

  return <div role="region" aria-label={strings.toolbar.slideshow} style={{ position: 'fixed', inset: 0, zIndex: 2147483647, background: state.blank === 'white' ? '#fff' : '#000', color: '#fff', cursor: hidden ? 'none' : 'default', userSelect: 'none' }}>
    <div ref={hostRef} style={{ width: '100%', height: '100%', display: state.blank || state.ended ? 'none' : 'block', pointerEvents: 'none' }} />
    {state.ended && !state.blank ? <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', font: '16px Segoe UI, sans-serif' }}>{strings.slideshow.end}</div> : null}
  </div>
}
