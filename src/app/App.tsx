import type { JSX } from 'preact'
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'

import { splitEols, type Eol } from '../document/eols'
import { MarpRenderer, type RenderedDeck } from '../marp/renderer'
import { DEFAULT_SETTINGS, platform, type AppSettings, type ThemePreference } from '../platform'
import { basename, dirname } from '../platform/paths'
import { EmptyState } from './EmptyState'
import { SettingsPanel } from './SettingsPanel'
import { SlideList } from './SlideList'
import { SlideStage } from './SlideStage'
import { StatusBar } from './StatusBar'
import { strings } from './strings'
import { Toolbar } from './Toolbar'

interface OpenDocument {
  path: string
  /** LF正規化した本文（保存担当が使う） */
  text: string
  /** 行ごとの改行コード（保存担当が使う） */
  eols: Eol[]
  hasBom: boolean
  diskHash: string
  deck: RenderedDeck
}

const MIN_SIDEBAR_WIDTH = 120
const MAX_SIDEBAR_WIDTH = 480
const THEME_ORDER: ThemePreference[] = ['system', 'light', 'dark']

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return strings.errors.unknown
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

export function App() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [recent, setRecent] = useState<string[]>([])
  const [doc, setDoc] = useState<OpenDocument | null>(null)
  const [current, setCurrent] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const renderer = useMemo(() => new MarpRenderer((path) => platform.convertFileSrc(path)), [])

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
        setError(strings.errors.settingsFailed(errorMessage(reason)))
      })
    }, 250)
    return () => clearTimeout(timer)
  }, [settings, settingsLoaded])

  // ウィンドウタイトル
  useEffect(() => {
    document.title = strings.windowTitle(doc ? basename(doc.path) : null, false)
  }, [doc])

  const openPath = useCallback(
    async (path: string) => {
      setBusy(true)
      try {
        const file = await platform.openFile(path)
        const { text, eols } = splitEols(file.text)
        const deck = renderer.render(text, dirname(path))

        setDoc({ path, text, eols, hasBom: file.hasBom, diskHash: file.hash, deck })
        setCurrent(0)
        setError(null)

        platform
          .recentFilesAdd(path)
          .then((list) => setRecent(list))
          .catch((reason: unknown) => {
            setError(strings.errors.recentFailed(errorMessage(reason)))
          })
      } catch (reason) {
        setError(strings.errors.openFailed(errorMessage(reason)))
      } finally {
        setBusy(false)
      }
    },
    [renderer],
  )

  const openDialog = useCallback(async () => {
    try {
      const selected = await platform.pickMarkdownFile(strings.fileDialog.markdownFilter)
      if (selected) await openPath(selected)
    } catch (reason) {
      setError(strings.errors.openFailed(errorMessage(reason)))
    }
  }, [openPath])

  const goTo = useCallback(
    (index: number) => {
      const total = doc?.deck.slides.length ?? 0
      if (total === 0) return
      setCurrent(clamp(index, 0, total - 1))
    },
    [doc],
  )

  const goBy = useCallback(
    (delta: number) => {
      setCurrent((previous) => {
        const total = doc?.deck.slides.length ?? 0
        if (total === 0) return 0
        return clamp(previous + delta, 0, total - 1)
      })
    },
    [doc],
  )

  // キー操作（編集中の要素がないときだけ）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (isEditableTarget(event.target)) return

      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        void openDialog()
        return
      }

      if (!doc) return
      const total = doc.deck.slides.length
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
  }, [doc, goBy, goTo, openDialog])

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
  const slideTotal = doc?.deck.slides.length ?? 0

  return (
    <div class="app">
      <Toolbar
        theme={settings.theme}
        sidebarCollapsed={sidebarCollapsed}
        busy={busy}
        onOpen={() => void openDialog()}
        onToggleSidebar={() => updateSettings({ sidebarCollapsed: !sidebarCollapsed })}
        onCycleTheme={cycleTheme}
        onOpenSettings={() => setSettingsOpen((open) => !open)}
      />

      {error ? (
        <div class="banner" data-tone="error" role="alert">
          <span class="banner-message">{error}</span>
          <button type="button" onClick={() => setError(null)}>
            {strings.errors.dismiss}
          </button>
        </div>
      ) : null}

      <div class="main">
        {!sidebarCollapsed ? (
          <>
            <aside class="sidebar" style={{ width: `${settings.sidebarWidth}px` }}>
              <SlideList
                deck={doc?.deck ?? null}
                current={current}
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

        {doc ? (
          <SlideStage deck={doc.deck} current={current} />
        ) : (
          <EmptyState
            recent={recent}
            busy={busy}
            onOpen={() => void openDialog()}
            onOpenRecent={(path) => void openPath(path)}
          />
        )}
      </div>

      <StatusBar
        path={doc?.path ?? null}
        dirty={false}
        slideIndex={current}
        slideTotal={slideTotal}
      />

      {settingsOpen ? (
        <SettingsPanel
          settings={settings}
          onThemeChange={(theme) => updateSettings({ theme })}
          onResetSidebarWidth={() => updateSettings({ sidebarWidth: DEFAULT_SETTINGS.sidebarWidth })}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  )
}
