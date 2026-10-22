import { tauriPlatform } from './tauri'
import type { Platform } from './types'

/** UIが使う唯一のプラットフォーム実装。テストではこの参照を差し替える */
export const platform: Platform = tauriPlatform

export { DEFAULT_SETTINGS } from './types'
export type {
  AppSettings,
  OpenedFile,
  Platform,
  ThemeConfig,
  ThemePreference,
  UpdateInfo,
  UpdateProgress,
} from './types'
