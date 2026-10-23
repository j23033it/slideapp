/**
 * 画面に出す文言はすべてここに集約する。
 * 文言の調整はこのファイルだけで完結させる（コンポーネントに直書きしない）。
 */
import type { ReadonlyCode } from '../editing'

export const strings = {
  appName: 'SlideApp',

  toolbar: {
    sidebarToggleShow: 'スライド一覧を表示',
    sidebarToggleHide: 'スライド一覧を折りたたむ',
    open: '開く',
    openTitle: 'ファイルを開く (Ctrl+O)',
    save: '保存',
    saveTitle: '保存 (Ctrl+S)',
    undo: '元に戻す',
    undoTitle: '元に戻す (Ctrl+Z)',
    redo: 'やり直す',
    redoTitle: 'やり直す (Ctrl+Y)',
    exportPptx: 'PowerPointに書き出し',
    exportPptxTitle: 'PowerPointに書き出し (Ctrl+E)',
    checkUpdates: '更新を確認',
    checkUpdatesTitle: '更新を確認',
    themeTitle: (label: string) => `テーマ: ${label}（クリックで切り替え）`,
    settings: '設定',
    settingsTitle: '設定を開く',
  },

  theme: {
    system: 'システム',
    light: 'ライト',
    dark: 'ダーク',
  },

  update: {
    available: (version: string) => `新しいバージョン v${version} を利用できます`,
    install: '更新して再起動',
    later: '後で',
    checking: '更新を確認しています…',
    downloading: (version: string) => `v${version} をダウンロードしています…`,
    progressUnknown: 'ダウンロード中…',
    progress: (percent: number) => `${percent}%`,
    progressLabel: '更新のダウンロード進捗',
    installing: 'インストールしています…まもなくアプリを再起動します',
    failed: (message: string) => `更新に失敗しました: ${message}`,
    restartFailed: '更新はインストールされました。アプリを手動で再起動してください。',
    noUpdate: '利用可能な更新が見つかりませんでした',
    retry: '再試行',
    dismiss: '閉じる',
    unknownError: '不明なエラー',
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
    saveState: {
      clean: '保存済み',
      dirty: '未保存',
      conflict: '競合',
      readonly: '読み取り専用',
    },
    slideCounter: (n: number, total: number) => `スライド ${n} / ${total}`,
    ready: '準備完了',
    exporting: '書き出し中…',
    /** 編集中の要素の種類 */
    editing: {
      heading: (level: number) => `編集: 見出し ${level}`,
      paragraph: '編集: 段落',
      listItem: '編集: 箇条書き',
    },
    /** 読み取り専用の理由（エンジンの理由コード → 文言） */
    reasons: {
      table: '表は直接編集に対応していません',
      code: 'コードは直接編集に対応していません',
      math: '数式は直接編集に対応していません',
      image: '画像は直接編集に対応していません',
      html: 'HTMLは直接編集に対応していません',
      emoji: '絵文字は直接編集に対応していません',
      'front-matter': 'フロントマターは直接編集に対応していません',
      comment: 'コメントとディレクティブは直接編集に対応していません',
      generated: '自動生成された内容は直接編集に対応していません',
      'ambiguous-source': '元の位置を特定できないため読み取り専用です',
      'renderer-transform': '描画で文字が変換されるため読み取り専用です',
      'dom-mismatch': '画面と元の文字が一致しないため読み取り専用です',
      nul: 'ヌル文字を含むため読み取り専用です',
      'invalid-source': '編集後のMarkdownを解析できませんでした',
      'stale-run': '古い位置情報です。編集をやり直してください',
      'structure-changed': 'Markdownの構造が変わるため、この編集はできません',
      newline: '改行の追加には対応していません',
      'cross-run': '別の文字列をまたぐ削除はできません',
      format: '書式の変更には対応していません',
      history: '元に戻す・やり直すはアプリの機能で行ってください',
      'unsupported-input': 'この入力操作には対応していません',
    } satisfies Record<ReadonlyCode, string>,
  },

  banner: {
    conflict: {
      message: 'このファイルは外部で変更されました。',
      load: 'ディスクの内容を読み込む',
      overwrite: '自分の変更で上書き保存する',
      mine: '比較用に別名で保存する',
    },
    removed: (name: string) =>
      `${name} が削除または移動されました。編集内容は画面に残っています。別名で保存してください。`,
    unreadable: (name: string, message: string) =>
      `${name} を読み込めませんでした: ${message}`,
    themeWarnings: (warnings: string[]) => `テーマの設定に警告があります: ${warnings.join(' / ')}`,
    themeConfigReadFailed: (message: string) => `テーマ設定を読み込めませんでした: ${message}`,
    mineSaved: (path: string) => `比較用に ${path} へ保存しました。`,
    dismiss: '閉じる',
  },

  settings: {
    title: '設定',
    theme: 'テーマ',
    themeHelp: '「システム」はOSのライト・ダーク設定に従います。',
    checkUpdatesOnStartup: '起動時に更新を確認',
    sidebar: 'スライド一覧の幅',
    sidebarReset: '既定の幅に戻す',
    sidebarUnit: (width: number) => `${width} px`,
    close: '閉じる',
  },

  confirm: {
    title: '未保存の変更があります',
    message: '保存していない変更があります。どうしますか？',
    saveAndContinue: '保存して続ける',
    discard: '変更を破棄',
    cancel: 'キャンセル',
    openAction: '別のファイルを開く',
    closeAction: 'アプリを閉じる',
    updateAction: '更新をインストールして再起動',
  },

  errors: {
    openFailed: (message: string) => `ファイルを開けませんでした: ${message}`,
    saveFailed: (message: string) => `保存できませんでした: ${message}`,
    copyFailed: (message: string) => `別名で保存できませんでした: ${message}`,
    closeFailed: (message: string) => `ウィンドウを閉じられませんでした: ${message}`,
    settingsFailed: (message: string) => `設定を保存できませんでした: ${message}`,
    recentFailed: (message: string) => `最近使ったファイルを更新できませんでした: ${message}`,
    unknown: '不明なエラー',
    dismiss: '閉じる',
  },

  export: {
    succeeded: (fileName: string) => `PowerPointに書き出しました：${fileName}`,
    partial: (fileName: string) => `「${fileName}」に書き出しましたが、一部の内容を出力できませんでした。ファイルを確認してください。`,
    failed: 'PowerPointに書き出せませんでした。もう一度お試しください。',
    writeFailed: (fileName: string) => `「${fileName}」を保存できませんでした。保存先を確認してください。`,
    reportTitle: '書き出しレポート',
    rasterizedTitle: '画像として書き出した部分',
    rasterizedSlide: (slide: number, count: number) =>
      `スライド${slide}の一部${count}か所は、見た目を保つため画像として書き出しました。`,
    rasterizedUnassigned: (count: number) =>
      `${count}か所は、見た目を保つため画像として書き出しました。`,
    rasterizedEditingLimit: '画像内の文字はPowerPointで編集できません。',
    substitutedFontsTitle: '代用したフォント',
    substitutedFont: (requested: string, replacement: string) =>
      `このPCにないフォント『${requested}』は『${replacement}』で代用しました。`,
    warningTitle: '確認してください',
    webFontUnavailable: 'Webフォントを読み込めなかったため、利用可能なフォントで書き出しました。',
    fontLoadFailed: 'フォントを読み込めませんでした。表示が異なる場合があります。',
    genericWarning: '書き出し時に確認が必要な項目があります。詳しくは「詳細」を確認してください。',
    errorsTitle: '書き出せなかった内容',
    errorSlide: (slide: number, count: number) => `スライド${slide}の一部${count}か所を書き出せませんでした。`,
    details: '詳細',
    errorDetail: (slide: number, element: string, reason: string) => `スライド${slide} / ${element}: ${reason}`,
    close: '閉じる',
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
