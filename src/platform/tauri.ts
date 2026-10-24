import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { open, save } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'

import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CloseRequestHandler,
  type FileChangedEvent,
  type FileEventHandlers,
  type FileRemovedEvent,
  type FileUnreadableEvent,
  type OpenedFile,
  type Platform,
  type SaveOutcome,
  type ThemeConfig,
} from './types'
import { checkForUpdate, downloadAndInstall, relaunch } from './update'

interface SaveValue {
  hash?: unknown
  mtime?: unknown
  kind?: unknown
  diskHash?: unknown
  message?: unknown
}

/** Rust側の保存結果（成功・conflict・io）を判別する */
export function toSaveOutcome(value: unknown): SaveOutcome {
  if (typeof value === 'string') return { ok: false, kind: 'io', message: value }
  const record = (typeof value === 'object' && value !== null ? value : {}) as SaveValue
  if (typeof record.hash === 'string') {
    return { ok: true, hash: record.hash, mtime: typeof record.mtime === 'number' ? record.mtime : 0 }
  }
  if (record.kind === 'conflict') {
    return { ok: false, kind: 'conflict', diskHash: typeof record.diskHash === 'string' ? record.diskHash : '' }
  }
  if (record.kind === 'exists') return { ok: false, kind: 'exists' }
  if (record.kind === 'io') {
    return { ok: false, kind: 'io', message: typeof record.message === 'string' ? record.message : '' }
  }
  throw new Error('保存結果を解釈できませんでした')
}

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

  readThemeConfig(markdownPath: string): Promise<ThemeConfig> {
    return invoke<ThemeConfig>('read_theme_config', { markdownPath })
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

  async saveFile(path: string, text: string, hasBom: boolean, expectedHash: string): Promise<SaveOutcome> {
    try {
      return toSaveOutcome(await invoke<unknown>('save_file', { path, text, hasBom, expectedHash }))
    } catch (error) {
      // Tauri は `Err` を例外として返す。保存結果の形ならそのまま解釈する。
      return toSaveOutcome(error)
    }
  },

  async writeNewFile(path: string, text: string, hasBom: boolean): Promise<SaveOutcome> {
    try {
      return toSaveOutcome(await invoke<unknown>('write_new_file', { path, text, hasBom }))
    } catch (error) {
      return toSaveOutcome(error)
    }
  },

  async stopWatching(path?: string): Promise<void> {
    if (!isTauri()) return
    await invoke<void>('stop_watching', { path: path ?? null })
  },

  async listenFileEvents(handlers: FileEventHandlers): Promise<() => void> {
    if (!isTauri()) return () => {}
    const unlisten = await Promise.all([
      listen<FileChangedEvent>('file-changed', (event) => handlers.changed(event.payload)),
      listen<FileRemovedEvent>('file-removed', (event) => handlers.removed(event.payload)),
      listen<FileUnreadableEvent>('file-unreadable', (event) => handlers.unreadable(event.payload)),
    ])
    return () => {
      for (const stop of unlisten) stop()
    }
  },

  async setWindowTitle(title: string): Promise<void> {
    if (!isTauri()) return
    await getCurrentWindow().setTitle(title)
  },

  async onCloseRequested(handler: CloseRequestHandler): Promise<() => void> {
    if (!isTauri()) return () => {}
    return getCurrentWindow().onCloseRequested((event) => {
      // 保留したクローズは forceClose() で実行する。ここでは常に止める。
      event.preventDefault()
      handler()
    })
  },

  async forceClose(): Promise<void> {
    if (!isTauri()) return
    const window = getCurrentWindow()
    try {
      await window.destroy()
      return
    } catch {
      // `core:window:allow-destroy` が無い環境では close を試す。
    }
    await window.close()
  },
}
