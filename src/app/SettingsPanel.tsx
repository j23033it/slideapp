import { useEffect } from 'preact/hooks'

import type { AppSettings, ThemePreference } from '../platform'
import { strings } from './strings'

export interface SettingsPanelProps {
  settings: AppSettings
  onThemeChange: (theme: ThemePreference) => void
  onCheckUpdatesOnStartupChange: (enabled: boolean) => void
  onResetSidebarWidth: () => void
  onClose: () => void
}

const THEMES: ThemePreference[] = ['system', 'light', 'dark']

/** 設定ポップオーバー（テーマとスライド一覧の幅） */
export function SettingsPanel({
  settings,
  onThemeChange,
  onCheckUpdatesOnStartupChange,
  onResetSidebarWidth,
  onClose,
}: SettingsPanelProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <>
      <div class="popover-backdrop" onClick={onClose} />
      <div class="settings-panel" role="dialog" aria-label={strings.settings.title}>
        <div class="settings-header">
          <h2 class="settings-title">{strings.settings.title}</h2>
          <button
            type="button"
            class="settings-close"
            title={strings.settings.close}
            aria-label={strings.settings.close}
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div class="settings-group">
          <label class="settings-radio">
            <input
              type="checkbox"
              checked={settings.checkUpdatesOnStartup}
              onChange={(event) => onCheckUpdatesOnStartupChange(event.currentTarget.checked)}
            />
            {strings.settings.checkUpdatesOnStartup}
          </label>
        </div>

        <div class="settings-group">
          <div class="settings-label">{strings.settings.theme}</div>
          {THEMES.map((theme) => (
            <label class="settings-radio" key={theme}>
              <input
                type="radio"
                name="theme"
                checked={settings.theme === theme}
                onChange={() => onThemeChange(theme)}
              />
              {strings.theme[theme]}
            </label>
          ))}
          <div class="settings-help">{strings.settings.themeHelp}</div>
        </div>

        <div class="settings-group">
          <div class="settings-label">{strings.settings.sidebar}</div>
          <div class="settings-row">
            <span class="settings-value">{strings.settings.sidebarUnit(settings.sidebarWidth)}</span>
            <button type="button" class="settings-button" onClick={onResetSidebarWidth}>
              {strings.settings.sidebarReset}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
