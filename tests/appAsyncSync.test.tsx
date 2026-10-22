// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../src/app/App'
import { editorSessionSaveState } from '../src/app/session'
import type { SlideStageProps } from '../src/app/SlideStage'
import { strings } from '../src/app/strings'
import { DEFAULT_SETTINGS, platform } from '../src/platform'
import type { FileEventHandlers, SaveOutcome } from '../src/platform/types'

const captured = vi.hoisted(() => ({ stage: null as SlideStageProps | null }))
vi.mock('../src/app/SlideStage', () => ({
  SlideStage: (props: SlideStageProps) => {
    captured.stage = props
    return null
  },
}))
vi.mock('../src/app/SlideList', () => ({ SlideList: () => null }))
vi.mock('../src/platform', async (original) => ({
  ...await original<typeof import('../src/platform')>(),
  platform: {
    settingsGet: vi.fn(), settingsSet: vi.fn(), recentFilesGet: vi.fn(),
    recentFilesAdd: vi.fn(), setWindowTitle: vi.fn(), listenFileEvents: vi.fn(),
    onCloseRequested: vi.fn(), stopWatching: vi.fn(), pickMarkdownFile: vi.fn(),
    openFile: vi.fn(), readThemeConfig: vi.fn(), convertFileSrc: vi.fn(),
    saveFile: vi.fn(), writeNewFile: vi.fn(), forceClose: vi.fn(),
  },
}))

const path = 'C:\\deck\\deck.md'
const disk = (text: string, hash = text) => ({ text, hash, hasBom: false, mtime: 1 })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

let host: HTMLDivElement
let events: FileEventHandlers
async function flush(action: () => void = () => {}) {
  await act(async () => { action(); await new Promise((resolve) => setTimeout(resolve, 0)) })
}
function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text)
  expect(button, text).toBeDefined()
  button!.click()
}
function session() { return captured.stage!.session }
async function editMine() {
  await flush(() => {
    const current = session()
    const edit = { start: 0, end: current.model.text.length, insert: 'mine' }
    const { analysis } = current.renderer.analyze('mine', current.baseDir)
    captured.stage!.callbacks.onCommit({ ok: true, edit, analysis, newText: 'mine', escaped: false }, {})
  })
}

beforeEach(async () => {
  vi.resetAllMocks()
  captured.stage = null
  vi.mocked(platform.settingsGet).mockResolvedValue(DEFAULT_SETTINGS)
  vi.mocked(platform.settingsSet).mockResolvedValue()
  vi.mocked(platform.recentFilesGet).mockResolvedValue([])
  vi.mocked(platform.recentFilesAdd).mockResolvedValue([path])
  vi.mocked(platform.setWindowTitle).mockResolvedValue()
  vi.mocked(platform.stopWatching).mockResolvedValue()
  vi.mocked(platform.onCloseRequested).mockResolvedValue(() => {})
  vi.mocked(platform.listenFileEvents).mockImplementation(async (handlers) => {
    events = handlers
    return () => {}
  })
  vi.mocked(platform.pickMarkdownFile).mockResolvedValue(path)
  vi.mocked(platform.openFile).mockResolvedValue(disk('base'))
  vi.mocked(platform.readThemeConfig).mockResolvedValue({ themes: [], warnings: [] })
  host = document.createElement('div')
  document.body.append(host)
  await flush(() => render(<App />, host))
  await flush(() => click(strings.toolbar.open))
  expect(captured.stage).not.toBeNull()
  await editMine()
})
afterEach(async () => {
  await flush(() => render(null, host))
  host.remove()
})

describe('App asynchronous disk callbacks', () => {
  it.each(['changed', 'removed', 'unreadable'] as const)(
    'preserves a newer %s notification delivered before save success', async (type) => {
      const save = deferred<SaveOutcome>()
      vi.mocked(platform.saveFile).mockReturnValue(save.promise)
      await flush(() => click(strings.toolbar.save))
      expect(platform.saveFile).toHaveBeenCalledWith(path, 'mine', false, 'base')
      await flush(() => {
        if (type === 'changed') events.changed({ path, ...disk('external-v2') })
        else if (type === 'removed') events.removed({ path })
        else events.unreadable({ path, message: 'locked' })
      })
      const banner = host.querySelector('[role="status"]')!.textContent
      await flush(() => save.resolve({ ok: true, hash: 'mine', mtime: 2 }))
      expect(session().model.serialize()).toBe('mine')
      expect(editorSessionSaveState(session())).toBe(type === 'changed' ? 'conflict' : 'dirty')
      expect(host.querySelector('[role="status"]')!.textContent).toBe(banner)
      expect(session().model.diskHash).toBe('base')
    },
  )

  it('reconciles a notification matching the successful save hash', async () => {
    const save = deferred<SaveOutcome>()
    vi.mocked(platform.saveFile).mockReturnValue(save.promise)
    await flush(() => click(strings.toolbar.save))
    await flush(() => events.changed({ path, ...disk('mine') }))
    expect(editorSessionSaveState(session())).toBe('conflict')
    await flush(() => save.resolve({ ok: true, hash: 'mine', mtime: 2 }))
    expect(editorSessionSaveState(session())).toBe('clean')
    expect(host.querySelector('.banner')).toBeNull()
  })

  it('keeps v2 conflict when it arrives while the mine copy of v1 is pending', async () => {
    await flush(() => events.changed({ path, ...disk('external-v1') }))
    vi.mocked(platform.openFile).mockResolvedValue(disk('external-v1'))
    const copy = deferred<SaveOutcome>()
    vi.mocked(platform.writeNewFile).mockReturnValue(copy.promise)
    await flush(() => click(strings.banner.conflict.mine))
    expect(platform.writeNewFile).toHaveBeenCalledWith('C:\\deck\\deck.mine.md', 'mine', false)
    await flush(() => events.changed({ path, ...disk('external-v2') }))
    await flush(() => copy.resolve({ ok: true, hash: 'mine', mtime: 2 }))
    expect(session().model.serialize()).toBe('mine')
    expect(editorSessionSaveState(session())).toBe('conflict')
    expect(host.textContent).toContain(strings.banner.conflict.message)
    // The next choice must compare against the v2 banner, not the stale v1 read.
    vi.mocked(platform.openFile).mockResolvedValue(disk('external-v2'))
    vi.mocked(platform.saveFile).mockResolvedValue({ ok: true, hash: 'mine', mtime: 3 })
    await flush(() => click(strings.banner.conflict.overwrite))
    expect(platform.saveFile).toHaveBeenCalledWith(path, 'mine', false, 'external-v2')
  })

  it('reloads after a copy when no newer notification or edit arrived', async () => {
    await flush(() => events.changed({ path, ...disk('external-v1') }))
    vi.mocked(platform.openFile).mockResolvedValue(disk('external-v1'))
    vi.mocked(platform.writeNewFile).mockResolvedValue({ ok: true, hash: 'mine', mtime: 2 })
    await flush(() => click(strings.banner.conflict.mine))
    expect(session().model.serialize()).toBe('external-v1')
    expect(editorSessionSaveState(session())).toBe('clean')
  })
})
