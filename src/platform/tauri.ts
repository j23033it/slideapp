import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

import type { AppSettings, OpenedFile, Platform } from './types'

/**
 * Tauri 2 のコマンドを呼ぶ実装。
 * ここにはUIの都合（文言・状態管理）を持ち込まず、invokeの引数名だけを守る。
 */
export const tauriPlatform: Platform = {
  pickPptxSavePath(defaultPath: string): Promise<string | null> {
    return save({ defaultPath, filters: [{ name: 'PowerPoint', extensions: ['pptx'] }] })
  },

  writeBinary(path: string, bytes: Uint8Array): Promise<void> {
    return invoke<void>('write_binary', { path, bytes: Array.from(bytes) })
  },

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
    return invoke<AppSettings>('settings_get')
  },

  settingsSet(settings: AppSettings): Promise<void> {
    return invoke<void>('settings_set', { settings })
  },

  convertFileSrc(absolutePath: string): string {
    return convertFileSrc(absolutePath)
  },
}
