import type { ThemePreference } from '../platform'
import { strings } from './strings'
import { TablePicker } from './TablePicker'

export interface ToolbarProps {
  theme: ThemePreference
  sidebarCollapsed: boolean
  busy: boolean
  canSave: boolean
  canInsertImage: boolean
  imageDisabledReason: string | null
  onInsertImage: () => void
  onInsertBox: () => void
  boxFontSize: number | null
  boxFontDisabledReason?: string
  onBoxFontSize: (size: number | null) => void
  canExport: boolean
  exporting: boolean
  canUndo: boolean
  canRedo: boolean
  tableDisabledReason?: string
  onTableOpen: () => void
  onInsertTable: (columns: number, rows: number) => void
  onOpen: () => void
  onSave: () => void
  onExportPptx: () => void
  onUndo: () => void
  onRedo: () => void
  onToggleSidebar: () => void
  onCycleTheme: () => void
  onOpenSettings: () => void
  onCheckUpdates: () => void
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
  canInsertImage,
  imageDisabledReason,
  onInsertImage,
  onInsertBox,
  boxFontSize,
  boxFontDisabledReason,
  onBoxFontSize,
  canExport,
  exporting,
  canUndo,
  canRedo,
  tableDisabledReason,
  onTableOpen,
  onInsertTable,
  onOpen,
  onSave,
  onExportPptx,
  onUndo,
  onRedo,
  onToggleSidebar,
  onCycleTheme,
  onOpenSettings,
  onCheckUpdates,
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
      <button type="button" class="toolbar-button" title={tableDisabledReason ?? strings.toolbar.boxTitle}
        onClick={onInsertBox} disabled={busy || !!tableDisabledReason}>
        {strings.toolbar.box}
      </button>
      <TablePicker disabled={busy || !!tableDisabledReason} disabledReason={tableDisabledReason} onOpen={onTableOpen} onInsert={onInsertTable} />
      <button type="button" class="toolbar-button" title={imageDisabledReason ?? strings.toolbar.imageTitle}
        onClick={onInsertImage} disabled={!canInsertImage || busy}>
        {strings.toolbar.image}
      </button>
      <div class="toolbar-divider" />

      <select aria-label={strings.toolbar.fontSize} title={boxFontDisabledReason ?? strings.toolbar.fontSizeTitle}
        disabled={busy || !!boxFontDisabledReason} value={boxFontSize ?? ''}
        onChange={event => onBoxFontSize(event.currentTarget.value ? Number(event.currentTarget.value) : null)}>
        <option value="">{strings.toolbar.fontSizeDefault}</option>
        {boxFontSize !== null && ![12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72].includes(boxFontSize) ? <option value={boxFontSize}>{boxFontSize}pt</option> : null}
        {[12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72].map(size => <option value={size}>{size}pt</option>)}
      </select>
      <div class="toolbar-divider" />

      <button
        type="button"
        class="toolbar-button"
        title={strings.toolbar.exportPptxTitle}
        onClick={onExportPptx}
        disabled={!canExport || busy || exporting}
        aria-busy={exporting}
      >
        {strings.toolbar.exportPptx}
      </button>
      <button
        type="button"
        class="toolbar-button"
        title={strings.toolbar.checkUpdatesTitle}
        onClick={onCheckUpdates}
      >
        {strings.toolbar.checkUpdates}
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
