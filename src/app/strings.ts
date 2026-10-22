/**
 * 画面に出す文言はすべてここに集約する。
 * 文言の調整はこのファイルだけで完結させる（コンポーネントに直書きしない）。
 */
export const strings = {
  appName: 'SlideApp',

  toolbar: {
    sidebarToggleShow: 'スライド一覧を表示',
    sidebarToggleHide: 'スライド一覧を折りたたむ',
    open: '開く',
    openTitle: 'ファイルを開く (Ctrl+O)',
    save: '保存',
    saveTitle: '保存（未実装）',
    undo: '元に戻す',
    undoTitle: '元に戻す（未実装）',
    redo: 'やり直す',
    redoTitle: 'やり直す（未実装）',
    exportPptx: 'PowerPointに書き出し',
    exportPptxTitle: 'PowerPointに書き出し（未実装）',
    themeTitle: (label: string) => `テーマ: ${label}（クリックで切り替え）`,
    settings: '設定',
    settingsTitle: '設定を開く',
  },

  theme: {
    system: 'システム',
    light: 'ライト',
    dark: 'ダーク',
  },

  sidebar: {
    title: 'スライド一覧',
    collapse: '一覧を折りたたむ',
    resizeHandle: 'ドラッグで幅を変更',
    slideLabel: (n: number, total: number) => `スライド ${n} / ${total}`,
    empty: 'スライドがありません',
  },

  stage: {
    openFile: 'ファイルを開く',
    recentFiles: '最近使ったファイル',
    noRecentFiles: '最近使ったファイルはありません',
    dropHint: 'Markdown（.md）を開くとスライドを表示します',
    slideLabel: (n: number, total: number) => `スライド ${n} / ${total}`,
  },

  status: {
    noFile: 'ファイル未選択',
    saved: '保存済み',
    unsaved: '未保存',
    readonly: '読み取り専用',
    slideCounter: (n: number, total: number) => `スライド ${n} / ${total}`,
    ready: '準備完了',
  },

  settings: {
    title: '設定',
    theme: 'テーマ',
    themeHelp: 'システムはOSのライト・ダーク設定に従います。',
    sidebar: 'スライド一覧の幅',
    sidebarReset: '既定の幅に戻す',
    sidebarUnit: (width: number) => `${width} px`,
    close: '閉じる',
  },

  errors: {
    openFailed: (message: string) => `ファイルを開けませんでした: ${message}`,
    settingsFailed: (message: string) => `設定を保存できませんでした: ${message}`,
    recentFailed: (message: string) => `最近使ったファイルを更新できませんでした: ${message}`,
    unknown: '不明なエラー',
    dismiss: '閉じる',
  },

  /** ウィンドウタイトル。未保存の変更があるときはファイル名の後に ● を付ける */
  windowTitle: (fileName: string | null, dirty: boolean) => {
    if (!fileName) return strings.appName
    return `${fileName}${dirty ? ' ●' : ''} — ${strings.appName}`
  },

  fileDialog: {
    markdownFilter: 'Markdown',
  },
} as const
