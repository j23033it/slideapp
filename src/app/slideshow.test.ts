import { describe, expect, it, vi } from 'vitest'
import { enterFullscreen, restoreFullscreen, slideshowAction, slideshowKey, snapshotDeck, startSlideshow, type SlideshowWindow } from './slideshow'

describe('slideshow', () => {
  it('starts at the first or current slide and clamps the starting point', () => {
    expect(startSlideshow(3, 2, 'first').index).toBe(0)
    expect(startSlideshow(3, 2, 'current').index).toBe(2)
    expect(startSlideshow(3, 9, 'current').index).toBe(2)
  })
  it('navigates, shows the end screen and returns or exits', () => {
    let state = startSlideshow(2, 0, 'first')
    expect(slideshowAction(state, 'previous').index).toBe(0)
    state = slideshowAction(state, 'next'); expect(state.index).toBe(1)
    state = slideshowAction(state, 'next'); expect(state.ended).toBe(true)
    expect(slideshowAction(state, 'previous')).toMatchObject({ index: 1, ended: false })
    expect(slideshowAction(state, 'next').exit).toBe(true)
    expect(slideshowAction(state, 'escape').exit).toBe(true)
    expect(slideshowAction(state, 'home')).toMatchObject({ index: 0, ended: false })
    expect(slideshowAction(state, 'end')).toMatchObject({ index: 1, ended: false })
  })
  it('accepts numbers and toggles blank screens, clearing them on movement', () => {
    let state = startSlideshow(12, 0, 'first')
    state = slideshowAction(state, { digit: '1' }); state = slideshowAction(state, { digit: '2' }); state = slideshowAction(state, 'enter')
    expect(state.index).toBe(11)
    state = slideshowAction(state, { digit: '0' }); state = slideshowAction(state, 'enter'); expect(state.index).toBe(11)
    state = slideshowAction(state, 'black'); expect(state.blank).toBe('black')
    state = slideshowAction(state, 'black'); expect(state.blank).toBeNull()
    state = slideshowAction(state, 'white'); expect(state.blank).toBe('white')
    state = slideshowAction(state, 'previous'); expect(state).toMatchObject({ blank: null, index: 10 })
  })
  it('maps all slideshow keys and rejects modified shortcuts', () => {
    const key = (key: string, ctrlKey = false) => slideshowKey({ key, ctrlKey, altKey: false, metaKey: false })
    for (const k of ['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'n']) expect(key(k)).toBe('next')
    for (const k of ['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp', 'P']) expect(key(k)).toBe('previous')
    for (const [k, action] of [['Enter', 'enter'], ['Home', 'home'], ['End', 'end'], ['Escape', 'escape'], ['b', 'black'], ['w', 'white']]) expect(key(k!)).toBe(action)
    expect(key('4')).toEqual({ digit: '4' }); expect(key('s', true)).toBeNull()
  })
  it('copies the rendered snapshot even if external changes replace or mutate the deck', () => {
    const source = { slides: ['first', 'second'], css: 'old', width: 1280, height: 720 }
    const copy = snapshotDeck(source)
    source.slides[0] = 'new'; source.css = 'new'
    expect(copy).toEqual({ slides: ['first', 'second'], css: 'old', width: 1280, height: 720 })
  })
  it.each([[true, true], [false, true], [false, false]])('restores fullscreen=%s maximized=%s', async (fullscreen, maximized) => {
    const window: SlideshowWindow = { isFullscreen: vi.fn(async () => fullscreen), isMaximized: vi.fn(async () => maximized), setFullscreen: vi.fn(async () => {}), maximize: vi.fn(async () => {}), unmaximize: vi.fn(async () => {}) }
    const before = await enterFullscreen(window)
    await restoreFullscreen(window, before)
    expect(window.setFullscreen).toHaveBeenCalledTimes(fullscreen ? 0 : 2)
    expect(window.maximize).toHaveBeenCalledTimes(!fullscreen && maximized ? 1 : 0)
  })
})
