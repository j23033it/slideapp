// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEventHandlers } from '../platform/types'
import type { EditorSession } from './session'

const probe = vi.hoisted(() => ({
  handlers: null as FileEventHandlers | null,
  close: null as (() => void) | null,
  session: null as EditorSession | null,
  release: null as (() => void) | null,
  fullscreen: false,
  events: [] as string[],
}))
vi.mock('../platform', async importOriginal => {
  const actual = await importOriginal<typeof import('../platform')>()
  return { ...actual, platform: {
    settingsGet: async () => ({ ...actual.DEFAULT_SETTINGS, checkUpdatesOnStartup: false, openTabs: ['C:\\test.md'], activeTab: 'C:\\test.md' }),
    settingsSet: async () => {}, recentFilesGet: async () => [], recentFilesAdd: async () => [],
    openFile: async () => ({ text: '# Before\n', hasBom: false, hash: 'one', mtime: 1 }),
    readThemeConfig: async () => ({ themes: [], warnings: [] }), convertFileSrc: (s: string) => s,
    stopWatching: async () => {}, setWindowTitle: async () => {},
    listenFileEvents: async (handlers: FileEventHandlers) => { probe.handlers = handlers; return () => {} },
    onCloseRequested: async (handler: () => void) => { probe.close = handler; return () => {} },
    forceClose: async () => { probe.events.push('close') },
    checkForUpdate: async () => ({ version: '2', currentVersion: '1', notes: null, date: null }),
    downloadAndInstall: async () => { probe.events.push('install') }, relaunch: async () => {},
  } }
})
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  isFullscreen: async () => probe.fullscreen, isMaximized: async () => false,
  setFullscreen: async (value: boolean) => {
    if (value) { probe.fullscreen = true; return }
    probe.events.push('restore-start')
    await new Promise<void>(resolve => { probe.release = resolve })
    probe.fullscreen = false; probe.events.push('restore-end')
  }, unmaximize: async () => {}, maximize: async () => {},
}) }))
vi.mock('@marp-team/marp-core/browser', () => ({ default: () => ({ update() {}, cleanup() {} }) }))
vi.mock('./SlideList', async () => {
  const { h } = await import('preact')
  return { SlideList: () => h('div', {}) }
})
vi.mock('./SlideStage', async () => {
  const { h } = await import('preact')
  const { useEffect } = await import('preact/hooks')
  return { SlideStage: (props: { session: EditorSession; apiRef: { current: unknown } }) => {
    probe.session = props.session
    useEffect(() => {
      props.apiRef.current = { endEditing() {}, isComposing: () => false, deferWhileComposing: () => false }
      return () => { props.apiRef.current = null }
    }, [props.apiRef])
    return h('div', { 'data-testid': 'stage' }, props.session.model.text)
  } }
})
import { App } from './App'
import { UPDATE_CHECK_EVENT } from './UpdateNotice'

const host = document.createElement('div')
document.body.append(host)
async function until(predicate: () => unknown) {
  for (let i = 0; i < 100; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
    if (predicate()) return
  }
  throw new Error('Timed out waiting for App state')
}
function button(text: string) {
  const result = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === text)
  if (!result) throw new Error(`Missing button: ${text}`)
  return result
}
async function begin() {
  await until(() => probe.session && probe.close && probe.handlers && button('スライドショー'))
  act(() => button('スライドショー').click())
  await until(() => probe.fullscreen && document.querySelector('[role="region"][aria-label="スライドショー"]'))
}
beforeEach(() => { probe.handlers = null; probe.close = null; probe.session = null; probe.release = null; probe.fullscreen = false; probe.events = []; act(() => render(<App />, host)) })
afterEach(() => { probe.release?.(); act(() => render(null, host)) })
describe('App slideshow integration', () => {
  it('restores the window before showing the unsaved close confirmation', async () => {
    await begin()
    probe.session!.model.edit({ start: 0, end: 0, insert: 'dirty ' })
    act(() => probe.close!())
    await until(() => probe.release)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(probe.events).toEqual(['restore-start'])
    await act(async () => { probe.release!() })
    await until(() => document.querySelector('[role="dialog"]'))
    expect(document.querySelector('[role="region"][aria-label="スライドショー"]')).toBeNull()
    expect(probe.events).toEqual(['restore-start', 'restore-end'])
    expect(probe.events).not.toContain('close')
  })
  it('restores the window before installing an update', async () => {
    await begin()
    act(() => { window.dispatchEvent(new Event(UPDATE_CHECK_EVENT)) })
    await until(() => [...document.querySelectorAll('button')].some(item => item.textContent === '更新して再起動'))
    act(() => button('更新して再起動').click())
    await until(() => probe.release)
    expect(probe.events).toEqual(['restore-start'])
    await act(async () => { probe.release!() })
    await until(() => probe.events.includes('install'))
    expect(probe.events).toEqual(['restore-start', 'restore-end', 'install'])
    expect(document.querySelector('[role="region"][aria-label="スライドショー"]')).toBeNull()
  })
  it('keeps external changes pending until the slideshow ends', async () => {
    await begin()
    act(() => probe.handlers!.changed({ path: 'C:\\test.md', text: '# After\n', hasBom: false, hash: 'two', mtime: 2 }))
    expect(probe.session!.model.text).toContain('Before')
    expect(document.querySelector('[role="region"]')!.firstElementChild!.shadowRoot!.textContent).toContain('Before')
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    await until(() => probe.release)
    expect(probe.session!.model.text).toContain('Before')
    await act(async () => { probe.release!() })
    await until(() => probe.session!.model.text.includes('After'))
    expect(document.querySelector('[data-testid="stage"]')!.textContent).toContain('After')
  })
})
