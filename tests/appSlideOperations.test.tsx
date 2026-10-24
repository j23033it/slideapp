// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../src/app/App'
import type { SlideStageProps } from '../src/app/SlideStage'
import { strings } from '../src/app/strings'
import { UPDATE_CHECK_EVENT } from '../src/app/UpdateNotice'
import { DEFAULT_SETTINGS, platform } from '../src/platform'
import type { FileEventHandlers } from '../src/platform/types'

const captured = vi.hoisted(() => ({ stage: null as SlideStageProps | null }))
vi.mock('../src/app/SlideStage', () => ({ SlideStage: (props: SlideStageProps) => { captured.stage = props; return null } }))
vi.mock('@marp-team/marp-core/browser', () => ({ default: () => ({ update() {}, cleanup() {} }) }))
vi.mock('../src/platform', async original => ({
  ...await original<typeof import('../src/platform')>(),
  platform: {
    settingsGet: vi.fn(), settingsSet: vi.fn(), recentFilesGet: vi.fn(), recentFilesAdd: vi.fn(),
    setWindowTitle: vi.fn(), listenFileEvents: vi.fn(), onCloseRequested: vi.fn(), stopWatching: vi.fn(),
    pickMarkdownFile: vi.fn(), openFile: vi.fn(), readThemeConfig: vi.fn(), convertFileSrc: vi.fn(),
    saveFile: vi.fn(), checkForUpdate: vi.fn(), downloadAndInstall: vi.fn(), relaunch: vi.fn(),
  },
}))

const path = 'C:\\deck\\first.md'
const secondPath = 'C:\\deck\\second.md'
const source = '# First\n\n---\n\n# Second\n\n---\n\n# Third\n'
const disk = (text: string, hasBom = false) => ({ text, hash: text, hasBom, mtime: 1 })
let host: HTMLDivElement
let events: FileEventHandlers
async function flush(action: () => void = () => {}) {
  await act(async () => { action(); await new Promise(resolve => setTimeout(resolve, 0)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const stage = () => captured.stage!
const session = () => stage().session
const workspace = () => host.querySelector<HTMLElement>('.tab-workspace:not([hidden])')!
const list = () => workspace().querySelector<HTMLElement>('.slide-list-host')!.shadowRoot!
const rows = () => [...list().querySelectorAll<HTMLElement>('.slide-row')]
const add = () => workspace().querySelector<HTMLButtonElement>('.sidebar-footer button')!
function click(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent === label && !item.closest('[hidden]'))
  expect(button, label).toBeDefined()
  button!.click()
}
function tab(filePath: string) {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.title === filePath)!
}
function key(key: string, extra: KeyboardEventInit = {}, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, composed: true, cancelable: true, ...extra })
  target.dispatchEvent(event)
  return event
}
async function open(text = source, filePath = path, hasBom = false) {
  vi.mocked(platform.pickMarkdownFile).mockResolvedValue(filePath)
  vi.mocked(platform.openFile).mockResolvedValue(disk(text, hasBom))
  await flush(() => click(strings.toolbar.open))
}
async function menu(index: number, command: string) {
  await flush(() => rows()[index].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, composed: true, cancelable: true })))
  const button = list().querySelector<HTMLButtonElement>(`[data-command="${command}"]`)!
  expect(button.disabled).toBe(false)
  await flush(() => button.click())
}
function expectSelected(index: number) {
  expect(stage().current).toBe(index)
  expect(list().querySelector('.slot[aria-current]')?.getAttribute('data-index')).toBe(String(index))
}
async function drag(from: number, to: number) {
  const allRows = rows()
  const surface = list().querySelector<HTMLElement>('.surface')!
  vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 180, top: 0, bottom: 300, width: 180, height: 300 } as DOMRect)
  allRows.forEach((row, index) => {
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: index * 100 } as DOMRect)
    Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 100 })
  })
  await flush(() => {
    allRows[from].dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: 50, clientY: from * 100 + 50, bubbles: true, composed: true }))
    const clientY = to > from ? to * 100 + 90 : to * 100 + 10
    document.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 50, clientY }))
    document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 50, clientY }))
  })
}
async function commit(text: string) {
  await flush(() => {
    const current = session()
    const { analysis } = current.renderer.analyze(text, current.baseDir)
    stage().callbacks.onCommit({ ok: true, edit: { start: 0, end: current.model.text.length, insert: text }, analysis, newText: text, escaped: false }, {})
  })
}

beforeEach(async () => {
  vi.resetAllMocks()
  captured.stage = null
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.mocked(platform.settingsGet).mockResolvedValue(DEFAULT_SETTINGS)
  vi.mocked(platform.settingsSet).mockResolvedValue()
  vi.mocked(platform.recentFilesGet).mockResolvedValue([])
  vi.mocked(platform.recentFilesAdd).mockResolvedValue([])
  vi.mocked(platform.setWindowTitle).mockResolvedValue()
  vi.mocked(platform.stopWatching).mockResolvedValue()
  vi.mocked(platform.onCloseRequested).mockResolvedValue(() => {})
  vi.mocked(platform.listenFileEvents).mockImplementation(async handlers => { events = handlers; return () => {} })
  vi.mocked(platform.readThemeConfig).mockResolvedValue({ themes: [], warnings: [] })
  vi.mocked(platform.checkForUpdate).mockResolvedValue(null)
  vi.mocked(platform.saveFile).mockResolvedValue({ ok: true, hash: 'saved', mtime: 2 })
  host = document.createElement('div')
  document.body.append(host)
  await flush(() => render(<App />, host))
})
afterEach(async () => {
  await flush(() => render(null, host))
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('App slide operations', () => {
  it.each(['menu', 'plus', 'Ctrl+M', 'list Ctrl+M'])('adds through %s, selects the new slide and marks its tab dirty', async trigger => {
    await open()
    await flush(() => rows()[1].click())
    const analyze = vi.spyOn(session().renderer, 'analyze')
    if (trigger === 'menu') await menu(1, 'add')
    else await flush(() => {
      if (trigger === 'plus') add().click()
      else key('m', {}, trigger === 'list Ctrl+M' ? rows()[1].querySelector('.slot')! : window)
    })
    expect(session().deck.slides).toHaveLength(4)
    expectSelected(2)
    expect(session().deck.slides[2]).not.toContain('Second')
    expect(tab(path).textContent).toContain('●')
    expect(analyze).not.toHaveBeenCalled()
    await flush(() => key('z'))
    expect(session().model.serialize()).toBe(source)
    expectSelected(1)
    expect(tab(path).textContent).not.toContain('●')
    await flush(() => key('y'))
    expect(session().deck.slides).toHaveLength(4)
    expectSelected(2)
  })

  it('duplicates and deletes from the context menu, restoring text and selection through history', async () => {
    await open()
    await menu(1, 'duplicate')
    expectSelected(2)
    expect(session().model.text.match(/# Second/g)).toHaveLength(2)
    const duplicated = session().model.serialize()
    await menu(2, 'delete')
    const deleted = '# First\n\n---\n\n# Second\n\n\n---\n\n# Third\n'
    expect(session().model.serialize()).toBe(deleted)
    expectSelected(2)
    await flush(() => key('z'))
    expect(session().model.serialize()).toBe(duplicated)
    expectSelected(2)
    await flush(() => key('z'))
    expect(session().model.serialize()).toBe(source)
    expectSelected(1)
    await flush(() => key('y'))
    expect(session().model.serialize()).toBe(duplicated)
    expectSelected(2)
    await flush(() => key('y'))
    expect(session().model.serialize()).toBe(deleted)
    expectSelected(2)
  })

  it('moves by pointer drag, restoring both order and selected slide through Undo/Redo', async () => {
    await open()
    await drag(0, 2)
    const moved = session().model.serialize()
    expect(moved.indexOf('# Third')).toBeLessThan(moved.indexOf('# First'))
    expectSelected(2)
    await flush(() => key('z'))
    expect(session().model.serialize()).toBe(source)
    expectSelected(0)
    await flush(() => key('y'))
    expect(session().model.serialize()).toBe(moved)
    expectSelected(2)
  })

  it('refreshes history, selection and save state when only mixed EOLs change', async () => {
    const raw = '# Same\r\n\r\n---\n# Same\n\n'
    const moved = '# Same\n\n---\n# Same\r\n\r\n'
    await open(raw, path, true)
    const normalized = session().model.text
    await menu(0, 'moveDown')
    expect(session().model.text).toBe(normalized)
    expect(session().model.serialize()).toBe(moved)
    expectSelected(1)
    const version = stage().deckVersion
    await flush(() => key('z'))
    expect(stage().deckVersion).toBeGreaterThan(version)
    expect(session().model.serialize()).toBe(raw)
    expectSelected(0)
    expect(tab(path).textContent).not.toContain('●')
    await flush(() => key('y'))
    expect(session().model.serialize()).toBe(moved)
    expectSelected(1)
    expect(tab(path).textContent).toContain('●')
    await flush(() => key('s'))
    expect(platform.saveFile).toHaveBeenCalledExactlyOnceWith(path, moved, true, raw)
    expect(tab(path).textContent).not.toContain('●')
  })

  it('shows engine rejection reasons in the status bar without changing source or history', async () => {
    const raw = '<!-- class: red -->\n# First\n\n---\n\n# Second'
    await open(raw)
    await menu(0, 'delete')
    expect(workspace().textContent).toContain(strings.slideOperations.reasons['slide-inherited-settings'])
    expect(session().model.serialize()).toBe(raw)
    expect(session().model.canUndo).toBe(false)
  })

  it('waits for IME, then ends editing and inserts after committing final input', async () => {
    await open()
    let finish!: () => void
    const endEditing = vi.fn(() => stage().callbacks.onEnd())
    stage().apiRef.current = { endEditing, isComposing: () => true, deferWhileComposing: action => { finish = action; return true } }
    await flush(() => add().click())
    expect(finish).toBeDefined()
    expect(endEditing).not.toHaveBeenCalled()
    expect(session().model.serialize()).toBe(source)
    await commit(source.replace('# First', '# 日本語確定'))
    stage().apiRef.current = { endEditing, isComposing: () => false, deferWhileComposing: () => false }
    await flush(() => finish())
    expect(endEditing).toHaveBeenCalledOnce()
    expect(session().model.text).toContain('# 日本語確定')
    expect(session().deck.slides).toHaveLength(4)
    expectSelected(1)
    await flush(() => key('z'))
    expect(session().model.text).toBe(source.replace('# First', '# 日本語確定'))
  })

  it('commits retained DOM input before applying the operation and checking Undo availability', async () => {
    await open()
    const current = session()
    const endEditing = vi.fn(() => {
      const text = source.replace('# First', '# Committed')
      const { analysis } = current.renderer.analyze(text, current.baseDir)
      stage().callbacks.onCommit({ ok: true, edit: { start: 2, end: 7, insert: 'Committed' }, analysis, newText: text, escaped: false }, {})
      stage().callbacks.onEnd()
    })
    stage().apiRef.current = { endEditing, isComposing: () => false, deferWhileComposing: () => false }
    await flush(() => add().click())
    expect(current.model.text).toContain('# Committed')
    expectSelected(1)
    stage().apiRef.current = null
    await flush(() => key('z'))
    expect(current.model.text).toBe(source.replace('# First', '# Committed'))
    await flush(() => key('z'))
    expect(current.model.text).toBe(source)
    // A fresh edit created by endEditing must be undoable in this same request.
    stage().apiRef.current = { endEditing, isComposing: () => false, deferWhileComposing: () => false }
    await flush(() => key('z'))
    expect(current.model.text).toBe(source)
    expect(current.model.canRedo).toBe(true)
  })

  it.each(['readonly', 'conflict'])('disables operations for a %s document', async mode => {
    await open(mode === 'readonly' ? '# NUL\0' : source)
    if (mode === 'conflict') {
      await flush(() => add().click())
      await flush(() => events.changed({ path, ...disk('# External') }))
      expect(session().conflict).toBe(true)
    }
    const before = session().model.serialize()
    expect(add().disabled).toBe(true)
    await flush(() => key('m'))
    expect(session().model.serialize()).toBe(before)
  })

  it.each([
    { altKey: true }, { shiftKey: true }, { metaKey: true }, { ctrlKey: false, metaKey: true },
    { isComposing: true }, { keyCode: 229 },
  ])('ignores Ctrl+M with excluded modifiers or IME flags: %j', async flags => {
    await open()
    await flush(() => key('m', flags))
    expect(session().model.serialize()).toBe(source)
  })

  it('ignores consumed keys, inputs and slide text editing, while preserving tab shortcuts', async () => {
    await open()
    const consumed = new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, cancelable: true })
    consumed.preventDefault()
    await flush(() => window.dispatchEvent(consumed))
    const input = document.createElement('input')
    host.append(input)
    input.focus()
    await flush(() => key('m', {}, input))
    await flush(() => stage().callbacks.onBegin('heading'))
    await flush(() => key('m'))
    expect(session().model.serialize()).toBe(source)
    await flush(() => stage().callbacks.onEnd())
    await open('# Other', secondPath)
    await flush(() => key('Tab'))
    expect(session().path).toBe(path)
    expect(session().model.serialize()).toBe(source)
  })

  it('isolates operations, selection, history and saves in two tabs, and disables the background list', async () => {
    await open()
    const first = session()
    const backgroundAdd = add()
    await open('# Other', secondPath)
    const second = session()
    expect(backgroundAdd.disabled).toBe(true)
    await flush(() => backgroundAdd.click())
    await flush(() => key('m'))
    expect(second.deck.slides).toHaveLength(2)
    expect(first.model.serialize()).toBe(source)
    expect(first.model.canUndo).toBe(false)
    await flush(() => tab(path).click())
    expectSelected(0)
    await menu(0, 'delete')
    expectSelected(0)
    expect(first.deck.slides).toHaveLength(2)
    const secondText = second.model.serialize()
    await flush(() => key('z'))
    expect(first.model.serialize()).toBe(source)
    expect(second.model.serialize()).toBe(secondText)
    await flush(() => tab(secondPath).click())
    expectSelected(1)
    await flush(() => key('s'))
    expect(platform.saveFile).toHaveBeenCalledExactlyOnceWith(secondPath, secondText, false, '# Other')
  })

  it('cancels an IME queued operation after its tab becomes inactive', async () => {
    await open()
    const first = session()
    await open('# Other', secondPath)
    const second = session()
    await flush(() => tab(path).click())
    const queued: Array<() => void> = []
    let composing = true
    stage().apiRef.current = { endEditing: () => {}, isComposing: () => composing,
      deferWhileComposing: action => { queued.push(action); return true } }
    // Leave is queued before insertion. Both promises resume in request order.
    await flush(() => tab(secondPath).click())
    await flush(() => add().click())
    expect(queued).toHaveLength(2)
    composing = false
    await flush(() => queued.forEach(action => action()))
    expect(session()).toBe(second)
    expect(first.model.serialize()).toBe(source)
    expect(second.model.serialize()).toBe('# Other')
  })

  it('cancels an IME queued operation if a newer disk notification arrives', async () => {
    await open()
    const queued: Array<() => void> = []
    let composing = true
    stage().apiRef.current = { endEditing: () => {}, isComposing: () => composing,
      deferWhileComposing: action => { queued.push(action); return true } }
    await flush(() => add().click())
    await flush(() => events.changed({ path, ...disk('# Reloaded') }))
    composing = false
    await flush(() => queued.forEach(action => action()))
    expect(session().model.serialize()).toBe('# Reloaded')
    expect(session().model.canUndo).toBe(false)
  })

  it('preserves an operation done while external theme loading is pending as an unresolved conflict', async () => {
    await open()
    let resolve!: (value: { themes: []; warnings: [] }) => void
    vi.mocked(platform.readThemeConfig).mockReturnValueOnce(new Promise(done => { resolve = done }))
    await flush(() => events.changed({ path, ...disk('# External') }))
    await flush(() => add().click())
    const edited = session().model.serialize()
    await flush(() => resolve({ themes: [], warnings: [] }))
    expect(session().model.serialize()).toBe(edited)
    expect(session().conflict).toBe(true)
    expect(add().disabled).toBe(true)
  })

  it('blocks operations during unsaved confirmation and update installation', async () => {
    await open()
    await flush(() => add().click())
    const edited = session().model.serialize()
    vi.mocked(platform.checkForUpdate).mockResolvedValue({ version: '0.2.0', currentVersion: '0.1.0', notes: null, date: null })
    await flush(() => window.dispatchEvent(new Event(UPDATE_CHECK_EVENT)))
    await flush(() => click(strings.update.install))
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    expect(add().disabled).toBe(true)
    await flush(() => key('m'))
    expect(session().model.serialize()).toBe(edited)
    vi.mocked(platform.downloadAndInstall).mockReturnValue(new Promise(() => {}))
    await flush(() => click(strings.confirm.discard))
    expect(platform.downloadAndInstall).toHaveBeenCalledOnce()
    expect(add().disabled).toBe(true)
    await flush(() => key('m'))
    expect(session().model.serialize()).toBe(edited)
  })
})
