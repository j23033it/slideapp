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
  openTabs: string[]
  activeTab: string | null
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
  pickPptxSavePath(defaultPath: string): Promise<string | null>
  writeBinary(path: string, bytes: Uint8Array): Promise<void>
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

  /** 原子的に保存する。`expectedHash` がディスクと違えば conflict を返す */
  saveFile(path: string, text: string, hasBom: boolean, expectedHash: string): Promise<SaveOutcome>
  /** 既存ファイルを上書きせずに新規作成する */
  writeNewFile(path: string, text: string, hasBom: boolean): Promise<SaveOutcome>
  /** 指定パスだけ（省略時は全対象）の監視を止める。`open_file` が監視を開始する */
  stopWatching(path?: string): Promise<void>
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
  checkUpdatesOnStartup: true,
  openTabs: [],
  activeTab: null,
}
