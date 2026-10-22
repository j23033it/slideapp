import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

import { DEFAULT_SETTINGS, type AppSettings, type OpenedFile, type Platform } from './types'
import { checkForUpdate, downloadAndInstall, relaunch } from './update'

/**
 * Tauri 2 のコマンドを呼ぶ実装。
 * ここにはUIの都合（文言・状態管理）を持ち込まず、invokeの引数名だけを守る。
 */
export const tauriPlatform: Platform = {
  openFile(path: string): Promise<OpenedFile> {
    return invoke<OpenedFile>('open_file', { path })
  },

  async pickMarkdownFile(filterName: string): Promise<string | null> {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: filterName, extensions: ['md', 'markdown'] }],
    })
    return typeof selected === 'string' ? selected : null
  },

  recentFilesGet(): Promise<string[]> {
    return invoke<string[]>('recent_files_get')
  },

  recentFilesAdd(path: string): Promise<string[]> {
    return invoke<string[]>('recent_files_add', { path })
  },

  settingsGet(): Promise<AppSettings> {
    // Rust側がまだ知らない設定項目があっても既定値で埋める
    return invoke<Partial<AppSettings>>('settings_get').then((loaded) => ({
      ...DEFAULT_SETTINGS,
      ...loaded,
    }))
  },

  settingsSet(settings: AppSettings): Promise<void> {
    return invoke<void>('settings_set', { settings })
  },

  checkForUpdate,

  downloadAndInstall,

  relaunch,

  convertFileSrc(absolutePath: string): string {
    return convertFileSrc(absolutePath)
  },
}
