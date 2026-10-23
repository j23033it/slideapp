// @vitest-environment happy-dom
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../src/app/App'
import { StageEditor } from '../src/app/stageEditor'
import { editorSessionSaveState } from '../src/app/session'
import type { SlideStageProps } from '../src/app/SlideStage'
import { strings } from '../src/app/strings'
import { UPDATE_CHECK_EVENT } from '../src/app/UpdateNotice'
import { exportPptx, type ExportReport } from '../src/export/pptx'
import { DEFAULT_SETTINGS, platform, type UpdateInfo } from '../src/platform'
import type { FileEventHandlers, SaveOutcome } from '../src/platform/types'
import type { SlideSurface } from '../src/marp/surface'

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
    pickPptxSavePath: vi.fn(), writeBinary: vi.fn(),
    openFile: vi.fn(), readThemeConfig: vi.fn(), convertFileSrc: vi.fn(),
    saveFile: vi.fn(), writeNewFile: vi.fn(), forceClose: vi.fn(),
    checkForUpdate: vi.fn(), downloadAndInstall: vi.fn(), relaunch: vi.fn(),
  },
}))
vi.mock('../src/export/pptx', () => ({
  defaultPptxPath: (path: string) => /\.(md|markdown)$/i.test(path) ? path.replace(/\.(md|markdown)$/i, '.pptx') : `${path}.pptx`,
  exportPptx: vi.fn(),
}))

const path = 'C:\\deck\\deck.md'
const disk = (text: string, hash = text) => ({ text, hash, hasBom: false, mtime: 1 })
const updateInfo: UpdateInfo = { version: '0.2.0', currentVersion: '0.1.0', notes: null, date: null }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

let host: HTMLDivElement
let events: FileEventHandlers
let requestClose: (() => void) | undefined
async function flush(action: () => void = () => {}) {
  await act(async () => { action(); await new Promise((resolve) => setTimeout(resolve, 0)) })
}
function click(text: string) {
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text)
  expect(button, text).toBeDefined()
  button!.click()
}
function session() { return captured.stage!.session }
async function editDocument(text: string) {
  await flush(() => {
    const current = session()
    const edit = { start: 0, end: current.model.text.length, insert: text }
    const { analysis } = current.renderer.analyze(text, current.baseDir)
    captured.stage!.callbacks.onCommit({ ok: true, edit, analysis, newText: text, escaped: false }, {})
  })
}
async function editMine() { await editDocument('mine') }

const cleanExportReport: ExportReport = {
  slideCount: 1,
  rasterizedCount: 0,
  rasterizedElements: [],
  approximatedElements: [],
  substitutedFonts: [],
  warnings: [],
}

async function offerUpdate() {
  vi.mocked(platform.checkForUpdate).mockResolvedValue(updateInfo)
  await flush(() => window.dispatchEvent(new Event(UPDATE_CHECK_EVENT)))
  expect(host.textContent).toContain(strings.update.available(updateInfo.version))
}

beforeEach(async () => {
  vi.resetAllMocks()
  captured.stage = null
  requestClose = undefined
  vi.mocked(platform.settingsGet).mockResolvedValue(DEFAULT_SETTINGS)
  vi.mocked(platform.settingsSet).mockResolvedValue()
  vi.mocked(platform.recentFilesGet).mockResolvedValue([])
  vi.mocked(platform.recentFilesAdd).mockResolvedValue([path])
  vi.mocked(platform.pickPptxSavePath).mockResolvedValue('C:\\deck\\deck.pptx')
  vi.mocked(platform.writeBinary).mockResolvedValue()
  vi.mocked(platform.setWindowTitle).mockResolvedValue()
  vi.mocked(platform.stopWatching).mockResolvedValue()
  vi.mocked(platform.onCloseRequested).mockImplementation((handler) => {
    requestClose = handler
    return Promise.resolve(() => {})
  })
  vi.mocked(platform.checkForUpdate).mockResolvedValue(null)
  vi.mocked(platform.downloadAndInstall).mockResolvedValue()
  vi.mocked(platform.relaunch).mockResolvedValue()
  vi.mocked(platform.listenFileEvents).mockImplementation(async (handlers) => {
    events = handlers
    return () => {}
  })
  vi.mocked(platform.pickMarkdownFile).mockResolvedValue(path)
  vi.mocked(platform.openFile).mockResolvedValue(disk('base'))
  vi.mocked(platform.readThemeConfig).mockResolvedValue({ themes: [], warnings: [] })
  vi.mocked(exportPptx).mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), report: cleanExportReport })
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
  it.each(['Ctrl+S', 'toolbar save'])('includes late final input in %s through the real StageEditor', async action => {
    const stageHost = document.createElement('div')
    document.body.append(stageHost)
    const root = stageHost.attachShadow({ mode: 'open' })
    const editor = new StageEditor({ root, update: (deck, current) => { root.innerHTML = deck.slides[current] } } as SlideSurface,
      session().renderer.editing, {
        latest: () => ({ analysis: session().analysis, deck: session().deck }),
        onBegin: label => captured.stage!.callbacks.onBegin(label),
        onEnd: () => captured.stage!.callbacks.onEnd(),
        onNotice: code => captured.stage!.callbacks.onNotice(code),
        onCommit: (result, cursors) => captured.stage!.callbacks.onCommit(result, cursors),
        onCrossRun: (result, after, before) => captured.stage!.callbacks.onCrossRun(result, after, before),
        onHistory: direction => captured.stage!.callbacks.onHistory(direction),
      })
    captured.stage!.apiRef.current = editor
    vi.mocked(platform.saveFile).mockResolvedValue({ ok: true, hash: 'final', mtime: 2 })
    try {
      editor.render(session().deck, session().analysis, 0)
      const run = root.querySelector<HTMLElement>('[data-sm-run]')!
      await act(async () => {
        run.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
        run.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true }))
        run.textContent = '日本語途中'
        run.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, isComposing: true }))
        run.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true }))
        if (action === 'Ctrl+S') run.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, composed: true, cancelable: true }))
        else click(strings.toolbar.save)
        expect(platform.saveFile).not.toHaveBeenCalled()
        await Promise.resolve()
        expect(platform.saveFile).not.toHaveBeenCalled()
        expect(run.isConnected).toBe(true)
        run.textContent = '日本語確定'
        run.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromComposition' }))
        await new Promise<void>(resolve => setTimeout(resolve, 0))
      })
      expect(platform.saveFile).toHaveBeenCalledExactlyOnceWith(path, '日本語確定', false, 'base')
      expect(session().model.serialize()).toBe('日本語確定')
    } finally {
      captured.stage!.apiRef.current = null
      editor.dispose()
      stageHost.remove()
    }
  })

  it.each(['first-open', 'switch-file', 'composition-wait'] as const)(
    'uses the latest notification received during %s before publishing the new session', async (timing) => {
      if (timing === 'first-open') {
        await flush(() => render(null, host))
        captured.stage = null
        await flush(() => render(<App />, host))
      } else {
        await flush(() => captured.stage!.callbacks.onHistory('undo'))
      }
      const nextPath = 'C:\\deck\\next.md'
      const open = deferred<ReturnType<typeof disk>>()
      vi.mocked(platform.pickMarkdownFile).mockResolvedValue(nextPath)
      vi.mocked(platform.openFile).mockReturnValue(open.promise)
      await flush(() => click(strings.toolbar.open))
      expect(platform.openFile).toHaveBeenLastCalledWith(nextPath)
      let finishComposition: (() => void) | undefined
      if (timing === 'composition-wait') {
        captured.stage!.apiRef.current = {
          endEditing: () => {},
          isComposing: () => true,
          deferWhileComposing: (action) => { finishComposition = action; return true },
        }
        await flush(() => open.resolve(disk('stale-read')))
        expect(finishComposition).toBeDefined()
      }
      // Rust starts watching before open_file returns. This callback runs while
      // sessionRef is still null/the old file, or while its IME completion is pending.
      await flush(() => events.changed({ path: nextPath, ...disk('external-v1') }))
      await flush(() => events.changed({ path: nextPath, ...disk('external-v2'), hasBom: true }))
      if (timing === 'composition-wait') {
        captured.stage!.apiRef.current = null
        await flush(() => finishComposition!())
      } else {
        await flush(() => open.resolve(disk('stale-read')))
      }
      expect(session().path).toBe(nextPath)
      expect(session().model.serialize()).toBe('external-v2')
      expect(session().model.hasBom).toBe(true)
      expect(session().model.diskHash).toBe('external-v2')
      expect(session().savedSnapshot).toEqual({ text: 'external-v2', hasBom: true })
      expect(editorSessionSaveState(session())).toBe('clean')
      expect(host.querySelector('.banner')).toBeNull()
    },
  )

  it.each(['removed', 'unreadable'] as const)(
    'preserves a %s notification received before a new file finishes opening', async (type) => {
      await flush(() => captured.stage!.callbacks.onHistory('undo'))
      const nextPath = 'C:\\deck\\next.md'
      const open = deferred<ReturnType<typeof disk>>()
      vi.mocked(platform.pickMarkdownFile).mockResolvedValue(nextPath)
      vi.mocked(platform.openFile).mockReturnValue(open.promise)
      await flush(() => click(strings.toolbar.open))
      await flush(() => {
        if (type === 'removed') events.removed({ path: nextPath })
        else events.unreadable({ path: nextPath, message: 'locked' })
      })
      await flush(() => open.resolve(disk('last-readable')))
      expect(session().path).toBe(nextPath)
      expect(session().model.serialize()).toBe('last-readable')
      expect(host.textContent).toContain(type === 'removed'
        ? strings.banner.removed('next.md')
        : strings.banner.unreadable('next.md', 'locked'))
    },
  )

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

describe('PowerPoint export', () => {
  it('enables export for an open file and disables it with no selected file', async () => {
    const exportButton = () => [...host.querySelectorAll('button')]
      .find((item) => item.textContent === strings.toolbar.exportPptx)
    expect(exportButton()?.disabled).toBe(false)

    await flush(() => render(null, host))
    captured.stage = null
    await flush(() => render(<App />, host))
    expect(exportButton()?.disabled).toBe(true)
  })

  it('Ctrl+E opens the save dialog and cancellation does not export or write', async () => {
    vi.mocked(platform.pickPptxSavePath).mockResolvedValue(null)
    await flush(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true })))

    expect(platform.pickPptxSavePath).toHaveBeenCalledWith('C:\\deck\\deck.pptx')
    expect(exportPptx).not.toHaveBeenCalled()
    expect(platform.writeBinary).not.toHaveBeenCalled()
    expect(host.textContent).not.toContain(strings.status.exporting)
  })

  it('exports unsaved Markdown and presents a plain-language report', async () => {
    const bytes = new Uint8Array([9, 8, 7])
    const warning = 'Web font stylesheet could not be embedded: https://example.invalid/fonts.css. Local fallback fonts were used.'
    const report: ExportReport = {
      ...cleanExportReport,
      rasterizedCount: 3,
      rasterizedElements: [
        { slide: 3, element: 'math', reason: 'MathJax internals' },
        { slide: 3, element: 'svg', reason: 'Unsupported SVG path' },
        { slide: 4, element: 'border', reason: 'Unsupported border style' },
      ],
      approximatedElements: [{ slide: 1, element: 'h1', property: 'letter-spacing', value: '1px', replacement: 'PowerPoint spacing' }],
      substitutedFonts: [{ requested: 'Noto Sans JP', replacement: 'Yu Gothic' }],
      warnings: [warning],
    }
    vi.mocked(exportPptx).mockResolvedValue({ bytes, report })

    await flush(() => click(strings.toolbar.exportPptx))

    expect(exportPptx).toHaveBeenCalledTimes(1)
    const [source] = vi.mocked(exportPptx).mock.calls[0]!
    expect(source.markdown).toBe('mine')
    expect(source.baseDir).toBe('C:\\deck')
    expect(source.marp).toBeDefined()
    expect(platform.saveFile).not.toHaveBeenCalled()
    expect(platform.writeBinary).toHaveBeenCalledWith('C:\\deck\\deck.pptx', bytes)
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog).not.toBeNull()
    const sections = [...dialog.querySelectorAll('.export-report-section')]
    const visibleReport = sections.map((section) => section.textContent).join(' ')
    expect(visibleReport).toContain(strings.export.rasterizedSlide(3, 2))
    expect(visibleReport).toContain(strings.export.rasterizedSlide(4, 1))
    expect(visibleReport).toContain(strings.export.rasterizedEditingLimit)
    expect(visibleReport).toContain(strings.export.substitutedFont('Noto Sans JP', 'Yu Gothic'))
    expect(visibleReport).toContain(strings.export.webFontUnavailable)
    expect(visibleReport).not.toContain('math')
    expect(visibleReport).not.toContain('MathJax')
    expect(visibleReport).not.toContain('letter-spacing')
    expect(visibleReport).not.toContain('PowerPoint spacing')
    const details = dialog.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain(warning)

    await flush(() => click(strings.export.close))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not show a dialog or approximation details when approximations are the only report items', async () => {
    vi.mocked(exportPptx).mockResolvedValue({
      bytes: new Uint8Array([1]),
      report: {
        ...cleanExportReport,
        approximatedElements: [
          { slide: 2, element: 'li::marker', property: 'list-style-type', value: 'disc', replacement: 'Verdana U+2022 at 110%' },
        ],
      },
    })

    await flush(() => click(strings.toolbar.exportPptx))

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(host.querySelector('[role="status"]')?.textContent).toContain(strings.export.succeeded('deck.pptx'))
    expect(host.textContent).not.toContain('近似した要素')
    expect(host.textContent).not.toContain('list-style-type')
    expect(host.textContent).not.toContain('Verdana U+2022')
  })

  it('shows a concise success message when the report has no issues', async () => {
    await flush(() => click(strings.toolbar.exportPptx))

    expect(host.querySelector('[role="status"]')?.textContent)
      .toContain(strings.export.succeeded('deck.pptx'))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('shows an export exception in an error banner', async () => {
    vi.mocked(exportPptx).mockRejectedValue(new Error('renderer failed'))
    await flush(() => click(strings.toolbar.exportPptx))

    expect(host.querySelector('[role="alert"] .banner-message')?.textContent).toContain(strings.export.failed)
    expect(host.querySelector('[role="alert"] .banner-message')?.textContent).not.toContain('renderer failed')
    expect(host.querySelector<HTMLDetailsElement>('[role="alert"] details')?.open).toBe(false)
    expect(host.querySelector('[role="alert"] details')?.textContent).toContain('renderer failed')
    expect(platform.writeBinary).not.toHaveBeenCalled()
  })

  it('writes partial output and shows report errors in the banner and report dialog', async () => {
    const report: ExportReport = {
      ...cleanExportReport,
      rasterizedCount: 1,
      rasterizedElements: [{ slide: 1, element: 'svg', reason: 'fallback' }],
      errors: [{ slide: 2, element: 'image', reason: 'asset unavailable' }],
      warnings: ['Error on slide 2, image: asset unavailable'],
    }
    vi.mocked(exportPptx).mockResolvedValue({ bytes: new Uint8Array([1]), report })

    await flush(() => click(strings.toolbar.exportPptx))

    expect(platform.writeBinary).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role="alert"] .banner-message')?.textContent).toContain(strings.export.partial('deck.pptx'))
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(strings.export.errorSlide(2, 1))
    expect([...dialog.querySelectorAll('.export-report-section')].map((section) => section.textContent).join(' '))
      .not.toContain('asset unavailable')
    const details = dialog.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('asset unavailable')
    const closeReport = [...host.querySelector('[role="dialog"]')!.querySelectorAll('button')]
      .find((item) => item.textContent === strings.export.close)
    await flush(() => closeReport!.click())
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })

  it('shows file write failures in an error banner', async () => {
    vi.mocked(platform.writeBinary).mockRejectedValue(new Error('disk full'))
    await flush(() => click(strings.toolbar.exportPptx))

    expect(host.querySelector('[role="alert"] .banner-message')?.textContent)
      .toContain(strings.export.writeFailed('deck.pptx'))
    expect(host.querySelector('[role="alert"] .banner-message')?.textContent).not.toContain('disk full')
    expect(host.querySelector<HTMLDetailsElement>('[role="alert"] details')?.open).toBe(false)
    expect(host.querySelector('[role="alert"] details')?.textContent).toContain('disk full')
    expect(host.textContent).not.toContain(strings.export.succeeded('deck.pptx'))
  })

  it('waits for IME composition and blocks duplicate exports until completion', async () => {
    const saveDialog = deferred<string | null>()
    vi.mocked(platform.pickPptxSavePath).mockReturnValue(saveDialog.promise)
    let finishComposition: (() => void) | undefined
    captured.stage!.apiRef.current = {
      endEditing: () => {},
      isComposing: () => true,
      deferWhileComposing: (action) => { finishComposition = action; return true },
    }

    await flush(() => {
      click(strings.toolbar.exportPptx)
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', ctrlKey: true, bubbles: true }))
    })
    expect(platform.pickPptxSavePath).not.toHaveBeenCalled()
    expect(host.textContent).toContain(strings.status.exporting)

    captured.stage!.apiRef.current = null
    await flush(() => finishComposition!())
    expect(platform.pickPptxSavePath).toHaveBeenCalledTimes(1)
    const exportButton = [...host.querySelectorAll('button')]
      .find((item) => item.textContent === strings.toolbar.exportPptx)
    expect(exportButton?.disabled).toBe(true)
    expect(exportPptx).not.toHaveBeenCalled()

    await flush(() => saveDialog.resolve('C:\\deck\\deck.pptx'))
    expect(exportPptx).toHaveBeenCalledTimes(1)
  })

  it('keeps the starting Markdown when the document is edited or switched during export', async () => {
    const exportResult = deferred<{ bytes: Uint8Array; report: ExportReport }>()
    const bytes = new Uint8Array([4, 5, 6])
    vi.mocked(exportPptx).mockReturnValue(exportResult.promise)
    await flush(() => click(strings.toolbar.exportPptx))
    const source = vi.mocked(exportPptx).mock.calls[0]![0]
    expect(source.markdown).toBe('mine')

    await editDocument('edited during export')
    expect(session().model.serialize()).toBe('edited during export')
    expect(source.markdown).toBe('mine')

    const nextPath = 'C:\\deck\\next.md'
    vi.mocked(platform.pickMarkdownFile).mockResolvedValue(nextPath)
    vi.mocked(platform.openFile).mockResolvedValue(disk('next deck'))
    await flush(() => click(strings.toolbar.open))
    expect(host.textContent).toContain(strings.confirm.title)
    await flush(() => click(strings.confirm.discard))
    expect(session().path).toBe(nextPath)

    await flush(() => exportResult.resolve({ bytes, report: cleanExportReport }))
    expect(platform.writeBinary).toHaveBeenCalledWith('C:\\deck\\deck.pptx', bytes)
    expect(platform.saveFile).not.toHaveBeenCalled()
    expect(source.markdown).toBe('mine')
  })
})

describe('update installation confirmation', () => {
  it('saves before installing and locks document changes after approval', async () => {
    vi.mocked(platform.saveFile).mockResolvedValue({ ok: true, hash: 'mine', mtime: 2 })
    await offerUpdate()
    await flush(() => click(strings.update.install))
    expect(host.textContent).toContain(strings.confirm.title)
    expect(platform.downloadAndInstall).not.toHaveBeenCalled()

    await flush(() => click(strings.confirm.saveAndContinue))
    expect(platform.saveFile).toHaveBeenCalledWith(path, 'mine', false, 'base')
    expect(platform.downloadAndInstall).toHaveBeenCalledTimes(1)
    expect(platform.relaunch).toHaveBeenCalledTimes(1)
    expect(host.firstElementChild?.hasAttribute('inert')).toBe(true)

    const savedCalls = vi.mocked(platform.saveFile).mock.calls.length
    const before = session().model.serialize()
    await flush(() => events.changed({ path, ...disk('external-after-install-lock') }))
    expect(session().model.serialize()).toBe(before)
    await flush(() => {
      click(strings.toolbar.save)
      const current = session()
      const { analysis } = current.renderer.analyze('ignored', current.baseDir)
      captured.stage!.callbacks.onCommit({
        ok: true,
        edit: { start: 0, end: current.model.text.length, insert: 'ignored' },
        analysis,
        newText: 'ignored',
        escaped: false,
      }, {})
    })
    expect(platform.saveFile).toHaveBeenCalledTimes(savedCalls)
    expect(session().model.serialize()).toBe(before)
  })

  it('installs after the user chooses to discard unsaved changes', async () => {
    await offerUpdate()
    await flush(() => click(strings.update.install))
    await flush(() => click(strings.confirm.discard))
    expect(platform.saveFile).not.toHaveBeenCalled()
    expect(platform.downloadAndInstall).toHaveBeenCalledTimes(1)
    expect(platform.relaunch).toHaveBeenCalledTimes(1)
  })

  it('keeps the update available when the user cancels', async () => {
    await offerUpdate()
    await flush(() => click(strings.update.install))
    await flush(() => click(strings.confirm.cancel))
    expect(platform.downloadAndInstall).not.toHaveBeenCalled()
    expect(platform.relaunch).not.toHaveBeenCalled()
    expect(host.textContent).toContain(strings.update.available(updateInfo.version))
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === strings.update.install)).toBe(true)
  })

  it('installs without confirmation when the document is clean', async () => {
    await flush(() => captured.stage!.callbacks.onHistory('undo'))
    expect(editorSessionSaveState(session())).toBe('clean')
    await offerUpdate()
    await flush(() => click(strings.update.install))
    expect(host.textContent).not.toContain(strings.confirm.title)
    expect(platform.downloadAndInstall).toHaveBeenCalledTimes(1)
    expect(platform.relaunch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['save error', { ok: false as const, kind: 'io' as const, message: 'locked' }],
    ['save conflict', { ok: false as const, kind: 'conflict' as const, diskHash: 'other' }],
  ] as const)('does not install after a %s', async (_label, outcome) => {
    vi.mocked(platform.saveFile).mockResolvedValue(outcome)
    await offerUpdate()
    await flush(() => click(strings.update.install))
    await flush(() => click(strings.confirm.saveAndContinue))
    expect(platform.downloadAndInstall).not.toHaveBeenCalled()
    expect(platform.relaunch).not.toHaveBeenCalled()
    expect([...host.querySelectorAll('button')].some((button) => button.textContent === strings.update.install)).toBe(true)
  })

  it('waits for IME composition and commit before checking for unsaved changes', async () => {
    await flush(() => captured.stage!.callbacks.onHistory('undo'))
    let finishComposition: (() => void) | undefined
    captured.stage!.apiRef.current = {
      endEditing: () => {},
      isComposing: () => true,
      deferWhileComposing: (action) => { finishComposition = action; return true },
    }
    await offerUpdate()
    await flush(() => click(strings.update.install))
    expect(host.textContent).not.toContain(strings.confirm.title)
    expect(platform.downloadAndInstall).not.toHaveBeenCalled()

    await editMine()
    captured.stage!.apiRef.current = null
    await flush(() => finishComposition!())
    expect(host.textContent).toContain(strings.confirm.title)
    expect(platform.downloadAndInstall).not.toHaveBeenCalled()
    await flush(() => click(strings.confirm.cancel))
  })

  it('holds external changes during installation and applies them if installation fails', async () => {
    await flush(() => captured.stage!.callbacks.onHistory('undo'))
    const installation = deferred<void>()
    vi.mocked(platform.downloadAndInstall).mockReturnValue(installation.promise)
    await offerUpdate()
    await flush(() => click(strings.update.install))
    expect(host.firstElementChild?.hasAttribute('inert')).toBe(true)

    await flush(() => events.changed({ path, ...disk('external-during-install') }))
    expect(session().model.serialize()).toBe('base')

    await flush(() => installation.reject(new Error('download failed')))
    expect(host.firstElementChild?.hasAttribute('inert')).toBe(false)
    expect(session().model.serialize()).toBe('external-during-install')
    expect(editorSessionSaveState(session())).toBe('clean')
  })

  it('keeps the newest external change when an older theme read finishes during installation', async () => {
    await flush(() => captured.stage!.callbacks.onHistory('undo'))
    const themeConfig = deferred<Awaited<ReturnType<typeof platform.readThemeConfig>>>()
    vi.mocked(platform.readThemeConfig).mockReturnValue(themeConfig.promise)
    vi.mocked(platform.readThemeConfig).mockClear()
    const installation = deferred<void>()
    vi.mocked(platform.downloadAndInstall).mockReturnValue(installation.promise)
    await offerUpdate()

    await flush(() => events.changed({ path, ...disk('external-v1') }))
    expect(platform.readThemeConfig).toHaveBeenCalledTimes(1)

    await flush(() => click(strings.update.install))
    expect(host.firstElementChild?.hasAttribute('inert')).toBe(true)
    await flush(() => events.changed({ path, ...disk('external-v2') }))
    await flush(() => themeConfig.resolve({ themes: [], warnings: [] }))
    expect(session().model.serialize()).toBe('base')

    await flush(() => installation.reject(new Error('download failed')))
    expect(session().model.serialize()).toBe('external-v2')
    expect(session().model.diskHash).toBe('external-v2')
    expect(editorSessionSaveState(session())).toBe('clean')
  })

  it('restores the update notice when the retry confirmation is canceled', async () => {
    vi.mocked(platform.saveFile).mockResolvedValue({ ok: true, hash: 'mine', mtime: 2 })
    vi.mocked(platform.downloadAndInstall).mockRejectedValueOnce(new Error('download failed'))
    await offerUpdate()
    await flush(() => click(strings.update.install))
    await flush(() => click(strings.confirm.saveAndContinue))
    expect(host.textContent).toContain(strings.update.retry)

    // 再び未保存にしてから再試行し、保存の確認でキャンセルする
    await flush(() => captured.stage!.callbacks.onHistory('undo'))
    expect(editorSessionSaveState(session())).not.toBe('clean')
    await flush(() => click(strings.update.retry))
    expect(host.textContent).toContain(strings.confirm.updateAction)
    await flush(() => click(strings.confirm.cancel))

    expect(host.textContent).toContain(strings.update.available(updateInfo.version))
    expect(host.textContent).not.toContain(strings.update.checking)
    expect(platform.downloadAndInstall).toHaveBeenCalledTimes(1)
  })

  it('cancels a pending update approval when a close request replaces it', async () => {
    await offerUpdate()
    const checksBeforeClose = vi.mocked(platform.checkForUpdate).mock.calls.length
    await flush(() => click(strings.update.install))
    expect(host.textContent).toContain(strings.confirm.updateAction)

    await flush(() => requestClose!())
    expect(host.textContent).toContain(strings.confirm.closeAction)
    await flush(() => click(strings.confirm.cancel))
    expect(host.textContent).toContain(strings.update.available(updateInfo.version))

    // The replaced beforeInstall promise must settle false so UpdateNotice can retry.
    await flush(() => click(strings.update.install))
    expect(host.textContent).toContain(strings.confirm.updateAction)
    await flush(() => click(strings.confirm.cancel))

    vi.mocked(platform.checkForUpdate).mockResolvedValue(null)
    await flush(() => window.dispatchEvent(new Event(UPDATE_CHECK_EVENT)))
    expect(platform.checkForUpdate).toHaveBeenCalledTimes(checksBeforeClose + 1)
    expect(host.querySelector('.banner')).toBeNull()

    vi.mocked(platform.checkForUpdate).mockResolvedValue(updateInfo)
    await flush(() => window.dispatchEvent(new Event(UPDATE_CHECK_EVENT)))
    expect(host.textContent).toContain(strings.update.available(updateInfo.version))
    await flush(() => click(strings.update.later))
    expect(host.textContent).not.toContain(strings.update.available(updateInfo.version))
  })
})
