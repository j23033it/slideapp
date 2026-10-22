/** テーマの設定値。`system` はOS設定（prefers-color-scheme）に従う */
export type ThemePreference = 'system' | 'light' | 'dark'

/** Rust側の `settings_get` / `settings_set` が扱うアプリ設定 */
export interface AppSettings {
  theme: ThemePreference
  /** スライド一覧の幅（px） */
  sidebarWidth: number
  sidebarCollapsed: boolean
  /** 起動時に新しい版を確認する（既定は true） */
  checkUpdatesOnStartup: boolean
}

/** 更新確認で見つかった新しい版 */
export interface UpdateInfo {
  /** 配布されている版（例: "0.2.0"） */
  version: string
  /** 実行中の版 */
  currentVersion: string
  /** リリースノート。配布側が用意していなければ null */
  notes: string | null
  /** 公開日（ISO 8601）。配布側が用意していなければ null */
  date: string | null
}

/** ダウンロードの進み具合 */
export interface UpdateProgress {
  /** ダウンロード済みのバイト数 */
  downloaded: number
  /** 全体のバイト数。サーバーが返さなければ null */
  total: number | null
  /** 0〜1。全体が分からなければ null */
  ratio: number | null
}

/** Rust側の `open_file` の戻り値 */
export interface OpenedFile {
  /** UTF-8の本文（BOMは除去済み） */
  text: string
  hasBom: boolean
  /** ディスク上のバイト列のSHA-256（16進） */
  hash: string
  /** 最終更新時刻（UNIXエポックからのミリ秒） */
  mtime: number
}

/**
 * Tauri呼び出しの薄い包み。テストや将来の差し替えのため、UIはこの型だけに依存する。
 */
export interface Platform {
  openFile(path: string): Promise<OpenedFile>
  /** .md選択ダイアログを開く。キャンセル時は null */
  pickMarkdownFile(filterName: string): Promise<string | null>
  recentFilesGet(): Promise<string[]>
  /** 先頭に追加し、最大10件に切り詰めた一覧を返す */
  recentFilesAdd(path: string): Promise<string[]>
  settingsGet(): Promise<AppSettings>
  settingsSet(settings: AppSettings): Promise<void>
  /** 更新を確認する。新しい版がなければ null */
  checkForUpdate(): Promise<UpdateInfo | null>
  /**
   * 確認済みの更新をダウンロードしてインストールする。
   * 先に `checkForUpdate` を呼び、新しい版が見つかっている必要がある。
   */
  downloadAndInstall(onProgress: (progress: UpdateProgress) => void): Promise<void>
  /** アプリを再起動する */
  relaunch(): Promise<void>
  /** ローカル絶対パスをWebViewから読める資産URLに変換する */
  convertFileSrc(absolutePath: string): string
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  sidebarWidth: 180,
  sidebarCollapsed: false,
  checkUpdatesOnStartup: true,
}
