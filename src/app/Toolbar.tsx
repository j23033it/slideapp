import type { ThemePreference } from '../platform'
import { strings } from './strings'

export interface ToolbarProps {
  theme: ThemePreference
  sidebarCollapsed: boolean
  busy: boolean
  onOpen: () => void
  onToggleSidebar: () => void
  onCycleTheme: () => void
  onOpenSettings: () => void
}

const THEME_ICON: Record<ThemePreference, string> = {
  system: '◐',
  light: '☀',
  dark: '☾',
}

export function Toolbar({
  theme,
  sidebarCollapsed,
  busy,
  onOpen,
  onToggleSidebar,
  onCycleTheme,
  onOpenSettings,
}: ToolbarProps) {
  const sidebarTitle = sidebarCollapsed
    ? strings.toolbar.sidebarToggleShow
    : strings.toolbar.sidebarToggleHide

  return (
    <div class="toolbar" role="toolbar" aria-label={strings.appName}>
      <button
        type="button"
        class="toolbar-button"
        title={sidebarTitle}
        aria-label={sidebarTitle}
        aria-pressed={!sidebarCollapsed}
        onClick={onToggleSidebar}
      >
        ☰
      </button>

      <button
        type="button"
        class="toolbar-button"
        title={strings.toolbar.openTitle}
        onClick={onOpen}
        disabled={busy}
      >
        {strings.toolbar.open}
      </button>
      <button type="button" class="toolbar-button" title={strings.toolbar.saveTitle} disabled>
        {strings.toolbar.save}
      </button>
      <button type="button" class="toolbar-button" title={strings.toolbar.undoTitle} disabled>
        ↶
      </button>
      <button type="button" class="toolbar-button" title={strings.toolbar.redoTitle} disabled>
        ↷
      </button>

      <div class="toolbar-divider" />

      <button type="button" class="toolbar-button" title={strings.toolbar.exportPptxTitle} disabled>
        {strings.toolbar.exportPptx}
      </button>

      <div class="toolbar-spacer" />

      <button
        type="button"
        class="toolbar-button"
        title={strings.toolbar.themeTitle(strings.theme[theme])}
        aria-label={strings.toolbar.themeTitle(strings.theme[theme])}
        onClick={onCycleTheme}
      >
        {THEME_ICON[theme]}
      </button>
      <button
        type="button"
        class="toolbar-button"
        title={strings.toolbar.settingsTitle}
        aria-label={strings.toolbar.settings}
        onClick={onOpenSettings}
      >
        ⚙
      </button>
    </div>
  )
}
