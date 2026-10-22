import type { JSX } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'

import { DocumentModel, type Cursor, type SaveState } from '../document'
import type { Analysis, ReadonlyCode } from '../editing'
import { resolveCursor } from '../editing'
import { MarpRenderer } from '../marp/renderer'
import {
  DEFAULT_SETTINGS,
  platform,
  type AppSettings,
  type ThemePreference,
} from '../platform'
import { basename, dirname } from '../platform/paths'
import { EmptyState } from './EmptyState'
import type { EditorSession, StageApi } from './session'
import { SettingsPanel } from './SettingsPanel'
import { SlideList } from './SlideList'
import { SlideStage, type SlideStageCallbacks } from './SlideStage'
import type { EditSuccess, EditingCursors, StageFocus } from './stageEditor'
import { StatusBar } from './StatusBar'
import { strings } from './strings'
import {
  decideExternalChange,
  isNameTakenError,
  mineFileName,
  planConflictChoice,
  slideAfterReload,
  type ConflictChoice,
  type ExternalChange,
} from './sync'
import { Toolbar } from './Toolbar'

const MIN_SIDEBAR_WIDTH = 120
const MAX_SIDEBAR_WIDTH = 480
const THEME_ORDER: ThemePreference[] = ['system', 'light', 'dark']

type Banner =
  | { kind: 'conflict'; text: string; hasBom: boolean; hash: string }
  | { kind: 'removed'; path: string }
  | { kind: 'unreadable'; path: string; message: string }
  | { kind: 'info'; message: string }

type PendingAction = { kind: 'open'; path: string } | { kind: 'close' }

interface ViewState {
  tick: number
  path: string | null
  saveState: SaveState
  current: number
  total: number
  detail: string | null
  banner: Banner | null
  error: string | null
  busy: boolean
  canUndo: boolean
  canRedo: boolean
  /** 増えたらスライド表示を作り直す */
  deckVersion: number
  /** 増えたらサムネイルを更新する */
  thumbVersion: number
}

const INITIAL_VIEW: ViewState = {
  tick: 0,
  path: null,
  saveState: 'clean',
  current: 0,
  total: 0,
  detail: null,
  banner: null,
  error: null,
  busy: false,
  canUndo: false,
  canRedo: false,
  deckVersion: 0,
  thumbVersion: 0,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  if (error && typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message)
  return strings.errors.unknown
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function bannerMessage(banner: Banner): string {
  switch (banner.kind) {
    case 'conflict':
      return strings.banner.conflict.message
    case 'removed':
      return strings.banner.removed(basename(banner.path))
    case 'unreadable':
      return strings.banner.unreadable(basename(banner.path), banner.message)
    case 'info':
      return banner.message
  }
}

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [recent, setRecent] = useState<string[]>([])
  const [view, setView] = useState<ViewState>(INITIAL_VIEW)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const renderer = useMemo(() => new MarpRenderer((path) => platform.convertFileSrc(path)), [])
  const rendererRef = useRef(renderer)
  const sessionRef = useRef<EditorSession | null>(null)
  const stageApi = useRef<StageApi | null>(null)
  const editingRef = useRef(false)
  const currentRef = useRef(0)
  const pendingRef = useRef<PendingAction | null>(null)
  const focusSeq = useRef(0)
  const externalRef = useRef<(change: ExternalChange) => void>(() => {})

  rendererRef.current = renderer
  currentRef.current = view.current
  pendingRef.current = pending

  /** 状態の変更を反映し、ステータスバー・ツールバーを更新する */
  const sync = useCallback((patch: Partial<ViewState> = {}) => {
    const session = sessionRef.current
    setView((previous) => ({
      ...previous,
      tick: previous.tick + 1,
      path: session?.path ?? null,
      saveState: session?.model.state ?? 'clean',
      total: session?.deck.slides.length ?? 0,
      canUndo: session?.model.canUndo ?? false,
      canRedo: session?.model.canRedo ?? false,
      ...patch,
    }))
  }, [])

  /** 表示HTMLも変わる変更（開く・再読み込み・履歴・ラン境界の削除） */
  const syncDeck = useCallback((patch: Partial<ViewState> = {}) => {
    const session = sessionRef.current
    setView((previous) => ({
      ...previous,
      tick: previous.tick + 1,
      path: session?.path ?? null,
      saveState: session?.model.state ?? 'clean',
      total: session?.deck.slides.length ?? 0,
      canUndo: session?.model.canUndo ?? false,
      canRedo: session?.model.canRedo ?? false,
      deckVersion: previous.deckVersion + 1,
      thumbVersion: previous.thumbVersion + 1,
      ...patch,
    }))
  }, [])

  const nextFocus = useCallback((cursor: Cursor): StageFocus => {
    focusSeq.current += 1
    return { seq: focusSeq.current, cursor }
  }, [])

  const analyzeSession = useCallback((session: EditorSession, analysis: Analysis): void => {
    session.analysis = analysis
    session.deck = session.renderer.update(analysis, session.baseDir)
  }, [])

  // 起動時: 設定と最近使ったファイルを読む
  useEffect(() => {
    let alive = true

    void (async () => {
      try {
        const loaded = await platform.settingsGet()
        if (alive) setSettings(loaded)
      } catch (reason) {
        console.warn('settings_get failed', reason)
      } finally {
        if (alive) setSettingsLoaded(true)
      }
    })()

    void (async () => {
      try {
        const loaded = await platform.recentFilesGet()
        if (alive) setRecent(loaded)
      } catch (reason) {
        console.warn('recent_files_get failed', reason)
      }
    })()

    return () => {
      alive = false
    }
  }, [])

  // テーマの適用（system は prefers-color-scheme に従う）
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
  }, [settings.theme])

  // 設定の保存（ドラッグ中はまとめて、最後の値だけ書く）
  useEffect(() => {
    if (!settingsLoaded) return
    const timer = setTimeout(() => {
      platform.settingsSet(settings).catch((reason: unknown) => {
        sync({ error: strings.errors.settingsFailed(errorMessage(reason)) })
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [settings, settingsLoaded, sync])

  // ウィンドウタイトル（未保存時に ●）
  useEffect(() => {
    const name = view.path ? basename(view.path) : null
    const dirty = view.path !== null && view.saveState !== 'clean'
    const title = strings.windowTitle(name, dirty)
    document.title = title
    platform.setWindowTitle(title).catch((reason: unknown) => {
      console.warn('setTitle failed', reason)
    })
  }, [view.path, view.saveState])

  // 未保存のまま閉じようとしたときだけ、クローズを保留して確認を出す
  useEffect(() => {
    const dirty = view.path !== null && view.saveState !== 'clean'
    if (!dirty) return
    let alive = true
    let unlisten: (() => void) | undefined
    platform
      .onCloseRequested(() => setPending({ kind: 'close' }))
      .then((stop) => {
        if (alive) unlisten = stop
        else stop()
      })
      .catch((reason: unknown) => {
        sync({ error: strings.errors.closeFailed(errorMessage(reason)) })
      })
    return () => {
      alive = false
      unlisten?.()
    }
  }, [view.path, view.saveState, sync])

  const openPathNow = useCallback(
    async (path: string) => {
      setView((previous) => ({ ...previous, busy: true }))
      try {
        stageApi.current?.endEditing()
        await platform.stopWatching().catch(() => {})
        const file = await platform.openFile(path)
        const baseDir = dirname(path)
        const model = new DocumentModel(file.text, { hasBom: file.hasBom, diskHash: file.hash })
        const { analysis, deck } = rendererRef.current.analyze(model.text, baseDir)
        sessionRef.current = { path, baseDir, model, renderer: rendererRef.current, analysis, deck }
        editingRef.current = false
        setView((previous) => ({
          ...previous,
          tick: previous.tick + 1,
          path,
          saveState: model.state,
          current: 0,
          total: deck.slides.length,
          detail: null,
          banner: null,
          error: null,
          busy: false,
          canUndo: false,
          canRedo: false,
          deckVersion: previous.deckVersion + 1,
          thumbVersion: previous.thumbVersion + 1,
        }))
        platform
          .recentFilesAdd(path)
          .then((list) => setRecent(list))
          .catch((reason: unknown) => {
            sync({ error: strings.errors.recentFailed(errorMessage(reason)) })
          })
      } catch (reason) {
        sync({ busy: false, error: strings.errors.openFailed(errorMessage(reason)) })
      }
    },
    [sync],
  )

  const requestOpen = useCallback(
    (path: string) => {
      const session = sessionRef.current
      if (session && session.model.state !== 'clean') {
        setPending({ kind: 'open', path })
        return
      }
      void openPathNow(path)
    },
    [openPathNow],
  )

  const openDialog = useCallback(async () => {
    try {
      const selected = await platform.pickMarkdownFile(strings.fileDialog.markdownFilter)
      if (selected) requestOpen(selected)
    } catch (reason) {
      sync({ error: strings.errors.openFailed(errorMessage(reason)) })
    }
  }, [requestOpen, sync])

  /** 保存する。conflict のときは帯を出す */
  const runSave = useCallback(
    async (expectedHash?: string): Promise<boolean> => {
      const session = sessionRef.current
      if (!session) return false
      stageApi.current?.endEditing()
      if (session.model.state === 'readonly') {
        sync({ detail: strings.status.saveState.readonly })
        return false
      }
      setView((previous) => ({ ...previous, busy: true }))
      try {
        const result = await platform.saveFile(
          session.path,
          session.model.serialize(),
          session.model.hasBom,
          expectedHash ?? session.model.diskHash,
        )
        if (result.ok) {
          session.model.markSaved(result.hash)
          sync({ busy: false, error: null, banner: null })
          return true
        }
        if (result.kind === 'conflict') {
          session.model.markConflict()
          const disk = await platform.openFile(session.path).catch(() => null)
          sync({
            busy: false,
            banner: disk
              ? {
                  kind: 'conflict',
                  text: disk.text,
                  hasBom: disk.hasBom,
                  hash: result.diskHash || disk.hash,
                }
              : { kind: 'unreadable', path: session.path, message: strings.errors.unknown },
          })
          return false
        }
        sync({ busy: false, error: strings.errors.saveFailed(result.message) })
        return false
      } catch (reason) {
        sync({ busy: false, error: strings.errors.saveFailed(errorMessage(reason)) })
        return false
      }
    },
    [sync],
  )

  /** 競合中: 自分の内容を `<名前>.mine.md` などへ退避する */
  const writeMineCopy = useCallback(
    async (session: EditorSession): Promise<string | null> => {
      const text = session.model.serialize()
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const target = mineFileName(session.path, attempt)
        try {
          const result = await platform.writeNewFile(target, text, session.model.hasBom)
          if (result.ok) return target
          if (result.kind === 'conflict' || (result.kind === 'io' && isNameTakenError(result.message))) continue
          sync({ error: strings.errors.copyFailed(result.kind === 'io' ? result.message : strings.errors.unknown) })
          return null
        } catch (reason) {
          if (isNameTakenError(reason)) continue
          sync({ error: strings.errors.copyFailed(errorMessage(reason)) })
          return null
        }
      }
      sync({ error: strings.errors.copyFailed(strings.errors.unknown) })
      return null
    },
    [sync],
  )

  const applyReload = useCallback(
    (raw: string, hash: string, hasBom: boolean) => {
      const session = sessionRef.current
      if (!session) return
      session.model.reload(raw, hash, hasBom)
      const { analysis, deck } = session.renderer.analyze(session.model.text, session.baseDir)
      session.analysis = analysis
      session.deck = deck
      session.focus = undefined
      const current = slideAfterReload(currentRef.current, deck.slides.length)
      syncDeck({ current, detail: null, banner: null, error: null })
    },
    [syncDeck],
  )

  const chooseConflict = useCallback(
    async (choice: ConflictChoice) => {
      const session = sessionRef.current
      const banner = view.banner
      if (!session || banner?.kind !== 'conflict') return
      const plan = planConflictChoice(choice, { hash: banner.hash })
      stageApi.current?.endEditing()
      setView((previous) => ({ ...previous, busy: true }))

      if (plan.writeMineCopy) {
        const saved = await writeMineCopy(session)
        if (!saved) {
          setView((previous) => ({ ...previous, busy: false }))
          return
        }
        if (plan.reloadDisk) {
          applyReload(banner.text, banner.hash, banner.hasBom)
          sync({ banner: { kind: 'info', message: strings.banner.mineSaved(saved) }, busy: false })
        }
        return
      }

      if (plan.save) {
        await runSave(plan.save.expectedHash)
        return
      }

      if (plan.reloadDisk) {
        applyReload(banner.text, banner.hash, banner.hasBom)
        sync({ busy: false })
        return
      }
      setView((previous) => ({ ...previous, busy: false }))
    },
    [applyReload, runSave, sync, view.banner, writeMineCopy],
  )

  /** 履歴。再描画後に記録したカーソル位置へ戻す */
  const restore = useCallback(
    (direction: 'undo' | 'redo') => {
      const session = sessionRef.current
      if (!session) return
      stageApi.current?.endEditing()
      const before = session.model.text
      const cursor = direction === 'undo' ? session.model.undo() : session.model.redo()
      if (session.model.text === before) return
      const { analysis, deck } = session.renderer.analyze(session.model.text, session.baseDir)
      const resolved = cursor ? resolveCursor(analysis, cursor) ?? cursor : undefined
      session.analysis = analysis
      session.deck = deck
      session.focus = resolved ? nextFocus(resolved) : undefined
      syncDeck({ detail: null })
    },
    [nextFocus, syncDeck],
  )

  const goTo = useCallback(
    (index: number) => {
      const session = sessionRef.current
      if (!session) return
      stageApi.current?.endEditing()
      const total = session.deck.slides.length
      if (total === 0) return
      const next = clamp(index, 0, total - 1)
      currentRef.current = next
      sync({ current: next, detail: null })
    },
    [sync],
  )

  const goBy = useCallback(
    (delta: number) => {
      goTo(currentRef.current + delta)
    },
    [goTo],
  )

  const handleExternal = useCallback(
    (change: ExternalChange) => {
      const session = sessionRef.current
      if (!session || session.path !== change.path) return
      if (change.type === 'changed') {
        // 読み直せたので、削除・読み取り不能の帯は用済み
        setView((previous) =>
          previous.banner?.kind === 'removed' || previous.banner?.kind === 'unreadable'
            ? { ...previous, banner: null }
            : previous,
        )
      }
      if (editingRef.current) stageApi.current?.endEditing()
      const decision = decideExternalChange(
        {
          path: session.path,
          dirty: session.model.state !== 'clean',
          currentText: session.model.serialize(),
          diskHash: session.model.diskHash,
        },
        change,
      )
      switch (decision.type) {
        case 'ignore':
          return
        case 'synced':
          session.model.markSaved(decision.hash)
          session.model.hasBom = decision.hasBom
          sync()
          return
        case 'reload':
          applyReload(decision.text, decision.hash, decision.hasBom)
          return
        case 'conflict':
          session.model.markConflict()
          sync({
            banner: { kind: 'conflict', text: decision.text, hasBom: decision.hasBom, hash: decision.hash },
          })
          return
        case 'removed':
          sync({ banner: { kind: 'removed', path: session.path } })
          return
        case 'unreadable':
          sync({ banner: { kind: 'unreadable', path: session.path, message: decision.message } })
          return
      }
    },
    [applyReload, sync],
  )
  externalRef.current = handleExternal

  // ファイル監視
  useEffect(() => {
    let alive = true
    let unlisten: (() => void) | undefined
    platform
      .listenFileEvents({
        changed: (event) => externalRef.current({ type: 'changed', ...event }),
        removed: (event) => externalRef.current({ type: 'removed', path: event.path }),
        unreadable: (event) =>
          externalRef.current({ type: 'unreadable', path: event.path, message: event.message }),
      })
      .then((stop) => {
        if (alive) unlisten = stop
        else stop()
      })
      .catch((reason: unknown) => {
        sync({ error: strings.errors.openFailed(errorMessage(reason)) })
      })
    return () => {
      alive = false
      unlisten?.()
      void platform.stopWatching().catch(() => {})
    }
  }, [sync])

  const stageCallbacks: SlideStageCallbacks = {
    onBegin: (label) => {
      editingRef.current = true
      sync({ detail: label })
    },
    onEnd: () => {
      editingRef.current = false
      setView((previous) => ({
        ...previous,
        tick: previous.tick + 1,
        detail: null,
        thumbVersion: previous.thumbVersion + 1,
      }))
    },
    onNotice: (code: ReadonlyCode) => {
      sync({ detail: strings.status.reasons[code] })
    },
    onCommit: (result: EditSuccess, cursors: EditingCursors) => {
      const session = sessionRef.current
      if (!session) return
      try {
        session.model.edit(result.edit, cursors)
      } catch (reason) {
        sync({ detail: strings.errors.unknown })
        return
      }
      analyzeSession(session, result.analysis)
      sync()
    },
    onCrossRun: (result: EditSuccess, target: Cursor, before?: Cursor) => {
      const session = sessionRef.current
      if (!session) return
      try {
        session.model.edit(result.edit, { before, after: target })
      } catch (reason) {
        sync({ detail: strings.errors.unknown })
        return
      }
      analyzeSession(session, result.analysis)
      session.focus = nextFocus(target)
      editingRef.current = false
      syncDeck({ detail: null })
    },
    onHistory: (direction) => restore(direction),
  }

  const continuePending = useCallback(
    async (mode: 'save' | 'discard') => {
      const action = pendingRef.current
      if (!action) return
      if (mode === 'save') {
        const saved = await runSave()
        if (!saved) {
          setPending(null)
          return
        }
      }
      setPending(null)
      if (action.kind === 'open') {
        await openPathNow(action.path)
        return
      }
      try {
        await platform.forceClose()
      } catch (reason) {
        sync({ error: strings.errors.closeFailed(errorMessage(reason)) })
      }
    },
    [openPathNow, runSave, sync],
  )

  // キー操作
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (pendingRef.current) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void runSave()
        return
      }
      if (mod && !event.altKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openDialog()
        return
      }
      if (isEditableTarget(event.target)) return
      if (mod && !event.altKey && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
        if (editingRef.current) return
        event.preventDefault()
        restore(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo')
        return
      }
      if (editingRef.current) return
      const session = sessionRef.current
      if (!session) return
      const total = session.deck.slides.length
      if (total === 0) return

      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault()
          goBy(1)
          break
        case 'ArrowLeft':
          event.preventDefault()
          goBy(-1)
          break
        case 'PageDown':
          event.preventDefault()
          goBy(1)
          break
        case 'PageUp':
          event.preventDefault()
          goBy(-1)
          break
        case 'Home':
          event.preventDefault()
          goTo(0)
          break
        case 'End':
          event.preventDefault()
          goTo(total - 1)
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [goBy, goTo, openDialog, restore, runSave])

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((previous) => ({ ...previous, ...patch }))
  }, [])

  const cycleTheme = useCallback(() => {
    setSettings((previous) => {
      const index = THEME_ORDER.indexOf(previous.theme)
      const next = THEME_ORDER[(index + 1) % THEME_ORDER.length] ?? 'system'
      return { ...previous, theme: next }
    })
  }, [])

  const beginResize = useCallback(
    (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      event.preventDefault()

      const startX = event.clientX
      const startWidth = settings.sidebarWidth
      document.body.style.cursor = 'col-resize'

      const onMove = (moveEvent: PointerEvent) => {
        const width = clamp(
          Math.round(startWidth + moveEvent.clientX - startX),
          MIN_SIDEBAR_WIDTH,
          MAX_SIDEBAR_WIDTH,
        )
        setSettings((previous) =>
          previous.sidebarWidth === width ? previous : { ...previous, sidebarWidth: width },
        )
      }

      const onUp = () => {
        document.body.style.cursor = ''
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }

      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [settings.sidebarWidth],
  )

  const sidebarCollapsed = settings.sidebarCollapsed
  const session = sessionRef.current
  const slideTotal = session?.deck.slides.length ?? 0
  const conflictBanner = view.banner?.kind === 'conflict' ? view.banner : null

  return (
    <div class="app">
      <Toolbar
        theme={settings.theme}
        sidebarCollapsed={sidebarCollapsed}
        busy={view.busy}
        canSave={session !== null && view.saveState !== 'readonly'}
        canUndo={view.canUndo}
        canRedo={view.canRedo}
        onOpen={() => void openDialog()}
        onSave={() => void runSave()}
        onUndo={() => restore('undo')}
        onRedo={() => restore('redo')}
        onToggleSidebar={() => updateSettings({ sidebarCollapsed: !sidebarCollapsed })}
        onCycleTheme={cycleTheme}
        onOpenSettings={() => setSettingsOpen((open) => !open)}
      />

      {view.error ? (
        <div class="banner" data-tone="error" role="alert">
          <span class="banner-message">{view.error}</span>
          <button type="button" onClick={() => sync({ error: null })}>
            {strings.errors.dismiss}
          </button>
        </div>
      ) : null}

      {view.banner ? (
        <div class="banner" data-tone="warning" role="status">
          <span class="banner-message">{bannerMessage(view.banner)}</span>
          {conflictBanner ? (
            <span class="banner-actions">
              <button type="button" onClick={() => void chooseConflict('load-disk')}>
                {strings.banner.conflict.load}
              </button>
              <button type="button" onClick={() => void chooseConflict('overwrite')}>
                {strings.banner.conflict.overwrite}
              </button>
              <button type="button" onClick={() => void chooseConflict('save-mine')}>
                {strings.banner.conflict.mine}
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => sync({ banner: null })}>
              {strings.banner.dismiss}
            </button>
          )}
        </div>
      ) : null}

      <div class="main">
        {!sidebarCollapsed ? (
          <>
            <aside class="sidebar" style={{ width: `${settings.sidebarWidth}px` }}>
              <SlideList
                deck={session?.deck ?? null}
                version={view.thumbVersion}
                current={view.current}
                onSelect={goTo}
                onCollapse={() => updateSettings({ sidebarCollapsed: true })}
              />
            </aside>
            <div
              class="resizer"
              role="separator"
              aria-orientation="vertical"
              title={strings.sidebar.resizeHandle}
              onPointerDown={beginResize}
            />
          </>
        ) : null}

        {session ? (
          <SlideStage
            session={session}
            deckVersion={view.deckVersion}
            current={view.current}
            apiRef={stageApi}
            callbacks={stageCallbacks}
          />
        ) : (
          <EmptyState
            recent={recent}
            busy={view.busy}
            onOpen={() => void openDialog()}
            onOpenRecent={requestOpen}
          />
        )}
      </div>

      <StatusBar
        path={session?.path ?? null}
        saveState={view.saveState}
        slideIndex={view.current}
        slideTotal={slideTotal}
        detail={view.detail}
      />

      {settingsOpen ? (
        <SettingsPanel
          settings={settings}
          onThemeChange={(theme) => updateSettings({ theme })}
          onResetSidebarWidth={() => updateSettings({ sidebarWidth: DEFAULT_SETTINGS.sidebarWidth })}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {pending ? (
        <div class="modal-backdrop">
          <div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
            <h2 class="modal-title" id="confirm-title">
              {strings.confirm.title}
            </h2>
            <p class="modal-message">{strings.confirm.message}</p>
            <p class="modal-action">
              {pending.kind === 'open' ? strings.confirm.openAction : strings.confirm.closeAction}
            </p>
            <div class="modal-buttons">
              <button type="button" onClick={() => void continuePending('save')}>
                {strings.confirm.saveAndContinue}
              </button>
              <button type="button" onClick={() => void continuePending('discard')}>
                {strings.confirm.discard}
              </button>
              <button type="button" onClick={() => setPending(null)}>
                {strings.confirm.cancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
