import type { ThemePreference } from '../platform'
import { strings } from './strings'

export interface ToolbarProps {
  theme: ThemePreference
  sidebarCollapsed: boolean
  busy: boolean
  canSave: boolean
  canUndo: boolean
  canRedo: boolean
  onOpen: () => void
  onSave: () => void
  onUndo: () => void
  onRedo: () => void
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
  canSave,
  canUndo,
  canRedo,
  onOpen,
  onSave,
  onUndo,
  onRedo,
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
      <button
        type="button"
        class="toolbar-button"
        title={strings.toolbar.saveTitle}
        onClick={onSave}
        disabled={!canSave || busy}
      >
        {strings.toolbar.save}
      </button>
      <button
        type="button"
        class="toolbar-button"
        title={strings.toolbar.undoTitle}
        aria-label={strings.toolbar.undo}
        onClick={onUndo}
        disabled={!canUndo || busy}
      >
        ↶
      </button>
      <button
        type="button"
        class="toolbar-button"
        title={strings.toolbar.redoTitle}
        aria-label={strings.toolbar.redo}
        onClick={onRedo}
        disabled={!canRedo || busy}
      >
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
