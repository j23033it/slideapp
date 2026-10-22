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

/** 保存に成功したときの結果 */
export interface SavedFile {
  hash: string
  mtime: number
}

/**
 * `save_file` / `write_new_file` の結果。
 * Rust側の失敗値（`{ kind: "conflict" }` / `{ kind: "io" }`）をそのまま表す。
 */
export type SaveOutcome =
  | { ok: true; hash: string; mtime: number }
  | { ok: false; kind: 'conflict'; diskHash: string }
  | { ok: false; kind: 'exists' }
  | { ok: false; kind: 'io'; message: string }

/** ファイル監視のイベント。自分の保存では届かない */
export interface FileChangedEvent {
  path: string
  text: string
  hasBom: boolean
  hash: string
  mtime: number
}

export interface FileRemovedEvent {
  path: string
}

export interface FileUnreadableEvent {
  path: string
  message: string
}

export interface FileEventHandlers {
  changed(event: FileChangedEvent): void
  removed(event: FileRemovedEvent): void
  unreadable(event: FileUnreadableEvent): void
}

/** 未保存のまま閉じようとしたときに呼ばれる */
export type CloseRequestHandler = () => void

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

  /** 原子的に保存する。`expectedHash` がディスクと違えば conflict を返す */
  saveFile(path: string, text: string, hasBom: boolean, expectedHash: string): Promise<SaveOutcome>
  /** 既存ファイルを上書きせずに新規作成する */
  writeNewFile(path: string, text: string, hasBom: boolean): Promise<SaveOutcome>
  /** 監視を止める。`open_file` が監視を開始する */
  stopWatching(): Promise<void>
  /** `file-changed` / `file-removed` / `file-unreadable` を購読する */
  listenFileEvents(handlers: FileEventHandlers): Promise<() => void>

  /** OSのウィンドウタイトルを変える */
  setWindowTitle(title: string): Promise<void>
  /** 未保存のまま閉じようとしたときだけ購読する。購読中は閉じるのを保留する */
  onCloseRequested(handler: CloseRequestHandler): Promise<() => void>
  /** 保留したクローズを実行する */
  forceClose(): Promise<void>
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  sidebarWidth: 180,
  sidebarCollapsed: false,
}
