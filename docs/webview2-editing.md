# WebView2 の編集入力の再現と回帰確認

## 実行

Windows、Node 24、`npm ci` 済みのワークツリーで実行する。追加パッケージは不要。

```powershell
node scripts/webview2-editing.mjs --launch
```

`--launch` は `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` を渡して `npm run tauri dev` を起動する。終了時は成功・失敗のどちらでも、自分で起動したアプリと開発サーバーのプロセスツリーを停止する。起動に使うポートが使用中なら開始しない。起動ログは出力先の `launch.log` に残す。

MSVC がない環境では、既存の **Tauri デバッグ実行ファイル** をホストにできる。この場合も、このワークツリーの Vite と実際の WebView2・Rust のファイル読み込みを使う。

```powershell
$env:WEBVIEW2_HOST_EXE = 'C:\Users\taiki\Documents\slideapp\src-tauri\target\debug\slideapp.exe'
node scripts/webview2-editing.mjs --launch
```

今回の環境では Microsoft のリンカーがなく、`cargo run` が Git 付属の `link.exe` を呼んで失敗したため、後者で確認した。インストール版を再ビルドしての確認ではない。

すでに自分で起動した開発版へ接続する場合は `--launch` を省く。この場合、そのアプリとサーバーの停止は起動した側の責任になる。

任意の設定:

- `SAMPLE_MD`: サンプルファイルの読み込み元。必ず出力先の一意な一時フォルダへコピーし、コピーだけを開く。未指定ならスクリプト内のサンプルを使う。現在のシナリオは依頼にある見出し・段落・リストの文字列を前提にする。
- `TRACE_DIR`: JSON の出力先。未指定なら `%TEMP%\slideapp-webview2-<一意名>`。
- `CDP_PORT`: デバッグポート。既定は 9222。

```powershell
$env:SAMPLE_MD = 'C:\Users\taiki\Documents\slideapp-sample\sample.md'
$env:TRACE_DIR = Join-Path $env:TEMP 'slideapp-webview2-final'
node scripts/webview2-editing.mjs --launch
```

`SAMPLE_MD` の元ファイルは読み込みだけで、保存しない。コピーのディスク内容が変わっていないことも最後に照合する。最近使ったファイルへの登録だけを抑止する。コピーの確認で Windows のクリップボードに選択文字列が入る。

ファイルダイアログの返り値を一時コピーのパスに差し替え、通常の開くボタンから実際の `open_file` を呼ぶ。編集入力は `Input.dispatchMouseEvent`、`Input.dispatchKeyEvent`、`Input.imeSetComposition`、`Input.insertText` を使う。テスト専用の起動引数や本番用グローバル関数は追加していない。クラスの状態記録は CDP から開発モジュールの prototype を一時的にラップし、ページの再読み込みで破棄する。

## 記録

`environment.json` は WebView2 の版とコピーのパス、`results.json` はシナリオの成否。各シナリオの JSON に以下を記録する。

- keydown / beforeinput / input / selectionchange / focus / blur / click / pointerdown / pointerup / composition / copy の capture 時点と、処理後のタイマー時点。キー、入力種別、入力文字、`isComposing`、`defaultPrevented` も含む。
- Document と Shadow Root 両方の選択ノード・UTF-16 オフセット・折りたたみ状態。Document の Range、選択文字列、ノードの接続状態も含む。
- StageEditor の `editing`、`analysis.draft`、adapter の有無、合成待ち、編集中ブロック。
- StageEditor / adapter / アプリ側最新解析 / DocumentModel の本文と、モデルの未確定 draft の有無。
- 再描画、改行、下書き取消などのメソッド前後、UI コールバック、モデルに渡した範囲編集、モデルの例外。

## 見つかった原因

### 段落 Enter と、その後の Backspace

修正前の実機で安定して失敗した順序は、文末クリック → ArrowLeft → End → Enter → Backspace。

1. click で `setBaseAndExtent` した直後は、Document の選択も本文のテキストノード・文末オフセット 29 を返す。
2. `keydown(ArrowLeft)` → `selectionchange` の後、Shadow Root は同じテキストノードの 28、Document は編集面ホストの親 DIV・オフセット 0 を返す。
3. `keydown(End)` → `selectionchange` で実際のキャレットは 29 に戻るが、Document は DIV・0 のまま。
4. `keydown(Enter)` で StageEditor の `currentCursor()` がランを取得できない。`insertNewline()` は `cross-run` を通知して終了する。keydown を preventDefault 済みなので、ネイティブの改行 beforeinput / input も出ない。
5. `keydown(Backspace)` → `beforeinput(deleteContentBackward)` が来る。DOM アダプタの `inputGuard()` も Document の DIV をランと認識できず、`cross-run` で preventDefault する。input は出ず、文字は消えない。繰り返しても同じになる。

この失敗時には **新しい draft は作られていなかった**。`editing=true`、adapter あり、合成待ち false、モデルの draft false で、4か所の本文はすべて元のまま一致した。再現できた削除不能の原因は、壊れた DocumentModel や残留 composition ではなく、ネイティブ操作後に選択位置をホストへ丸める API を読み続けたことだった。

初回クリック直後に直接 Enter を押す条件では、修正前にも成功した。「別の場所をクリックして戻っても復帰せず、再起動だけで復帰する」という強い持続条件そのものは再現できていない。この点を同じ原因だと断定しない。

### ドラッグの選択が消える

編集中の段落で `pointerdown` → 複数回の `selectionchange` → `pointerup` → `click` と進む。click 直前の記録では、Shadow Root は文字ランのオフセット 1〜8 を選択しているが、Document は DIV・0〜0、`isCollapsed=true`。`Selection.toString()` だけは「字をクリックし」を返した。

`clickEndsSelection()` は Document の `isCollapsed` を見て false を返す。その後のクリック位置へのキャレット設定が、本物の選択をオフセット 8 に潰していた。`pointerSelection` や選択判定ロジックの前に、取得する Selection が間違っていた。

さらに編集開始前は、外枠の `body { user-select: none }` が効き、そもそも本文をドラッグ選択できなかった。Happy DOM のテストは選択を直接作っていたため、この CSS の問題も通過していた。

## 修正

- `src/editing/dom/selection.ts` の `selectionFor(root)` を追加。実機では Shadow Root の `getSelection()` を使い、同 API がない Happy DOM では Document にフォールバックする。
- StageEditor、キャレット補助、DOM アダプタの選択取得・復元を同じ関数へ統一した。
- 表示中の本文を編集開始前も `user-select: text` にした。
- PR #17 の `ensureCaretTextNode` と `pointAtRunBoundary` を削除。実機の Shadow Root は空ラン自身の位置を返し、空テキストノードと親境界の推定なしで入力・取消が通った。
- `clickEndsSelection` と `pointerSelection` は、正しい Selection を渡すと実機のドラッグを保てるため残した。空行先頭の Backspace 取消も、実機で必要な操作として残した。
- Happy DOM に Document だけがホストへ丸められる状況を追加し、実機のイベント順で Enter・Backspace・下書きの移動・ドラッグを検証した。空ランの親境界への正規化を仮定していたテストは、実際に観測した Shadow Root の選択へ変更した。

`src/app/App.tsx`、編集エンジン本体（engine / newline / blocks / empty）、`src/document`、Rust、依存バージョンは変更していない。

変更ファイル:

- 実装: `src/app/caret.ts`、`src/app/stageEditor.ts`、`src/editing/dom/index.ts`、`src/editing/dom/selection.ts`、`src/marp/surface.ts`。
- テスト: `tests/nativeShadowSelection.ts`、`tests/stageDraftEditing.test.ts`、`tests/stageEmptyNewline.test.ts`、`tests/stageSelection.test.ts`。
- 再現: `scripts/webview2-editing.mjs`。
- 文書: `docs/design.md`、`src/editing/README.md`、本書。

## 確認結果（2026-10-23）

WebView2: `Edg/155.0.4283.62`、CDP 1.3。

修正前の元コードで `paragraph-enter`、`backspace-after-enter`、`drag-selection` が失敗した記録:

`%TEMP%\slideapp-webview2-MyvWNy\`

さらに選択取得だけを一時的に Document に戻した比較でも、上記3件と、CDP の IME 確定後の Backspace、編集前ドラッグが失敗した（比較後にファイルを復元済み）:

`%TEMP%\slideapp-webview2-document-selection-baseline\`

修正後は利用者のサンプルのコピーを使い、`--launch` による起動・終了まで含めて次の **10シナリオがすべて成功**:

- 初回クリック直後の段落末尾 Enter。
- 矢印で動かした後の段落末尾 Enter と、次の段落への文字入力。
- Enter → 空段落を Backspace で取消 → もう一度 Backspace で普通の文字を削除。
- Shift+Enter の空行から ArrowUp で移動し、下書きを取消した後の削除。
- Enter の下書きから別ブロックをクリックし、戻って削除。
- Shift+Enter、文字入力、Undo。
- リスト項目末尾 Enter、新しい項目への文字入力。
- CDP の「てん → ・」合成・確定、直後の通常 Enter の抑止、Backspace、時間を置いた通常 Enter と入力。
- 編集中のドラッグ選択と Ctrl+C。Windows のクリップボードの文字列も照合。
- 編集開始前のドラッグ選択と Ctrl+C。編集を開始しないことと、クリップボードも照合。

最終記録: `%TEMP%\slideapp-webview2-final\`。開いたコピーのバイト列は元ファイルと一致したままで、利用者の元ファイルの更新日時も変わっていない。

`npm test`: 30ファイル、643件成功。`npm run typecheck`: 成功。依存追加なし。起動したプロセスは終了し、1420 / 9222 の待受がないことを確認した。

## 残る実機確認

CDP は実際の WebView2 のネイティブ入力を通すが、Windows の日本語 IME 候補ウィンドウと TSF の動作全体は再現しない。更新したインストール版で、本物の日本語 IME の「てん → ・」確定 Enter、直後の Backspace、改行失敗後に別の場所へ移動して戻る操作を確認する必要がある。今回のスクリプトだけで「再起動まで復帰しない」条件の解消を保証することはできない。
