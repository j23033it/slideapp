import type { JSX } from 'preact'
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Marp } from '@marp-team/marp-core'

import { DocumentModel, type Cursor, type SaveState } from '../document'
import type { Analysis, ReadonlyCode } from '../editing'
import type { ExportReport } from '../export/pptx'
import { resolveCursor } from '../editing'
import { MarpRenderer } from '../marp/renderer'
import { registerThemes } from '../marp/themes'
import { installImagePathRule, type MarkdownItLike } from '../marp/urls'
import {
  DEFAULT_SETTINGS,
  platform,
  type AppSettings,
  type ThemeConfig,
  type ThemePreference,
} from '../platform'
import { basename, dirname } from '../platform/paths'
import { EmptyState } from './EmptyState'
import type { EditorSession, StageApi } from './session'
import { editorSessionSaveState, planHistoryRestore } from './session'
import { SettingsPanel } from './SettingsPanel'
import { SlideList } from './SlideList'
import { SlideStage, type SlideStageCallbacks } from './SlideStage'
import type { EditSuccess, EditingCursors, StageFocus } from './stageEditor'
import { StatusBar } from './StatusBar'
import { strings } from './strings'
import { UPDATE_CHECK_EVENT, UpdateNotice } from './UpdateNotice'
import {
  canApplyDiskResult,
  decideExternalChange,
  diskChangedSinceBanner,
  hasUnsavedChanges,
  mineFileName,
  needsOpenReconfirm,
  planConflictBanner,
  planConflictChoice,
  planMineCopyReload,
  planSaveCompletion,
  slideAfterReload,
  type ContentSnapshot,
  type ConflictChoice,
  type ExternalChange,
  type DiskObservation,
} from './sync'
import { Toolbar } from './Toolbar'

const MIN_SIDEBAR_WIDTH = 120
const MAX_SIDEBAR_WIDTH = 480
const THEME_ORDER: ThemePreference[] = ['system', 'light', 'dark']

type Banner =
  | { kind: 'conflict'; text: string; hasBom: boolean; hash: string }
  | { kind: 'removed'; path: string }
  | { kind: 'unreadable'; path: string; message: string }
  | { kind: 'themeWarnings'; warnings: string[] }
  | { kind: 'info'; message: string }

type PendingAction =
  | { kind: 'open'; path: string }
  | { kind: 'close' }
  | { kind: 'update'; resolve: (approved: boolean) => void }

type ExportNotice =
  | { kind: 'success'; path: string; report: ExportReport }
  | { kind: 'error'; message: string; report?: ExportReport; details?: string[] }

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

async function readThemeConfig(path: string): Promise<ThemeConfig> {
  try {
    return await platform.readThemeConfig(path)
  } catch (reason) {
    return { themes: [], warnings: [strings.banner.themeConfigReadFailed(errorMessage(reason))] }
  }
}

function registerThemeConfig(renderer: MarpRenderer, config: ThemeConfig): string[] {
  const registration = renderer.setThemes(config.themes)
  return [...config.warnings, ...registration.warnings]
}

function themeWarningsBanner(warnings: string[]): Banner | null {
  return warnings.length > 0 ? { kind: 'themeWarnings', warnings } : null
}

function createExportMarp(baseDir: string, config: ThemeConfig): Marp {
  const marp = new Marp({ script: false, math: 'mathjax' })
  const toAssetUrl = (path: string) => platform.convertFileSrc(path)
  installImagePathRule(marp.markdown as MarkdownItLike, () => baseDir, toAssetUrl)
  registerThemes(marp, config.themes, toAssetUrl)
  return marp
}

function hasExportReportDetails(report: ExportReport): boolean {
  return report.rasterizedCount > 0 || report.rasterizedElements.length > 0 ||
    report.substitutedFonts.length > 0 || report.warnings.length > 0 || (report.errors?.length ?? 0) > 0
}

function groupExportItemsBySlide(items: readonly { slide: number }[]): { slide: number; count: number }[] {
  const counts = new Map<number, number>()
  for (const item of items) counts.set(item.slide, (counts.get(item.slide) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([slide, count]) => ({ slide, count }))
}

function exportWarningMessages(warnings: readonly string[]): string[] {
  const messages = new Set<string>()
  for (const warning of warnings) {
    // reportElementError also mirrors errors into warnings; the Japanese error summary covers those.
    if (warning.startsWith('Error on slide ')) continue
    if (warning.startsWith('Web font stylesheet could not be embedded:')) {
      messages.add(strings.export.webFontUnavailable)
    } else if (warning.startsWith('Font load failed:')) {
      messages.add(strings.export.fontLoadFailed)
    } else {
      messages.add(strings.export.genericWarning)
    }
  }
  return [...messages]
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
    case 'themeWarnings':
      return strings.banner.themeWarnings(banner.warnings)
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
  const [updateInstallLocked, setUpdateInstallLocked] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null)
  const [exportReportOpen, setExportReportOpen] = useState(false)

  const renderer = useMemo(() => new MarpRenderer((path) => platform.convertFileSrc(path)), [])
  const rendererRef = useRef(renderer)
  const sessionRef = useRef<EditorSession | null>(null)
  const stageApi = useRef<StageApi | null>(null)
  const editingRef = useRef(false)
  const currentRef = useRef(0)
  const pendingRef = useRef<PendingAction | null>(null)
  const pendingOperationRef = useRef(0)
  const updateInstallLockedRef = useRef(false)
  const exportingRef = useRef(false)
  const bannerRef = useRef<Banner | null>(null)
  const focusSeq = useRef(0)
  const externalRef = useRef<(change: ExternalChange) => void>(() => {})
  const pendingUpdateExternalRef = useRef<{ change: ExternalChange; observation: DiskObservation } | null>(null)
  const externalChangeRequest = useRef(0)
  const diskObservationRef = useRef<DiskObservation>({ generation: 0, change: null })
  const openingRef = useRef<{ path: string; observation: DiskObservation } | null>(null)

  rendererRef.current = renderer
  currentRef.current = view.current
  pendingRef.current = pending
  bannerRef.current = view.banner

  const replacePending = useCallback((
    next: PendingAction | null,
    options: { updateResolution?: boolean } = {},
  ): void => {
    const previous = pendingRef.current
    pendingOperationRef.current += 1
    pendingRef.current = next
    setPending(next)
    if (previous?.kind === 'update' && previous !== next) {
      previous.resolve(options.updateResolution ?? false)
    }
  }, [])

  /** 状態の変更を反映し、ステータスバー・ツールバーを更新する */
  const sync = useCallback((patch: Partial<ViewState> = {}) => {
    const session = sessionRef.current
    setView((previous) => ({
      ...previous,
      tick: previous.tick + 1,
      path: session?.path ?? null,
      saveState: session ? editorSessionSaveState(session) : 'clean',
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
      saveState: session ? editorSessionSaveState(session) : 'clean',
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

  /** IME変換中なら操作を予約する。確定とコミットの後に実行される */
  const deferIfComposing = useCallback((action: () => void): boolean => {
    return stageApi.current?.deferWhileComposing(action) ?? false
  }, [])

  /** 非同期応答後にモデルを置き換える操作は、IME確定とコミットを待ってから再照合する。 */
  const waitForComposition = useCallback((): Promise<void> => {
    const stage = stageApi.current
    if (!stage?.isComposing()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      if (!stage.deferWhileComposing(resolve)) resolve()
    })
  }, [])

  /** 更新を始める前にIMEを確定し、未保存確認を既存の終了ダイアログへ渡す */
  const beforeUpdateInstall = useCallback(async (): Promise<boolean> => {
    if (updateInstallLockedRef.current) return false
    await waitForComposition()
    if (
      updateInstallLockedRef.current ||
      pendingRef.current ||
      openingRef.current ||
      view.busy
    ) return false

    stageApi.current?.endEditing()
    const session = sessionRef.current
    if (session && hasUnsavedChanges(editorSessionSaveState(session))) {
      return new Promise<boolean>((resolve) => replacePending({ kind: 'update', resolve }))
    }

    updateInstallLockedRef.current = true
    setUpdateInstallLocked(true)
    return true
  }, [replacePending, view.busy, waitForComposition])

  const bufferUpdateExternal = useCallback((change: ExternalChange, observation: DiskObservation): void => {
    // テーマ設定の読み込みを終えた古い通知などで、後から届いた観測を失わない。
    if (!canApplyDiskResult(observation, diskObservationRef.current)) return
    const pending = pendingUpdateExternalRef.current
    if (pending && pending.observation.generation > observation.generation) return
    pendingUpdateExternalRef.current = { change, observation }
  }, [])

  const releaseUpdateInstall = useCallback(() => {
    updateInstallLockedRef.current = false
    setUpdateInstallLocked(false)
    const pending = pendingUpdateExternalRef.current
    pendingUpdateExternalRef.current = null
    if (pending && canApplyDiskResult(pending.observation, diskObservationRef.current)) {
      externalRef.current(pending.change)
    }
  }, [])

  /** 監視先を戻したときの読み込み結果も、外部変更と同じ規則で反映する */
  const restoreSessionWatch = useCallback(
    async (session: EditorSession): Promise<void> => {
      const restored = await platform.openFile(session.path).catch(() => null)
      await waitForComposition()
      if (restored) {
        externalRef.current({ type: 'changed', path: session.path, ...restored })
      }
    },
    [waitForComposition],
  )

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

  // 開いている間は閉じるイベントを受け、IME確定後に未保存確認またはクローズを行う
  useEffect(() => {
    if (view.path === null) return
    let alive = true
    let unlisten: (() => void) | undefined

    const handleClose = (): void => {
      if (updateInstallLockedRef.current) {
        platform.forceClose().catch((reason: unknown) => {
          sync({ error: strings.errors.closeFailed(errorMessage(reason)) })
        })
        return
      }
      if (deferIfComposing(handleClose)) return
      const session = sessionRef.current
      if (session && hasUnsavedChanges(editorSessionSaveState(session))) {
        replacePending({ kind: 'close' })
        return
      }
      platform.forceClose().catch((reason: unknown) => {
        sync({ error: strings.errors.closeFailed(errorMessage(reason)) })
      })
    }

    platform
      .onCloseRequested(handleClose)
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
  }, [deferIfComposing, replacePending, view.path, sync])

  const openPathNow = useCallback(
    async (path: string, options: { allowDirty?: boolean } = {}) => {
      if (updateInstallLockedRef.current) return
      if (deferIfComposing(() => void openPathNow(path, options))) return
      const startingSession = sessionRef.current
      const baseline: ContentSnapshot | null = startingSession
        ? { text: startingSession.model.serialize(), hasBom: startingSession.model.hasBom }
        : null
      const startedObservation = diskObservationRef.current
      const opening = { path, observation: startedObservation }
      openingRef.current = opening
      setView((previous) => ({ ...previous, busy: true }))
      try {
        stageApi.current?.endEditing()
        // Rust の open_file は成功時に監視を新しいファイルへ切り替える。
        // ここで stopWatching すると、開くのに失敗したとき元の監視が止まったままになる。
        let file = await platform.openFile(path)
        const themeConfig = await readThemeConfig(path)
        await waitForComposition()
        const existing = sessionRef.current
        if (existing) {
          // 読み込みを待つ間に元のファイルが編集されていたら、置き換えずに確認をやり直す。
          const reconfirm = needsOpenReconfirm({
            snapshot: baseline,
            current: { text: existing.model.serialize(), hasBom: existing.model.hasBom },
            state: editorSessionSaveState(existing),
            allowDirty: options.allowDirty ?? false,
          })
          if (reconfirm) {
            if (existing.path !== path) {
              // 監視が新しいファイルへ移っているため、元のファイルへ戻す
              await restoreSessionWatch(existing)
            }
            replacePending({ kind: 'open', path })
            setView((previous) => ({ ...previous, busy: false }))
            return
          }
        }
        // open_file は応答前から監視するため、新セッションの作成前に
        // 受けた通知を照合する。ここまで新しいファイルに未保存の編集はない。
        const buffered = canApplyDiskResult(startedObservation, opening.observation)
          ? null
          : opening.observation.change
        if (buffered?.type === 'changed') file = buffered
        const banner: Banner | null = buffered?.type === 'removed'
          ? { kind: 'removed', path }
          : buffered?.type === 'unreadable'
            ? { kind: 'unreadable', path, message: buffered.message }
            : null
        const baseDir = dirname(path)
        const model = new DocumentModel(file.text, { hasBom: file.hasBom, diskHash: file.hash })
        const themeWarnings = registerThemeConfig(rendererRef.current, themeConfig)
        const { analysis, deck } = rendererRef.current.analyze(model.text, baseDir)
        const nextSession: EditorSession = {
          path,
          baseDir,
          model,
          savedSnapshot: { text: model.serialize(), hasBom: model.hasBom },
          conflict: false,
          renderer: rendererRef.current,
          themeConfig,
          analysis,
          deck,
        }
        sessionRef.current = nextSession
        editingRef.current = false
        setView((previous) => ({
          ...previous,
          tick: previous.tick + 1,
          path,
          saveState: editorSessionSaveState(nextSession),
          current: 0,
          total: deck.slides.length,
          detail: null,
          // 削除・読み取り不能の知らせを、テーマ設定の警告より優先する
          banner: banner ?? themeWarningsBanner(themeWarnings),
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
        // open_file 成功後にフロント側のモデル構築・解析が拒否した場合も、
        // Rust の監視だけが拒否対象へ残らないよう元のファイルへ戻す。
        const restoreSession = sessionRef.current ?? startingSession
        if (restoreSession) {
          await restoreSessionWatch(restoreSession)
        } else {
          await platform.stopWatching().catch(() => {})
        }
        sync({ busy: false, error: strings.errors.openFailed(errorMessage(reason)) })
      } finally {
        if (openingRef.current === opening) openingRef.current = null
      }
    },
    [deferIfComposing, replacePending, restoreSessionWatch, sync, waitForComposition],
  )

  const requestOpen = useCallback(
    (path: string) => {
      if (updateInstallLockedRef.current) return
      if (deferIfComposing(() => requestOpen(path))) return
      const session = sessionRef.current
      if (session && hasUnsavedChanges(editorSessionSaveState(session))) {
        replacePending({ kind: 'open', path })
        return
      }
      void openPathNow(path)
    },
    [deferIfComposing, openPathNow, replacePending],
  )

  const openDialogNow = useCallback(async () => {
    try {
      const selected = await platform.pickMarkdownFile(strings.fileDialog.markdownFilter)
      if (selected) requestOpen(selected)
    } catch (reason) {
      sync({ error: strings.errors.openFailed(errorMessage(reason)) })
    }
  }, [requestOpen, sync])

  const openDialog = useCallback(() => {
    if (deferIfComposing(() => void openDialogNow())) return
    void openDialogNow()
  }, [deferIfComposing, openDialogNow])

  /** 保存する。conflict のときは帯を出す */
  const performSave = useCallback(
    async (expectedHash?: string): Promise<boolean> => {
      if (updateInstallLockedRef.current) return false
      const session = sessionRef.current
      if (!session) return false
      stageApi.current?.endEditing()
      if (editorSessionSaveState(session) === 'readonly') {
        sync({ detail: strings.status.saveState.readonly })
        return false
      }
      // 保存を始めた時点の内容。応答を待つ間の追加入力は保存済みにしない。
      const snapshot: ContentSnapshot = {
        text: session.model.serialize(),
        hasBom: session.model.hasBom,
      }
      const expected = expectedHash ?? session.model.diskHash
      const observation = diskObservationRef.current
      setView((previous) => ({ ...previous, busy: true }))
      try {
        const result = await platform.saveFile(session.path, snapshot.text, snapshot.hasBom, expected)
        if (sessionRef.current !== session) return true
        if (result.ok) {
          if (!canApplyDiskResult(observation, diskObservationRef.current, result.hash)) {
            sync({ busy: false })
            return false
          }
          const completion = planSaveCompletion(
            snapshot,
            { text: session.model.serialize(), hasBom: session.model.hasBom },
            result.hash,
          )
          session.savedSnapshot = completion.savedSnapshot
          session.conflict = false
          if (completion.markSaved) {
            session.model.markSaved(completion.diskHash)
          } else {
            // 追加入力は未保存のまま残し、ディスクのハッシュだけを進める。
            session.model.diskHash = completion.diskHash
            session.model.breakHistoryGroup()
          }
          sync({ busy: false, error: null, banner: null })
          return true
        }
        if (result.kind === 'conflict') {
          session.model.markConflict()
          session.conflict = true
          const conflictObservation = diskObservationRef.current
          const disk = await platform.openFile(session.path).catch(() => null)
          if (sessionRef.current !== session) return false
          if (!canApplyDiskResult(conflictObservation, diskObservationRef.current)) {
            sync({ busy: false })
            return false
          }
          const notice = planConflictBanner(disk)
          sync({
            busy: false,
            banner:
              notice.kind === 'conflict'
                ? notice
                : { kind: 'unreadable', path: session.path, message: strings.errors.unknown },
          })
          return false
        }
        sync({
          busy: false,
          error: strings.errors.saveFailed(result.kind === 'io' ? result.message : strings.errors.unknown),
        })
        return false
      } catch (reason) {
        sync({ busy: false, error: strings.errors.saveFailed(errorMessage(reason)) })
        return false
      }
    },
    [sync],
  )

  /** IME変換中は確定とコミットを待ってから保存する */
  const runSave = useCallback(
    (expectedHash?: string): Promise<boolean> => {
      if (updateInstallLockedRef.current) return Promise.resolve(false)
      const stage = stageApi.current
      if (!stage?.isComposing()) return performSave(expectedHash)
      return new Promise<boolean>((resolve) => {
        const action = (): void => {
          void performSave(expectedHash).then(resolve)
        }
        if (!stage.deferWhileComposing(action)) action()
      })
    },
    [performSave],
  )

  /** IME確定後の内容を固定し、PPTXは元のMarkdownを保存せずに別ファイルへ出力する */
  const runPptxExport = useCallback(async (): Promise<void> => {
    if (
      exportingRef.current || updateInstallLockedRef.current || pendingRef.current || view.busy
    ) return
    const session = sessionRef.current
    if (!session) return

    exportingRef.current = true
    setExporting(true)
    setExportNotice(null)
    setExportReportOpen(false)
    try {
      await waitForComposition()
      if (updateInstallLockedRef.current || pendingRef.current) return
      if (sessionRef.current === session) stageApi.current?.endEditing()

      // ダイアログや生成を待つ間に編集・ファイル切り替えがあっても、開始時の内容を使う。
      const snapshot = {
        markdown: session.model.serialize(),
        path: session.path,
        baseDir: session.baseDir,
        themeConfig: session.themeConfig,
      }
      const pptx = await import('../export/pptx')
      const path = await platform.pickPptxSavePath(pptx.defaultPptxPath(snapshot.path))
      if (!path) return

      const { bytes, report } = await pptx.exportPptx(
        {
          markdown: snapshot.markdown,
          marp: createExportMarp(snapshot.baseDir, snapshot.themeConfig),
          baseDir: snapshot.baseDir,
        },
        { title: snapshot.path, toAssetUrl: (assetPath) => platform.convertFileSrc(assetPath) },
      )
      try {
        await platform.writeBinary(path, bytes)
      } catch (reason) {
        setExportNotice({
          kind: 'error',
          message: strings.export.writeFailed(basename(path)),
          report,
          details: [errorMessage(reason)],
        })
        setExportReportOpen(hasExportReportDetails(report))
        return
      }

      if (report.errors?.length) {
        setExportNotice({
          kind: 'error',
          message: strings.export.partial(basename(path)),
          report,
        })
        setExportReportOpen(true)
      } else {
        setExportNotice({ kind: 'success', path, report })
        setExportReportOpen(hasExportReportDetails(report))
      }
    } catch (reason) {
      setExportNotice({
        kind: 'error',
        message: strings.export.failed,
        details: [errorMessage(reason)],
      })
    } finally {
      exportingRef.current = false
      setExporting(false)
    }
  }, [view.busy, waitForComposition])

  /** 競合中: 自分の内容を `<名前>.mine.md` などへ退避する */
  const writeMineCopy = useCallback(
    async (session: EditorSession, snapshot: ContentSnapshot): Promise<string | null> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const target = mineFileName(session.path, attempt)
        try {
          const result = await platform.writeNewFile(target, snapshot.text, snapshot.hasBom)
          if (result.ok) return target
          if (result.kind === 'exists' || result.kind === 'conflict') continue
          sync({ error: strings.errors.copyFailed(result.message) })
          return null
        } catch (reason) {
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
    (
      session: EditorSession,
      raw: string,
      hash: string,
      hasBom: boolean,
      themeConfig: ThemeConfig,
    ): string[] | null => {
      if (sessionRef.current !== session) return null
      const themeWarnings = registerThemeConfig(session.renderer, themeConfig)
      session.themeConfig = themeConfig
      session.model.reload(raw, hash, hasBom)
      session.savedSnapshot = { text: raw, hasBom }
      session.conflict = false
      const { analysis, deck } = session.renderer.analyze(session.model.text, session.baseDir)
      session.analysis = analysis
      session.deck = deck
      session.focus = undefined
      const current = slideAfterReload(currentRef.current, deck.slides.length)
      syncDeck({
        current,
        detail: null,
        banner: themeWarningsBanner(themeWarnings),
        error: null,
      })
      return themeWarnings
    },
    [syncDeck],
  )

  const chooseConflictNow = useCallback(
    async (choice: ConflictChoice) => {
      const session = sessionRef.current
      const banner = bannerRef.current
      if (!session || banner?.kind !== 'conflict') return
      stageApi.current?.endEditing()
      // 帯を出した時点の内容。待機中の追加入力は捨てない。
      const snapshot: ContentSnapshot = {
        text: session.model.serialize(),
        hasBom: session.model.hasBom,
      }
      setView((previous) => ({ ...previous, busy: true }))

      // 同じハッシュの通知を無視していた分も含め、選択時点のディスクを読み直す
      const observation = diskObservationRef.current
      const disk = await platform.openFile(session.path).catch(() => null)
      await waitForComposition()
      if (sessionRef.current !== session) return
      if (!canApplyDiskResult(observation, diskObservationRef.current)) {
        sync({ busy: false })
        return
      }
      if (!disk) {
        sync({
          busy: false,
          banner: { kind: 'unreadable', path: session.path, message: strings.errors.unknown },
        })
        return
      }

      const conflictBanner = (): Banner => ({
        kind: 'conflict',
        text: disk.text,
        hasBom: disk.hasBom,
        hash: disk.hash,
      })
      const plan = planConflictChoice(choice, { hash: disk.hash })

      // テーマ設定の読み込み中に編集が進む可能性があるため、設定取得後に再確認する。
      const themeConfig = plan.reloadDisk ? await readThemeConfig(session.path) : null
      if (plan.reloadDisk) {
        await waitForComposition()
        if (sessionRef.current !== session) return
        // テーマ設定を待つ間に届いた新しいディスク通知は、その処理に任せる
        if (!canApplyDiskResult(observation, diskObservationRef.current)) {
          sync({ busy: false })
          return
        }
      }

      // 読み込み待ちの間に確定した入力があれば、選択時点の内容を
      // 別名保存・再読み込みで上書きしない。最新の競合状態を残して選び直してもらう。
      if (
        plan.reloadDisk &&
        !planMineCopyReload(snapshot, {
          text: session.model.serialize(),
          hasBom: session.model.hasBom,
        })
      ) {
        sync({ busy: false, banner: conflictBanner() })
        return
      }

      // 上書きは、帯に出した内容からディスクが変わっていないときだけ行う
      if (plan.save && diskChangedSinceBanner(disk, banner)) {
        sync({ busy: false, banner: conflictBanner() })
        return
      }

      if (plan.writeMineCopy) {
        const saved = await writeMineCopy(session, snapshot)
        await waitForComposition()
        if (sessionRef.current !== session) return
        if (!canApplyDiskResult(observation, diskObservationRef.current)) {
          sync({ busy: false })
          return
        }
        if (!saved) {
          setView((previous) => ({ ...previous, busy: false }))
          return
        }
        if (plan.reloadDisk) {
          if (!planMineCopyReload(snapshot, { text: session.model.serialize(), hasBom: session.model.hasBom })) {
            // 待機中に入力があった。再読み込みせず競合の帯を残す。
            sync({ busy: false, banner: conflictBanner() })
            return
          }
          if (!themeConfig) return
          const themeWarnings = applyReload(session, disk.text, disk.hash, disk.hasBom, themeConfig)
          if (themeWarnings === null) return
          sync({
            banner:
              themeWarningsBanner(themeWarnings) ??
              { kind: 'info', message: strings.banner.mineSaved(saved) },
            busy: false,
          })
        }
        return
      }

      if (plan.save) {
        await runSave(plan.save.expectedHash)
        return
      }

      if (plan.reloadDisk) {
        if (!planMineCopyReload(snapshot, { text: session.model.serialize(), hasBom: session.model.hasBom })) {
          sync({ busy: false, banner: conflictBanner() })
          return
        }
        if (!themeConfig) return
        const themeWarnings = applyReload(session, disk.text, disk.hash, disk.hasBom, themeConfig)
        if (themeWarnings === null) return
        sync({ busy: false })
        return
      }
      setView((previous) => ({ ...previous, busy: false }))
    },
    [applyReload, runSave, sync, waitForComposition, writeMineCopy],
  )

  const chooseConflict = useCallback(
    (choice: ConflictChoice) => {
      if (deferIfComposing(() => void chooseConflictNow(choice))) return
      void chooseConflictNow(choice)
    },
    [chooseConflictNow, deferIfComposing],
  )

  /** 履歴。再描画後に記録したカーソル位置へ戻す */
  const restoreNow = useCallback(
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
      const restoration = planHistoryRestore(deck, resolved, currentRef.current)
      session.focus = restoration.cursor ? nextFocus(restoration.cursor) : undefined
      currentRef.current = restoration.current
      syncDeck({ detail: null, current: restoration.current })
    },
    [nextFocus, syncDeck],
  )

  const restore = useCallback(
    (direction: 'undo' | 'redo') => {
      if (deferIfComposing(() => restoreNow(direction))) return
      restoreNow(direction)
    },
    [deferIfComposing, restoreNow],
  )

  const goToNow = useCallback(
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

  const goTo = useCallback(
    (index: number) => {
      if (deferIfComposing(() => goToNow(index))) return
      goToNow(index)
    },
    [deferIfComposing, goToNow],
  )

  const goBy = useCallback(
    (delta: number) => {
      goTo(currentRef.current + delta)
    },
    [goTo],
  )

  const handleExternalNow = useCallback(
    async (change: ExternalChange, observation: DiskObservation, requestId: number) => {
      if (requestId !== externalChangeRequest.current) return
      if (updateInstallLockedRef.current) {
        bufferUpdateExternal(change, observation)
        return
      }
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

      const decide = () => {
        const state = editorSessionSaveState(session)
        return decideExternalChange({
          path: session.path,
          dirty: hasUnsavedChanges(state),
          conflict: state === 'conflict',
          currentText: session.model.serialize(),
          diskHash: session.model.diskHash,
        }, change)
      }

      let decision = decide()
      let themeConfig: ThemeConfig | null = null
      if (decision.type === 'reload') {
        themeConfig = await readThemeConfig(session.path)
        await waitForComposition()
        if (
          sessionRef.current !== session ||
          requestId !== externalChangeRequest.current ||
          !canApplyDiskResult(observation, diskObservationRef.current)
        ) return
        if (updateInstallLockedRef.current) {
          bufferUpdateExternal(change, observation)
          return
        }
        if (editingRef.current) stageApi.current?.endEditing()
        // テーマ設定を読んでいる間に編集や新しいファイル通知があれば、現在状態で判断し直す。
        decision = decide()
      }

      switch (decision.type) {
        case 'ignore':
          return
        case 'synced':
          session.model.markSaved(decision.hash)
          session.model.hasBom = decision.hasBom
          session.savedSnapshot = { text: session.model.serialize(), hasBom: decision.hasBom }
          session.conflict = false
          sync()
          return
        case 'reload':
          if (!themeConfig) return
          applyReload(session, decision.text, decision.hash, decision.hasBom, themeConfig)
          return
        case 'conflict':
          session.model.markConflict()
          session.conflict = true
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
    [applyReload, bufferUpdateExternal, sync, waitForComposition],
  )

  /** IME変換中は確定とコミットの後に外部変更を反映する */
  const handleExternal = useCallback(
    (change: ExternalChange) => {
      const opening = openingRef.current
      if (sessionRef.current?.path !== change.path && opening?.path !== change.path) return
      const observation: DiskObservation = {
        generation: diskObservationRef.current.generation + 1,
        change,
      }
      diskObservationRef.current = observation
      if (opening?.path === change.path) opening.observation = observation
      if (updateInstallLockedRef.current) {
        if (sessionRef.current?.path === change.path) externalChangeRequest.current += 1
        bufferUpdateExternal(change, observation)
        return
      }
      if (sessionRef.current?.path !== change.path) return
      const requestId = ++externalChangeRequest.current
      if (deferIfComposing(() => void handleExternalNow(change, observation, requestId))) return
      void handleExternalNow(change, observation, requestId)
    },
    [bufferUpdateExternal, deferIfComposing, handleExternalNow],
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
      if (updateInstallLockedRef.current) return
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
      if (updateInstallLockedRef.current) return
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
      if (updateInstallLockedRef.current) return
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
    onHistory: (direction) => {
      if (updateInstallLockedRef.current) return
      restore(direction)
    },
  }

  const continuePendingNow = useCallback(
    async (mode: 'save' | 'discard') => {
      const action = pendingRef.current
      if (!action) return
      const operationId = ++pendingOperationRef.current
      const isCurrentOperation = (): boolean =>
        pendingOperationRef.current === operationId && pendingRef.current === action
      if (mode === 'save') {
        const saved = await runSave()
        if (!isCurrentOperation()) return
        if (!saved) {
          replacePending(null)
          return
        }
      }
      if (!isCurrentOperation()) return
      if (action.kind === 'update') {
        await waitForComposition()
        if (!isCurrentOperation()) return
        stageApi.current?.endEditing()
        if (mode === 'save') {
          const session = sessionRef.current
          if (session && hasUnsavedChanges(editorSessionSaveState(session))) {
            // 保存中に追加された編集は、更新前にもう一度選択してもらう。
            replacePending(action)
            return
          }
        }
        updateInstallLockedRef.current = true
        setUpdateInstallLocked(true)
        replacePending(null, { updateResolution: true })
        return
      }
      if (mode === 'save' && action.kind === 'close') {
        const session = sessionRef.current
        if (session && hasUnsavedChanges(editorSessionSaveState(session))) {
          // 保存応答中に追加編集があったので、閉じる前にもう一度確認する。
          replacePending(action)
          return
        }
      }
      if (!isCurrentOperation()) return
      replacePending(null)
      if (action.kind === 'open') {
        await openPathNow(action.path, { allowDirty: mode === 'discard' })
        return
      }
      try {
        await platform.forceClose()
      } catch (reason) {
        sync({ error: strings.errors.closeFailed(errorMessage(reason)) })
      }
    },
    [openPathNow, replacePending, runSave, sync, waitForComposition],
  )

  const continuePending = useCallback(
    (mode: 'save' | 'discard') => {
      if (deferIfComposing(() => void continuePendingNow(mode))) return
      void continuePendingNow(mode)
    },
    [continuePendingNow, deferIfComposing],
  )

  const cancelPending = useCallback(() => {
    const action = pendingRef.current
    if (!action) return
    replacePending(null)
  }, [replacePending])

  // キー操作
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (updateInstallLockedRef.current || event.defaultPrevented) return
      if (pendingRef.current) return
      const mod = event.ctrlKey || event.metaKey
      if (mod && !event.altKey && event.key.toLowerCase() === 'e') {
        event.preventDefault()
        void runPptxExport()
        return
      }
      if (event.isComposing) return
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
  }, [goBy, goTo, openDialog, restore, runPptxExport, runSave])

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
  const exportReport = exportNotice?.report
  const exportReportHasDetails = exportReport ? hasExportReportDetails(exportReport) : false
  const exportReportErrors = exportReport?.errors ?? []
  const exportRasterizedBySlide = exportReport ? groupExportItemsBySlide(exportReport.rasterizedElements) : []
  const exportRasterizedUnassignedCount = exportReport
    ? Math.max(0, exportReport.rasterizedCount - exportReport.rasterizedElements.length)
    : 0
  const exportErrorsBySlide = groupExportItemsBySlide(exportReportErrors)
  const exportWarnings = exportReport ? exportWarningMessages(exportReport.warnings) : []
  const exportTechnicalDetails = exportNotice
    ? [...new Set([
      ...(exportNotice.kind === 'error' ? exportNotice.details ?? [] : []),
      ...(exportReport?.warnings.filter((warning) => !warning.startsWith('Error on slide ')) ?? []),
      ...exportReportErrors.map((error) => strings.export.errorDetail(error.slide, error.element, error.reason)),
    ])]
    : []
  const showExportBanner = exportNotice !== null &&
    (exportNotice.kind === 'error' || !exportReportHasDetails)

  return (
    <div class="app" inert={updateInstallLocked}>
      <Toolbar
        theme={settings.theme}
        sidebarCollapsed={sidebarCollapsed}
        busy={view.busy}
        canSave={session !== null && view.saveState !== 'readonly'}
        canExport={session !== null}
        exporting={exporting}
        canUndo={view.canUndo}
        canRedo={view.canRedo}
        onOpen={() => void openDialog()}
        onSave={() => void runSave()}
        onExportPptx={() => void runPptxExport()}
        onUndo={() => restore('undo')}
        onRedo={() => restore('redo')}
        onToggleSidebar={() => updateSettings({ sidebarCollapsed: !sidebarCollapsed })}
        onCycleTheme={cycleTheme}
        onOpenSettings={() => setSettingsOpen((open) => !open)}
        onCheckUpdates={() => window.dispatchEvent(new Event(UPDATE_CHECK_EVENT))}
      />

      <UpdateNotice
        checkOnStartup={settingsLoaded ? settings.checkUpdatesOnStartup : null}
        beforeInstall={beforeUpdateInstall}
        onInstallFailure={releaseUpdateInstall}
      />

      {view.error ? (
        <div class="banner" data-tone="error" role="alert">
          <span class="banner-message">{view.error}</span>
          <button type="button" onClick={() => sync({ error: null })}>
            {strings.errors.dismiss}
          </button>
        </div>
      ) : null}

      {showExportBanner && exportNotice ? (
        <div
          class="banner"
          data-tone={exportNotice.kind === 'error' ? 'error' : 'success'}
          role={exportNotice.kind === 'error' ? 'alert' : 'status'}
        >
          <div class="export-banner-content">
            <span class="banner-message">
              {exportNotice.kind === 'success'
                ? strings.export.succeeded(basename(exportNotice.path))
                : exportNotice.message}
            </span>
            {exportNotice.kind === 'error' && !exportReportOpen && exportNotice.details?.length ? (
              <details class="export-report-details">
                <summary>{strings.export.details}</summary>
                <ul>{exportNotice.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>
              </details>
            ) : null}
          </div>
          <button type="button" onClick={() => setExportNotice(null)}>
            {strings.banner.dismiss}
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
        exporting={exporting}
      />

      {settingsOpen ? (
        <SettingsPanel
          settings={settings}
          onThemeChange={(theme) => updateSettings({ theme })}
          onCheckUpdatesOnStartupChange={(checkUpdatesOnStartup) =>
            updateSettings({ checkUpdatesOnStartup })
          }
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
              {pending.kind === 'open'
                ? strings.confirm.openAction
                : pending.kind === 'update'
                  ? strings.confirm.updateAction
                  : strings.confirm.closeAction}
            </p>
            <div class="modal-buttons">
              <button type="button" onClick={() => void continuePending('save')}>
                {strings.confirm.saveAndContinue}
              </button>
              <button type="button" onClick={() => void continuePending('discard')}>
                {strings.confirm.discard}
              </button>
              <button type="button" onClick={cancelPending}>
                {strings.confirm.cancel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {exportReportOpen && exportNotice?.report ? (
        <div class="modal-backdrop">
          <div
            class="modal export-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="export-report-title"
          >
            <h2 class="modal-title" id="export-report-title">{strings.export.reportTitle}</h2>
            <p class="modal-message">
              {exportNotice.kind === 'success'
                ? strings.export.succeeded(basename(exportNotice.path))
                : exportNotice.message}
            </p>
            <div class="export-report-list">
              {exportNotice.report.rasterizedCount > 0 || exportNotice.report.rasterizedElements.length > 0 ? (
                <section class="export-report-section">
                  <h3>{strings.export.rasterizedTitle}</h3>
                  <ul>
                    {exportRasterizedBySlide.map(({ slide, count }) => (
                      <li key={slide}>{strings.export.rasterizedSlide(slide, count)}</li>
                    ))}
                    {exportRasterizedUnassignedCount > 0 ? (
                      <li>{strings.export.rasterizedUnassigned(exportRasterizedUnassignedCount)}</li>
                    ) : null}
                  </ul>
                  <p>{strings.export.rasterizedEditingLimit}</p>
                </section>
              ) : null}
              {exportNotice.report.substitutedFonts.length > 0 ? (
                <section class="export-report-section">
                  <h3>{strings.export.substitutedFontsTitle}</h3>
                  <ul>
                    {exportNotice.report.substitutedFonts.map((font, index) => (
                      <li key={index}>{strings.export.substitutedFont(font.requested, font.replacement)}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {exportWarnings.length > 0 ? (
                <section class="export-report-section">
                  <h3>{strings.export.warningTitle}</h3>
                  <ul>{exportWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
                </section>
              ) : null}
              {exportReportErrors.length > 0 ? (
                <section class="export-report-section">
                  <h3>{strings.export.errorsTitle}</h3>
                  <ul>
                    {exportErrorsBySlide.map(({ slide, count }) => (
                      <li key={slide}>{strings.export.errorSlide(slide, count)}</li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {exportTechnicalDetails.length > 0 ? (
                <details class="export-report-details">
                  <summary>{strings.export.details}</summary>
                  <ul>{exportTechnicalDetails.map((detail, index) => <li key={index}>{detail}</li>)}</ul>
                </details>
              ) : null}
            </div>
            <div class="modal-buttons">
              <button
                type="button"
                onClick={() => {
                  setExportReportOpen(false)
                  if (exportNotice.kind === 'success') setExportNotice(null)
                }}
              >
                {strings.export.close}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
