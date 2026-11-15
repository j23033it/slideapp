// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditorSession } from './session'
import type { SlideStageCallbacks } from './SlideStage'
import type { GitFileStatus } from '../platform/types'

const probe = vi.hoisted(() => ({
  sessions: new Map<string, EditorSession>(), callbacks: new Map<string, SlideStageCallbacks>(),
  status: { kind: 'changed', branch: 'main' } as GitFileStatus,
  composing: false, deferred: null as (() => void) | null,
  save: vi.fn(), commit: vi.fn(), gitStatus: vi.fn(), ended: vi.fn(), resolve: null as ((value: { commit: string }) => void) | null,
}))
vi.mock('../platform', async importOriginal => {
  const actual = await importOriginal<typeof import('../platform')>()
  return { ...actual, platform: {
    settingsGet: async () => ({ ...actual.DEFAULT_SETTINGS, checkUpdatesOnStartup: false, openTabs: ['C:\\a.md', 'C:\\b.md'], activeTab: 'C:\\a.md' }),
    settingsSet: async () => {}, recentFilesGet: async () => [], recentFilesAdd: async () => [],
    openFile: async () => ({ text: '# Slide\n', hasBom: false, hash: 'old', mtime: 1 }),
    readThemeConfig: async () => ({ themes: [], warnings: [] }), convertFileSrc: (s: string) => s,
    stopWatching: async () => {}, setWindowTitle: async () => {}, listenFileEvents: async () => () => {}, onCloseRequested: async () => () => {},
    gitFileStatus: (path: string) => probe.gitStatus(path),
    saveFile: (...args: unknown[]) => probe.save(...args), gitCommitFile: (...args: unknown[]) => probe.commit(...args),
  } }
})
vi.mock('@marp-team/marp-core/browser', () => ({ default: () => ({ update() {}, cleanup() {} }) }))
vi.mock('./SlideList', async () => { const { h } = await import('preact'); return { SlideList: () => h('div', {}) } })
vi.mock('./SlideStage', async () => {
  const { h } = await import('preact'); const { useEffect } = await import('preact/hooks')
  return { SlideStage: (props: { session: EditorSession; apiRef: { current: unknown }; callbacks: SlideStageCallbacks }) => {
    probe.sessions.set(props.session.path, props.session); probe.callbacks.set(props.session.path, props.callbacks)
    useEffect(() => { props.apiRef.current = { endEditing() { probe.ended(props.session.path) }, isComposing: () => probe.composing, deferWhileComposing: (action: () => void) => { if (!probe.composing) return false; probe.deferred = action; return true } }; return () => { props.apiRef.current = null } }, [props.apiRef])
    return h('div', {})
  } }
})
import { App } from './App'
const host = document.createElement('div'); document.body.append(host)
async function until(predicate: () => unknown) {
  for (let i = 0; i < 100; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); if (predicate()) return }
  throw new Error(`Timed out: sessions=${[...probe.sessions.keys()].join(',')} html=${document.body.textContent?.slice(0, 1000)}`)
}
function toolbarButton(): HTMLButtonElement { return [...document.querySelectorAll<HTMLButtonElement>('.toolbar button')].find(b => b.textContent === 'コミット')! }
function input(): HTMLInputElement { return document.querySelector<HTMLInputElement>('input[placeholder="コミットメッセージ"]')! }
function setMessage(value: string) { input().value = value; input().dispatchEvent(new Event('input', { bubbles: true })) }
function clickTab(name: string) { ([...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(b => b.textContent?.includes(name)))!.click() }
function dirty(path: string) { probe.sessions.get(path)!.model.edit({ start: 0, end: 0, insert: 'dirty ' }); probe.callbacks.get(path)!.onElementSelect(null) }
beforeEach(() => {
  probe.sessions.clear(); probe.callbacks.clear(); probe.status = { kind: 'changed', branch: 'main' }; probe.resolve = null; probe.composing = false; probe.deferred = null
  probe.ended.mockReset()
  probe.gitStatus.mockReset().mockImplementation(async () => ({ ...probe.status }))
  probe.save.mockReset().mockResolvedValue({ ok: true, hash: 'saved', mtime: 2 })
  probe.commit.mockReset().mockImplementation(() => new Promise(resolve => { probe.resolve = resolve }))
  act(() => render(<App />, host))
})
afterEach(() => { probe.resolve?.({ commit: 'abc' }); act(() => render(null, host)) })
async function ready() { await until(() => probe.sessions.size === 1 && toolbarButton() && !toolbarButton().disabled); act(() => clickTab('b.md')); await until(() => probe.sessions.size === 2); act(() => clickTab('a.md')); await until(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent?.includes('a.md')) }

describe('commit workspace', () => {
  it('shows the specified disabled reasons and permits clean files with unsaved edits', async () => {
    await ready()
    for (const [kind, message] of [['unavailable', 'Gitが見つかりません'], ['outside', 'Gitで管理されていないファイルです'], ['ignored', '.gitignoreで除外されたファイルです'], ['clean', 'コミットする変更がありません'], ['error', 'Gitの状態を確認できません：failure']] as const) {
      probe.status = { kind, branch: null, message: 'failure' }
      act(() => { window.dispatchEvent(new Event('focus')) })
      await until(() => toolbarButton().title === message)
      expect(toolbarButton().disabled).toBe(true)
    }
    probe.status = { kind: 'clean', branch: 'main' }
    act(() => { dirty('C:\\a.md'); window.dispatchEvent(new Event('focus')) })
    await until(() => !toolbarButton().disabled)
  })
  it('handles Enter, Escape, composition and empty messages', async () => {
    await ready(); act(() => toolbarButton().click()); await until(() => input())
    expect(document.activeElement).toBe(input())
    const submit = () => document.querySelector<HTMLButtonElement>('[role=dialog] button')!
    expect(submit().disabled).toBe(true)
    act(() => { setMessage('  '); input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(probe.commit).not.toHaveBeenCalled()
    act(() => { setMessage('message'); input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true })) })
    expect(probe.commit).not.toHaveBeenCalled()
    act(() => { input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(input()).toBeNull()
    act(() => toolbarButton().click()); await until(() => input())
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await until(() => probe.commit.mock.calls.length === 1)
  })
  it('saves only A, keeps its target and result across tab switches, and retains the message', async () => {
    await ready(); act(() => { dirty('C:\\a.md'); dirty('C:\\b.md'); toolbarButton().click() }); await until(() => input())
    act(() => setMessage('A message'))
    act(() => { const tab = [...document.querySelectorAll<HTMLButtonElement>('[role=tab]')].find(b => b.textContent?.includes('b.md'))!; tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); tab.click() }); await until(() => !input())
    act(() => clickTab('a.md')); await until(() => input())
    expect(input().value).toBe('A message')
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await until(() => probe.commit.mock.calls.length === 1)
    expect(probe.save).toHaveBeenCalledTimes(1); expect(probe.save.mock.calls[0][0]).toBe('C:\\a.md')
    expect(probe.commit).toHaveBeenCalledWith('C:\\a.md', 'A message', 'saved')
    act(() => clickTab('b.md')); await until(() => !input())
    await act(async () => probe.resolve!({ commit: 'abc' }))
    expect(document.querySelector('[role=tabpanel]:not([hidden])')!.textContent).not.toContain('コミットしました（abc）')
    act(() => clickTab('a.md')); await until(() => document.body.textContent?.includes('コミットしました（abc）'))
  })
  it('keeps editing and tab operations available during a pending commit', async () => {
    await ready(); act(() => toolbarButton().click()); await until(() => input())
    act(() => setMessage('pending')); act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await until(() => probe.commit.mock.calls.length === 1)
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('コミット中…')
    const edit = (path: string) => {
      const session = probe.sessions.get(path)!
      const callbacks = probe.callbacks.get(path)!
      expect(callbacks.canBold()).toBe(true)
      const change = { start: 0, end: 0, insert: 'edited ' }
      const newText = change.insert + session.model.text
      callbacks.onCommit({ ok: true, edit: change, newText, analysis: session.renderer.editing.analyze(newText), escaped: false }, {})
      expect(session.model.text).toBe(newText)
    }
    act(() => edit('C:\\a.md'))
    probe.ended.mockClear()
    act(() => clickTab('b.md'))
    await until(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent?.includes('b.md'))
    expect(probe.ended).toHaveBeenCalledWith('C:\\a.md')
    act(() => edit('C:\\b.md'))
    act(() => clickTab('a.md'))
    await until(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent?.includes('a.md'))
    expect(probe.sessions.get('C:\\a.md')!.model.text).toContain('edited ')
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('コミット中…')
  })
  it('preserves the message and displays the error on failure', async () => {
    probe.commit.mockRejectedValueOnce({ kind: 'error', message: 'hook failed' })
    await ready(); act(() => toolbarButton().click()); await until(() => input())
    act(() => setMessage('keep me')); act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await until(() => document.body.textContent?.includes('コミットできませんでした：hook failed'))
    expect(input().value).toBe('keep me')
  })
  it('does not commit when saving fails', async () => {
    probe.save.mockResolvedValueOnce({ ok: false, kind: 'io', message: 'disk error' })
    await ready(); act(() => { dirty('C:\\a.md'); toolbarButton().click() }); await until(() => input())
    act(() => setMessage('retain')); act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await until(() => document.body.textContent?.includes('disk error'))
    expect(probe.commit).not.toHaveBeenCalled(); expect(input().value).toBe('retain')
  })
  it('keeps the target when switching tabs while the save is pending', async () => {
    let finishSave: ((value: { ok: true; hash: string; mtime: number }) => void) | undefined
    probe.save.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve }))
    await ready(); act(() => { dirty('C:\\a.md'); dirty('C:\\b.md'); toolbarButton().click() }); await until(() => input())
    act(() => setMessage('saving')); act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await until(() => finishSave)
    act(() => clickTab('b.md')); await until(() => document.querySelector('[role=tab][aria-selected=true]')?.textContent?.includes('b.md'))
    await act(async () => finishSave!({ ok: true, hash: 'saved', mtime: 2 }))
    await until(() => probe.commit.mock.calls.length === 1)
    expect(probe.save).toHaveBeenCalledTimes(1); expect(probe.commit).toHaveBeenCalledWith('C:\\a.md', 'saving', 'saved')
  })

  it('finishes a commit after its tab is closed and discards its result', async () => {
    await ready(); act(() => toolbarButton().click()); await until(() => input())
    act(() => setMessage('closing')); act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await until(() => probe.commit.mock.calls.length === 1)
    act(() => document.querySelector<HTMLButtonElement>('.file-tab[data-active=true] .file-tab-close')!.click())
    await until(() => !document.querySelector('[role=tab]')?.textContent?.includes('a.md'))
    await act(async () => probe.resolve!({ commit: 'abc' }))
    expect(document.body.textContent).not.toContain('コミットしました（abc）')
    expect(probe.commit).toHaveBeenCalledWith('C:\\a.md', 'closing', 'old')
  })

  it('disables the button for conflicts, read-only files and no file', async () => {
    await ready()
    act(() => { const session = probe.sessions.get('C:\\a.md')!; session.conflict = true; probe.callbacks.get(session.path)!.onElementSelect(null) })
    expect(toolbarButton().disabled).toBe(true); expect(toolbarButton().title).toBe('ファイルが競合しているため操作できません')
    act(() => { const session = probe.sessions.get('C:\\a.md')!; session.conflict = false; session.model.reload('\0', 'old', false); probe.callbacks.get(session.path)!.onElementSelect(null) })
    expect(toolbarButton().disabled).toBe(true); expect(toolbarButton().title).toBe('読み取り専用のため操作できません')
    act(() => document.querySelector<HTMLButtonElement>('.file-tab[data-active=true] .file-tab-close')!.click())
    await until(() => document.querySelectorAll('[role=tab]').length === 1)
    act(() => document.querySelector<HTMLButtonElement>('.file-tab[data-active=true] .file-tab-close')!.click())
    await until(() => document.querySelectorAll('[role=tab]').length === 0 && !!toolbarButton())
    expect(toolbarButton().disabled).toBe(true); expect(toolbarButton().title).toBe('ファイルが開かれていません')
  })
  it('ignores older status responses for the same tab', async () => {
    await ready()
    const pending: ((status: GitFileStatus) => void)[] = []
    probe.gitStatus.mockImplementation((path: string) => path === 'C:\\a.md' ? new Promise(resolve => pending.push(resolve)) : Promise.resolve(probe.status))
    act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus')) })
    expect(pending).toHaveLength(2)
    await act(async () => pending[1]({ kind: 'changed', branch: 'new' }))
    await act(async () => pending[0]({ kind: 'ignored', branch: 'old' }))
    expect(toolbarButton().disabled).toBe(false)
    act(() => toolbarButton().click()); await until(() => input())
    expect(document.querySelector('[role=dialog]')!.textContent).toContain('ブランチ new にコミット')
  })

  it('waits for the editing composition before saving and committing', async () => {
    await ready(); act(() => { dirty('C:\\a.md'); toolbarButton().click() }); await until(() => input())
    act(() => setMessage('IME')); probe.composing = true
    act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await until(() => probe.deferred)
    expect(probe.save).not.toHaveBeenCalled(); expect(probe.commit).not.toHaveBeenCalled()
    await act(async () => { probe.composing = false; probe.deferred!() })
    await until(() => probe.commit.mock.calls.length === 1)
    expect(probe.save).toHaveBeenCalledTimes(1)
  })

})
