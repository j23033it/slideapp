/** テーマの設定値。`system` はOS設定（prefers-color-scheme）に従う */
export type ThemePreference = 'system' | 'light' | 'dark'

/** Rust側の `settings_get` / `settings_set` が扱うアプリ設定 */
export interface AppSettings {
  theme: ThemePreference
  /** スライド一覧の幅（px） */
  sidebarWidth: number
  sidebarCollapsed: boolean
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

/** Rust側の `read_theme_config` が返すテーマCSS1件 */
export interface ThemeCssFile {
  /** CSSファイルの絶対パス */
  path: string
  css: string
}

/** Rust側の `read_theme_config` の戻り値 */
export interface ThemeConfig {
  themes: ThemeCssFile[]
  /** 読めなかった設定・CSSの理由（日本語） */
  warnings: string[]
}

/**
 * Tauri呼び出しの薄い包み。テストや将来の差し替えのため、UIはこの型だけに依存する。
 */
export interface Platform {
  openFile(path: string): Promise<OpenedFile>
  /**
   * 開いたMarkdownの近くにあるMarpのテーマ設定を読み、CSS本体と警告を返す。
   * 読み込んだCSSのフォルダはRust側で資産プロトコルの許可範囲に加わる。
   */
  readThemeConfig(markdownPath: string): Promise<ThemeConfig>
  /** .md選択ダイアログを開く。キャンセル時は null */
  pickMarkdownFile(filterName: string): Promise<string | null>
  recentFilesGet(): Promise<string[]>
  /** 先頭に追加し、最大10件に切り詰めた一覧を返す */
  recentFilesAdd(path: string): Promise<string[]>
  settingsGet(): Promise<AppSettings>
  settingsSet(settings: AppSettings): Promise<void>
  /** ローカル絶対パスをWebViewから読める資産URLに変換する */
  convertFileSrc(absolutePath: string): string
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  sidebarWidth: 180,
  sidebarCollapsed: false,
}
