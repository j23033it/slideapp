# 設計

要件は [requirements.md](requirements.md) を参照。

## 1. 技術選定

| 項目 | 採用 | 理由 |
|---|---|---|
| デスクトップ基盤 | **Tauri 2**（Rust + WebView2） | Electronを使わずにWebの描画力を得る。WebView2はWindows 11に標準搭載で、インストーラーが小さい |
| 描画 | **@marp-team/marp-core**（フロントエンドで実行） | Marp公式の描画エンジン。CLI・VS Code拡張と同じ結果になる |
| Markdown解析 | Marp Core内蔵のmarkdown-it（プラグインで位置情報を追加） | 描画と解析で同じパーサーを使い、対応関係のずれを防ぐ |
| UI | **Preact + TypeScript + Vite** | 軽い（約4KB）。スライド本体のDOMはPreactに管理させず、編集エンジンが直接操作する |
| PPTX生成 | **PptxGenJS** | ブラウザで動き、テキスト・表・画像・ノート・任意サイズに対応 |
| ファイル監視 | Rust `notify` クレート | OSの変更通知を使い、ポーリングしない |
| 更新 | `tauri-plugin-updater` + GitHub Releases | 署名付き更新をアプリ内で完結できる |
| テスト | Vitest（編集エンジン・書き出し変換）、`cargo test`（ファイル入出力） | 最重要の対応付けをテストで固める |

### 依存の脆弱性対応

`@xmldom/xmldom` は脆弱性の影響経路に到達しないものの修正版 `0.9.12` に固定し、KaTeX は条件付きで影響を受ける可能性があるものの互換性のため `0.17` のままとする。

パッケージ管理はnpm。CSSは素のCSS + CSS変数（ライト・ダークのトークン）。

## 2. 全体構成

```
┌──────────────── Tauri ウィンドウ（WebView2） ────────────────┐
│ UIシェル（Preact）                                            │
│   ツールバー / スライド一覧 / ステータスバー / ダイアログ          │
│ ┌───────────────────── スライド表示 ──────────────────────┐  │
│ │ Shadow DOM（アプリのCSSと分離）                            │  │
│ │   Marp Coreの出力HTML + テーマCSS                          │  │
│ │   編集エンジン（クリック → contenteditable → ソース差し替え）  │  │
│ └────────────────────────────────────────────────────────┘  │
│ ドキュメントモデル（ソース文字列・改行情報・履歴・保存状態）       │
│ PPTX書き出し（描画済みDOMを実測 → PptxGenJS）                 │
└───────────────▲─────────────────────────────▲───────────────┘
                │ invoke / event                │
┌───────────────┴──────── Rust（src-tauri） ────┴───────────────┐
│ ファイル読み書き（バイト単位・原子的保存）  ファイル監視（notify）   │
│ 最近使ったファイル・設定  テーマ設定の読み込み  資産プロトコルの許可範囲 │
│ 更新（updater）  ダイアログ（dialog）                            │
└───────────────────────────────────────────────────────────────┘
```

Rust側は「ファイルとOSとの境界」だけを担い、Markdownの解析・編集はすべてフロントエンドで行う。
描画と編集で同じmarkdown-itインスタンスを使うことが、対応付けの正しさの前提になる。

## 3. ディレクトリ構成

```
slideapp/
  AGENTS.md              プロジェクトの作業ルール
  docs/                  要件・設計
  src/                   フロントエンド
    app/                 UIシェル（Preact部品）
    document/            ドキュメントモデル、改行情報、履歴、保存状態
    marp/                Marp Coreの初期化、位置追跡プラグイン、URL書き換え
    editing/             直接編集エンジン（対応表、入力の照合、検証）
    export/pptx/         PPTX書き出し
    platform/            Tauri呼び出しの薄い包み（テスト時は差し替え）
    styles/              CSSトークン、ライト・ダーク
  src-tauri/             Rust
  tests/fixtures/        テスト用Markdown（CRLF・混在改行・BOM・入れ子など）
  .github/workflows/     CI、リリース
```

## 4. ドキュメントモデル（`src/document`）

### 4.1 読み込みと保存の不変条件

**編集していない部分は、保存後もバイト単位で同一であること。** これを次の方法で保証する。

- Rustはファイルをバイト列で読み、UTF-8として妥当か確認してから返す。BOMは取り除いて `hasBom` として別に返す。UTF-8でない場合は開かずにエラーを表示する（勝手に変換しない）
- フロントエンドは本文を **LF正規化した文字列** `text` と、**行ごとの改行コード配列** `eols: ("\r\n" | "\n" | "")[]` に分けて持つ
  - markdown-itは内部で `\r\n` を `\n` に変換するため、正規化した文字列を渡すと位置がそのまま一致する
  - 保存時は `text` を行に分け、各行に元の改行コードを付け直す。CRLF・LF・混在のどれでも元に戻る
  - 編集で行が増えた場合、新しい行にはファイル内で多い方の改行コードを使う（同数ならLF）。既存の各改行コードとBOMの有無は維持する
- 末尾に改行がないファイルは、最後の行の改行を `""` として保持する
- `\0` はmarkdown-itが置き換えるため、含むファイルは編集を無効にして閲覧のみとする

### 4.2 編集の単位

すべての変更は `{ start, end, insert }`（正規化文字列上の範囲置換）で表す。
履歴（元に戻す・やり直す）もこの単位で持つ。全文の書き直しは行わない。

- 連続した文字入力は、同じ文字ラン内で1秒以内なら1つの履歴にまとめる
- 改行は前後の文字入力とまとめず、一つの範囲置換を一回の履歴にする
- 履歴にはカーソル位置（どのランの何文字目か）も記録し、元に戻したときに復元する
- 外部変更による再読み込みは履歴を消去する（別の版の上に古い履歴を当てると壊れるため）

### 4.3 保存状態

| 状態 | 意味 | 表示 |
|---|---|---|
| clean | ディスクと一致 | ステータスバーに「保存済み」 |
| dirty | 未保存の変更あり | タイトルに `●`、ステータスバーに「未保存」 |
| conflict | 未保存の変更があり、ディスクも外部で変わった | 黄色の帯で選択肢を表示 |
| readonly | UTF-8でない、`\0` を含むなど | 帯で理由を表示 |

`diskHash`（最後に読んだか保存した時点のディスク内容のSHA-256）を持ち、競合判定に使う。

## 5. Rust側（`src-tauri`）

### 5.1 コマンド

| コマンド | 内容 |
|---|---|
| `open_file(path)` | バイト列を読み、`{ text, hasBom, hash, mtime }` を返す。監視を開始し、資産プロトコルの許可範囲に親フォルダを加える |
| `save_file(path, text, hasBom, expectedHash)` | ディスクの現在のハッシュが `expectedHash` と違えば保存せず `Conflict` を返す。同じなら原子的に保存し、新しいハッシュを返す |
| `read_theme_config(markdownPath)` | .mdのフォルダから上へ（`.git` のあるフォルダかドライブ直下まで）`.marprc.yml` / `.marprc.yaml` / `.marprc.json` / `.vscode/settings.json` を探し、最初に見つかった設定のテーマCSSを `{ themes: [{ path, css }], warnings }` で返す。JS設定・URLテーマは読まず警告にする |
| `recent_files_get / recent_files_add` | 最近使ったファイル（最大10件）。アプリ設定フォルダのJSONに保存 |
| `settings_get / settings_set` | テーマ（system/light/dark）、更新確認の有無、サイドバー幅など |
| `write_binary(path, bytes)` | PPTXの書き出し |

### 5.2 原子的保存

1. 同じフォルダに元の名前と無関係な短い一意名 `.slideapp-<ランダム8文字>.tmp` を `create_new` で確保して書き込み、`flush` と `sync_all` を行う。バックアップも同じ方式で `.slideapp-<ランダム8文字>.bak` を確保する
2. 保存開始時と一時ファイルの書き込み後に、元ファイルのハッシュを `expectedHash` と照合する。既存ファイルは Windows の `ReplaceFileW` で置換し、元ファイルの属性・ACLを引き継ぐ。保存先が無い場合は上書きしない移動（`MoveFileExW`、フラグ無し）を使い、移動までに宛先が現れた場合は `conflict` を返す
3. 置換成功後もバックアップのハッシュを `expectedHash` と照合してから削除する。不一致なら最終確認後の外部変更として `conflict` を返す。バックアップを使って外部内容を元のパスへ戻し、その際のディスク内容も別のバックアップに退避する。退避内容が自分の保存内容と一致するときだけ削除し、新たな外部内容や照合不能な内容はパスをログに出して残す。復旧に失敗した場合も外部内容のバックアップは削除せずパスをログに出す。自分の編集内容はフロントエンドのメモリに残る
4. `ReplaceFileW` がエラー1177で失敗した場合は、バックアップへ移った元ファイルを上書きしない移動で戻す。宛先が現れた場合はその内容を維持して `conflict` を返す。ほかの復旧失敗は元ファイルのバックアップを残し、そのパスをエラーとログに出す
5. 操作が作成した一時ファイル・不要なバックアップは削除を短い間隔で再試行し、それでも残る場合はパスをログに出す。次回の操作は別の一意名を使うため、残ったファイルで保存が妨げられない

一時ファイルは通常は保存中だけ存在する。復旧不能なバックアップや削除できなかったファイルは上記のとおり残す。
`.gitignore` の追加は利用者のリポジトリを変えるため行わない。

### 5.3 ファイル監視と自己保存の判別

- `notify` で開いているファイルの**親フォルダ**を非再帰で監視する（置き換え保存をするエディタではファイル単体の監視が外れるため）。対象ファイル名のイベントだけを使う
- イベントは150msまとめてから（デバウンス）ファイルを読み、ハッシュを計算する
- 共有違反などで読み取りに失敗した場合は、35msから最大2秒まで間隔を倍増し、読み取れるか監視が停止・切替されるまで再試行する。待機中は監視停止と新たなイベントを受信でき、保存用のロックも保持しない。短い共有違反は通知せず、読み取り失敗が続く場合に1回だけ通知する
- ハッシュが `diskHash` と同じなら何もしない。自分の保存直後の通知はこれで無視され、無限更新にならない
- 違えばフロントエンドへ `file-changed { text, hasBom, hash }` を送る
- ファイルが消えた・名前が変わった場合は `file-removed` を送り、帯で知らせる（内容はメモリに残し、「別名で保存」を促す）。削除直後の再出現も同じ再試行で確認する

## 6. 描画（`src/marp`）

### 6.1 Marp Coreの設定

- `new Marp({ script: false, html: 既定の許可リスト, math: 'mathjax' })`。描画結果に `<script>` を含めず、自動縮小などのブラウザ用処理は `@marp-team/marp-core/browser` を Shadow Root に対して呼ぶ
- HTMLはMarp Core既定の許可リストのみを通す。任意のHTMLやスクリプトは実行しない（ローカルファイル経由の危険な動作を防ぐ）
- CSPで、外部スクリプトとインラインスクリプトを禁止する。画像は `asset:`、`https:`、`data:` を許可する

### 6.2 テーマ

- 組み込み（default / gaia / uncover）はそのまま使う
- カスタムテーマは `read_theme_config` で得たCSSを `marp.themeSet.add()` で登録する
- `<style>` と `style` ディレクティブはMarp Coreが処理する

### 6.3 相対パスの解決

- markdown-itのコア規則を `inline` の直後に追加し、`image` トークンの `src` が相対パスなら、開いたファイルのフォルダを基準に絶対パスにしてTauriの資産URL（`convertFileSrc`）に置き換える。背景画像（`![bg]`）も画像トークンから作られるため、同じ処理で対応できる
- テーマCSSや `<style>` 内の `url(...)` の相対パスも、描画後のCSSを書き換えて同様に解決する
- Markdownソースは変更しない（描画時だけの変換）

### 6.4 再描画の抑制

- 描画結果をスライド単位のHTML文字列で保持し、前回と違うスライドだけDOMを差し替える（サムネイルも同じ）
- 外部変更で全体の内容が同じなら描画しない
- 再読み込み後は同じスライド番号を表示する（枚数が減った場合は最後のスライド）

## 7. 直接編集エンジン（`src/editing`）— 最重要

### 7.1 基本方針

1. **位置は解析時に記録し、推測しない。** markdown-itの解析中に、各文字トークンが元ソースのどこから来たかを記録する
2. **変更後は再解析して確かめる。** 書き換えたソースをもう一度解析し、構造が変わっていないこと・意図した文字になったことを確認してから採用する
3. **確かめられないものは編集させない。** 対応が取れない、または曖昧な要素は読み取り専用にし、理由を表示する

### 7.2 対応表の作り方

**ブロック**：`heading` / `paragraph` の `inline` トークンは `map`（行範囲）を持つ。
`inline.content` の各行が、元の各行のどこに当たるかを次の規則で決める。

- 行頭側で取り除かれてよいのは、空白・`>`・リスト記号（`-` `+` `*` `1.` `1)`）・見出し記号 `#` だけ
- 行末側で取り除かれてよいのは、空白と見出しの閉じ記号（` ##`）だけ
- 当てはまる位置がちょうど1つなら採用する。0個または2個以上なら、そのブロックは読み取り専用にする
- Setext見出し（下線 `===` / `---`）は下線の行を除いて照合する

**インライン**：markdown-itのインライン解析器に位置追跡を入れる。

- 各インライン規則の前後で `state.pos` を記録し、規則が作ったトークンに `[開始, 終了)` を付ける
- 普通の文字は `state.pending` にためられてから `pushPending` でトークンになるため、`pushPending` を包んで、ため始めた位置と終わった位置を付ける
- markdown-itの `fragments_join` と `text_join` は隣り合う文字トークンを連結し、位置情報が失われる。そこで、それぞれの直前に同じ連結を行う独自規則を入れ、連結した部分ごとの位置（セグメント）を保持する
- 各セグメントは「そのまま」（表示文字とソースが1対1）か「特殊」（`\*` や `&amp;` のように、ソースと表示が異なり分割できない）のどちらか
- Marp Coreの後処理（絵文字の置き換えなど）で分割され、位置情報がなくなったトークンは読み取り専用にする

この位置追跡はmarkdown-itの内部構造に依存するため、`markdown-it` と `@marp-team/marp-core` の版は固定し、更新時は対応表のテストをすべて通すことを条件にする。

### 7.3 描画への印付け

- 文字トークンの描画規則を包み、出力を `<span data-sm-run="ランID">` で囲む。それ以外のHTMLは変えない
- 包んだ規則の出力が、トークンの文字をHTMLエスケープしたものと異なる場合（絵文字の画像化など）は、そのランを読み取り専用にする
- 編集できるブロック要素（`h1`〜`h6`、`p`、`li` 内の `p` または `li` 本体）に `data-sm-block="ブロックID"` を付ける
- 描画後にDOMを確認し、`span` の `textContent` がランの文字と一致しなければ読み取り専用にする

### 7.4 編集の流れ

Shadow DOM内の選択範囲は編集面のShadow Rootの `getSelection()` から取得する。WebView2はスクリプトで置いた直後の選択をDocumentから取得できても、マウスドラッグ・矢印移動・文字入力後にはホスト要素へ丸めて返すため、Document側のノード・オフセットや `isCollapsed` では入力位置を判断しない。Shadow RootのAPIがないテスト環境だけDocumentへフォールバックする。

スライド本文は編集開始前も `user-select: text` にして、アプリ外枠の選択禁止を引き継がせない。選択・コピーだけでは編集を開始しない。

1. クリックした位置に編集できるランがあれば、そのブロック要素を `contenteditable` にし、クリック位置にカーソルを置く。編集できないものを押したら、理由をステータスバーに表示する（例：「表は直接編集に未対応です」）。ドラッグ・ダブルクリックで作った選択範囲の直後に届くclick（選択が編集面の中にあり、押す前から範囲が変わったか複数回クリックの場合）は選択の終わりとみなし、カーソルを動かさず編集も開始しない。選択しただけではソースを変更しない
2. ブロック内の読み取り専用部分（インラインコード、画像、HTML、数式）には `contenteditable="false"` を付け、カーソルが入らないようにする
3. 入力は次の2段階で扱う
   - **入力前（`beforeinput`）**：複数のランにまたがる選択範囲への入力、書式変更（Ctrl+Bなど）、ブラウザ標準の元に戻すは止めて、理由を表示する。改行はブラウザのDOM変更を止め、下記の範囲置換で処理する。ランの先頭でBackspaceを押した場合などは、隣のランへの操作としてアプリが処理する
   - **入力後（`input`、IME変換中は `compositionend` 後）**：対象ランのテキストノードを読み、元の文字との差分（共通の前後を除いた部分）を求める
4. 差分をソースの範囲置換に変換する。差分が「特殊」セグメントの途中にかかる場合は、そのセグメント全体を置き換える
5. 置換後のソースを再解析して**検証**する（7.5）。通らなければ、入力した記号に `\` を付けて再度検証する。それでも通らなければ、DOMを元の文字に戻して理由を表示する
6. 採用したらモデルを更新し（未保存状態にする）、対応表を作り直す。画面のDOMはブラウザが編集したものをそのまま使うため、入力のたびに再描画はしない
7. 編集の終了時（Esc、ほかの場所のクリック、スライドの切り替え）にMarp Coreで再描画し、サムネイルも更新する

貼り付けは書式なしの文字だけを受け付け、改行は空白に変える。

IMEの合成状態は `compositionstart` / `compositionend` を正とする。終了後に遅れて届く `input` / `beforeinput` の `isComposing` で合成を再開しない。開始イベントが欠けた入力では、その入力イベントのコミットを保留するが、保存用ゲートの合成状態は立てない。`isComposing=false` かつ `keyCode!==229` のkeydown、blur、クリックによる編集先の変更、明示的な編集終了では残ったDOMの文字を検証・コミットしてから合成待ちの操作を解放する。IME確定用Enterは改行として処理しない。

変換中は編集中ブロックの属性、スナップショット、描画を変更しない。子ブロックへ入力先が移る場合は合成前に記録したスナップショットを使う。終了時のコミット後、保存待ちの解放をマイクロタスクへ送り、直後の明示的な `compositionstart` があれば次の終了まで保留を継続する。TSFによる確定Enterの再送には識別情報がないため、`compositionend` 後100ms以内の通常Enterと改行beforeinputも抑止する（クリック・新しい合成開始で解除）。この時間内の意図的なEnterも抑止される制約がある。

開始イベントが欠けた仮入力状態もアダプタから参照し、その直後の通常Enterは文字の確定として扱う。100msのEnter再送抑止はcompositionendだけでなく、通常keydown・blur・編集終了などの代替確定にも共通で設定する。通常の入力だけでは抑止時間を延長しない。

#### 改行・段落分割

- 解析時に記録した行の対応、リスト項目の範囲・階層・記号、引用の接頭辞、インライン装飾の位置から挿入位置と継続接頭辞を決める。文字列検索で編集位置を探さない
- Shift+EnterはソースにLFと継続接頭辞（リストの内容字下げ、引用の `> `）を挿入する。再解析で同じブロック・同じ項目内に改行が一つ増えたことを照合する
- Enterは通常段落なら空行（引用内は引用の空行）を挿入する。リスト項目の最初の段落なら同じ階層・記号で新しい項目を挿入する。番号付きは元の番号+1と元の区切り記号（`.` / `)`）を使い、後続の番号は変えない
- 再解析で対象のブロックだけが期待どおり分かれ、対象外のブロック・インライン構造・表示文字・スライド構造が変わらないことを検証する。子リストや複数段落を含む項目の分割など対応が曖昧な場合は拒否する
- 見出し・表、装飾の途中、文字とソースの対応が一意でない位置は拒否する。理由は改行を安全に追加できない旨として表示する
- 採用したら一つの範囲置換として履歴に記録し、再描画する。新しい行の最初の編集可能ランへカーソルを移す

#### 末尾の空の編集先

- 項目・段落・行の末尾では、記録済みの挿入点を `[位置, 位置)` として持つ空の文字ランを作る。空のランにも通常と同じIDとブロック対応を付け、ソースに不可視文字やHTMLは入れない。最初の文字入力はこのゼロ長範囲への挿入として再解析・検証する
- 空の項目は `- ` / `8. ` など内容開始位置までの接頭辞を保持して永続化する。未入力で終了しても空の `li` を残す。解析し直した場合も、トークンが空の項目であり、行の接頭辞と挿入位置が一意なら空のランを復元する
- Markdownが空の段落・末尾のsoftbreakをトークンとして保持しない場合は、描画専用の仮文字を記録済み挿入点に入れて解析する。その仮文字のランをゼロ長ランに戻して描画し、他のソース座標のずれも戻す。仮文字はドキュメントモデル・保存・履歴には渡さない。空ランの表示はキャレット用の最小寸法を持たせる
- 空の段落・行を作る範囲置換は仮編集としてモデルに反映し、まだ履歴へ入れない。最初の検証済み文字入力で改行と文字を一回の履歴として確定する。入力せずEsc、クリック、フォーカス移動、保存前の編集終了、空行の先頭でのBackspaceを行ったら、記録した挿入範囲だけを取り消し、元の改行コード配列と履歴・Redoを復元する。Ctrl+Zも仮編集だけを取り消す
- 空ランへのカーソルは、ラン自身のオフセット0へ置く。Shadow Rootから得た選択が空ラン自身を指していれば、空行にいるとみなす。同じ空行ブロック内でのフォーカス移動でも取り消さない
- selectionchangeで空ランの外へ選択位置が移った場合も仮編集を取り消す。移動先は記録したソース位置から取消後のランへ対応付け、UTF-16オフセットと選択方向を復元して編集を続ける。選択通知が遅れる場合は通常keydown・beforeinputでも照合する。beforeinput中にDOMを再描画した場合、古いDOMへの標準入力は止め、文字入力は新しい選択範囲に対して既存アダプタで処理する。変換中はこの取消によるDOM変更を行わない
- 仮編集の開始・確定・取消は範囲置換の付帯情報としてDocumentModelへ渡す。App側の通常のコミット・再描画・履歴経路を共用し、全文差し替えや履歴の相殺エントリは作らない
- 空の編集先を確定させる最初の文字入力では、仮文字で検証した構造と実際の文字の構造が一致した場合だけ通常ランへ移す。通常入力と同じDOMを維持し、空ラン用の表示属性だけを外す。IME入力ではcompositionendまでDOMを維持する
- 先頭での分割は引き続き安全に対応できる場合だけとし、今回の空ランは末尾の挿入に限定する

### 7.5 検証の条件

通常の文字編集は、書き換え後の解析結果が次をすべて満たす場合だけ採用する。改行は上記の専用検証で許可した構造変化だけを認める。

- ブロックトークンの種類と並びが変わっていない（スライド枚数、見出しのレベル、リストの構造を含む）
- 編集したブロックのインライントークンの種類と記号（`**`、`_` など）の並びが変わっていない
- 編集したランの表示文字が、ユーザーの入力結果と一致する（ブロックの先頭・末尾の空白の違いは許す）
- ほかのランの表示文字は変わっていない

これにより、行頭に `#` や `1.` を入力して見出しやリストに変わってしまうこと、`*` の入力で強調が崩れることを防ぐ。

### 7.6 元に戻す・やり直す

- 編集中も非編集時も、Ctrl+Z / Ctrl+Y はアプリの履歴で処理する（ブラウザ標準の履歴はモデルとずれるため使わない）
- 元に戻した後は再描画し、記録したカーソル位置に戻す

### 7.7 P0で読み取り専用にするもの

表、コードブロック、インラインコード、数式、画像、HTML、絵文字、front matter、ディレクティブのコメント、Marp Coreが自動生成するヘッダー・フッター・ページ番号。
ヘッダー・フッターは `header:` などのディレクティブ値であり、P1で編集対応を検討する。

## 8. PPTX書き出し（`src/export/pptx`）

### 8.1 方式

Marp CLIの `--pptx` は各スライドを画像にするため編集できない。`--pptx-editable` はLibreOfficeが必要で、レイアウトの再現も限定的である。
そこで本アプリは、**アプリ内で描画済みのスライドDOMを実測し、PowerPointの部品に組み立て直す**。
位置・大きさ・文字のスタイルは計算済みの値（`getBoundingClientRect`、`getComputedStyle`）から取るため、テーマやカスタムCSSが効いた最終結果をそのまま反映できる。

### 8.2 処理の流れ

1. 書き出し用に、画面外の非表示コンテナで全スライドを等倍（例：1280×720px）で描画する。自動縮小（`<!-- fit -->`）やフォントの読み込み完了を待つ
2. スライドごとにDOMを上から順にたどり、要素を次のように分類する
   - **文字ブロック**（`h*`、`p`、`li`、`blockquote`、ヘッダー・フッター）→ テキストボックス
   - **表** → PowerPointの表
   - **画像** → 画像
   - **単色の箱** → 塗り・罫線付きの図形。均一な円形の角丸は `roundRect` とし、半径を実測値で指定する。非対称・楕円・複雑な装飾は箱の背景だけ画像化する
   - **SVG図** → `g`、`rect`（`rx`対応）、単純な `text`、`M/L/H/V` の直線パス、三角形の矢印マーカーをネイティブ図形へ変換する。画面座標変換を適用し、未対応要素・塗り・変形・クリッピングがあれば、途中の図形を破棄して当該SVGだけ画像化し理由を記録する
     - パスのサブパス境界と `Z/z` の閉路を解析する。接続する複数線分や閉路はサブパスごとに編集可能な自由形状（`custGeom`）にする。PptxGenJS 4.0.1に接合方式の指定APIがないため、既存のOOXML補正で対象図形のみに `miter`（miterlimitを含む）・`round`・`bevel` と平坦な端点を指定する。線幅による画像化は行わず、線と接合の描画範囲がSVG表示枠で切れる場合は画像化する。独立した直線サブパスは従来の直線図形を維持する。SVG仕様に従い、`marker-end` はpath全体の最終点だけに生成する。`marker-start/mid` はプレビューと書き出しの許可リストで保持し、未対応のためSVG単位で画像化する
     - 半透明の線（`stroke-opacity` または線色のalpha）を持つ複数サブパスのpathは、SVG単位で画像化し理由を記録する。同一pathの線を別図形に分割すると重なりの透明度が二重に適用されるため。不透明な線と、別々のpath要素が独立して重なる描画は従来のネイティブ変換を維持する
     - 参照変換と同じ表示にするため、SVG文字の字面が表示枠を3 CSS px以内だけ越える場合はネイティブ文字を維持し、近似として記録する。それを越える切り取りや文字以外の切り取りは画像化する
     - 生のSVGを使う場合は、プレビューと書き出しのMarpに同じ `svgHtmlAllowlist` を指定する。任意HTML・スクリプトは有効にしない。標準許可リストのままではSVGはエスケープされる
   - **背景**（`section` の背景色・背景画像、`bg` 分割の `figure`）→ スライド背景または最背面の画像
   - **再現できないもの** → 画像化（8.4）
3. 座標をpx→インチに変換し（スライド幅 ÷ 描画幅）、PptxGenJSで組み立てる
4. Marpのコメント（発表者ノート）をスライドノートに入れる
5. `write_binary` で保存する。保存後は画像化やフォント代用があった場合だけ、スライドごとの件数やフォント名を日本語で簡潔に知らせる。画像内の文字はPowerPointで編集できないことも伝える。通常の近似は利用者へ表示しない。エラー・警告は意味の分かる日本語で示し、内部診断は「詳細」の折りたたみ内に置く。問題がなければダイアログを出さず、書き出したファイル名をステータスに表示する

### 8.3 文字の変換

- 段落ごとに、文字ランを計算済みスタイル付きで集める：フォント名（`font-family` の先頭で実際に使えるもの）、サイズ（px→pt）、色、太字、斜体、下線、取り消し線、リンク先、文字間隔
- 段落の行間（`line-height`）、前後の余白、文字の配置、インデントを反映する
- 箇条書きは記号の種類（`list-style-type`）と階層を反映する。番号付きリストは開始番号も反映する
- 入れ子を含むリスト全体を1つのテキストボックスにし、各項目を段落にする。段落の階層・記号・開始番号と、DOMで実測した本文位置・段落間隔を設定する。PptxGenJSが階層数から再計算するインデントは、生成後のOOXMLで実測値に補正する
- 入れ子のない平坦なリストは、項目ごとに実測位置のテキストボックスを使い、PowerPointの段落高の累積誤差を避ける。入れ子リストの編集単位は維持する。小さい負の文字間隔（0.05emかつ1px以内）はDrawingMLの文字間隔として保存する
- 和文フォントはPPTXの `ea`（東アジア）フォントにも同じ名前を設定する
- テキストボックスの自動調整はオフにし、DOMの実測の大きさに少し余白を足す（折り返し位置の差による溢れを防ぐ）
- Marpで自動縮小済みの1行の見出しは、PowerPoint側のフォント幅の差で再び改行されないよう折り返しを無効にする
- Webフォント（`@import` のGoogle Fontsなど）は、Windowsにあればその名前、なければ近い代替（例：Noto Sans JP → Yu Gothic、Lato → Segoe UI）で書き出し、一覧に記録する
- 表のセル余白はDOMのpaddingをインチで渡す。列幅は実測した各行の文字幅と余白にフォント差の予備幅を加えた最小幅を確保し、行高は実測値を指定する。PowerPointが折り返しで行高を伸ばし、後続要素と重なることを防ぐ

### 8.4 画像化

PowerPointの部品で再現できない要素（数式、絵文字、未対応のSVG、グラデーション文字、影・変形、`::before` / `::after` の装飾、複雑な背景）は、その要素の範囲をPNGにして同じ位置に貼る。

- 方式：要素をSVGの `foreignObject` に複製してcanvasに描画する（`html-to-image` 相当の処理）
- 資産URLの画像は、canvasが汚染されないよう事前にdata URLへ変換する
- 透明部分を保ち、高解像度（2倍）で出力する

**技術的な確認事項（実装の最初に検証する）**：WebView2上で `foreignObject` → canvas の画像化が、Tauriの資産URL・Webフォント・Marpのテーマで正しく動くか。動かない場合は、Rust側でWebView2の `CapturePreview` を使い、画面の該当範囲を切り出す方式に切り替える。

2026-10-22の検証結果：実際のTauriアプリをWebView2（Chromium/Edge 155）で起動し、CDPからdefault / gaia / uncover、日本語、表、入れ子リスト、左右の背景分割、MathJax、SVG、独自テーマをPPTXへ出力した。資産URLのPNG・SVGを事前にdata URLへ変換するとcanvas汚染は起きず、数式と透過PNGも描画できた。data URLで埋め込んだWebフォントも画素が出ることを確認したため、`CapturePreview` は使わない。再実行用の入口は `tests/export/webview2.mjs`。

- `html-to-image.toPng()` は非表示ウィンドウで `requestAnimationFrame` 待ちになるため、`toSvg()` の後に `Image.decode()` とcanvasを直接使う。
- Marpのコード・自動縮小はShadow DOM内のSVGとslotを使う。画像化の直前だけSVG内のslotを計算済みスタイル付きの内容へ展開し、終了時に戻す。展開しない場合にコードの文字だけが欠落する問題を確認し、実画像の構文色の画素を検査する回帰チェックを追加した。編集可能な自動縮小見出しはSVGの実倍率を文字サイズに反映する。
- 現在のCSPの `connect-src` は外部フォントのfetchを許可しない。取得できないフォントはローカルのフォールバックで計測し、代替名と警告をレポートする。あらかじめ埋め込んだ `fontEmbedCSS` もAPIで受け取れる。Webフォントの外部取得を有効にする場合は、UIへの組み込み時にフォント配信元をCSPへ追加する必要がある。
- Element measurement and native conversion are isolated: unexpected geometry or unsupported style values rasterize only the affected element. Raster/asset failures are recorded with slide and element context in the report (and completion warnings); unaffected elements and slides still export.

- Native conversion is allowed only for explicitly allowlisted structures and computed style values verified in PowerPoint. All collectors share an ancestor-aware painted-state check, including hidden/content-visibility, visibility and empty boxes. Nonrectangular tables (hidden rows/cells/columns or spans) rasterize as a unit; unknown values never receive a guessed default. DOM-independent classification records why inline images, images in tables, unsupported list blocks, inline decoration, and text-transform require rasterization. Hidden text is excluded from native runs; text alpha is serialized as OOXML run transparency.
- Native eligibility has three outcomes: exact mapping, an explicitly allowlisted approximation, or rasterization. `styles.ts` centrally defines bounded typography approximations (underline offset/thickness, numeric/font features, kerning, rendering/smoothing and small letter spacing) and alpha border compositing. Every applied approximation is recorded by slide, element, CSS property/value and replacement in `report.approximatedElements`. Large underline changes, negative spacing outside the bound, text/case/visibility changes, unsupported markers, inline decoration and effects still rasterize. Built-in theme headings, paragraphs, links, lists and tables remain native.
- Only inseparable section effects (transform/opacity/filter) require a full-slide raster so that backgrounds and children share the same compositing context. Generated decorations are painted alone in their original containing blocks, cropped to their visible bounds, and inserted at their before/after position; they never force native slide content to rasterize. Uncover pagination uses a lower-right triangular gradient; only the gradient and text-shadow decoration are rasterized, while the page number stays native text. Block/list backgrounds and section borders/rounded boxes are also isolated behind native content. Pseudo-element content/background/mask/border assets are embedded before cloning; an asset failure is isolated and reported with the element and pseudo-element identified.
- Raster fallback keeps the original Marp DOM/CSS formatting context and isolates other painted branches without removing their layout space. Shadow DOM/slots alone are materialized with computed styles. Generated decoration retains the full slide viewport while painting, then crops the transparent canvas to the decoration bounds.
- Raster bounds include descendant overflow and shadow/filter extents, and image placement uses those expanded bounds. The slide viewport remains the final clip.
- Repeated background-only surfaces use an export-local cache keyed by computed appearance, not slide content or pagination. Identical PNG media are stored once in the PPTX package. Table cells retain their measured top/middle/bottom vertical alignment.
- SVG viewport eligibility includes stroke and marker paint, not just DOM geometry. A solid, opaque, square rectangle whose stroke crosses the viewport by at most 1 CSS pixel can retain exact visible paint as a native fill plus clipped rectangular border strips. Rounded/dashed/translucent or larger clipped strokes, clipped paths and markers rasterize the SVG. CSS path geometry overrides, transformed/hidden marker content and nondefault path caps/joins also rasterize the SVG.
- Text and list content boxes default to top alignment, preserving spare height from height/min-height. Measured glyph/range bounds and fully occupied line boxes can use middle alignment for font leading; list padding and borders are excluded from the text content box. Table cells may have different whitespace modes, but mixed modes within one cell rasterize the table.

### 8.5 精度の検証

`tests/fixtures/export/` に代表的なスライド（3種の組み込みテーマ、カスタムテーマ、日本語、箇条書きの入れ子、表、背景分割、数式）を置く。
書き出したPPTXの各図形の位置・文字・スタイルをテストで確認し、目視確認用に PowerPoint で開いた画面とアプリ表示の比較手順を残す。
検証用APIは計測モデル・変換レポートに加えて、等倍のMarp表示PNGを返せる。個人資料はリポジトリへ取り込まず一時ディレクトリで処理し、PowerPoint COMで既存変換と新変換をPNG化して表示と編集可能な図形数を比較する。対応する回帰入力は個人情報を含まない合成fixtureで維持する。

## 9. UI設計

### 9.1 画面構成（PowerPointの標準表示を手本）

```
┌─────────────────────────────────────────────────────────────┐
│ [開く][保存][↶][↷] │ [PowerPointに書き出し] │      [☀/☾][⚙]   │ ツールバー（36px）
├──────┬──────────────────────────────────────────────────────┤
│ 1 ▢  │                                                      │
│ 2 ▣  │              ┌──────────────────────┐                │
│ 3 ▢  │              │                      │                │
│ 4 ▢  │              │   選択中のスライド       │                │
│      │              │   （中央に最大表示）     │                │
│      │              └──────────────────────┘                │
│ ⟨⟨   │                                                      │
├──────┴──────────────────────────────────────────────────────┤
│ C:\…\deck.md   ● 未保存   スライド 2 / 12   編集：見出し     │ ステータスバー（24px）
└─────────────────────────────────────────────────────────────┘
```

- ウィンドウのタイトル：`deck.md ● — SlideApp`（未保存時に `●`）
- スライド一覧：幅180px（ドラッグで変更可、折りたたみ時は0px）。クリックで移動、選択中は枠で強調
- スライド表示：余白16pxを残して、縦横比を保ったまま最大に表示
- ステータスバー：ファイルのパス（クリックでエクスプローラーで表示）、保存状態、ページ番号、編集中の要素の種類または読み取り専用の理由
- 帯（ツールバーの下）：外部変更の競合、ファイルの削除、読み取り専用、更新のお知らせ。1つずつ表示する
- ファイル未選択時：中央に「ファイルを開く」ボタンと最近使ったファイルの一覧

### 9.2 競合の帯

「このファイルは外部で変更されました。」に対して次の3つの選択肢を出す。

- **ディスクの内容を読み込む**（自分の未保存の変更を捨てる）
- **自分の変更で上書き保存する**
- **比較用に別名で保存する**（自分の内容を `<名前>.mine.md` に保存してからディスクの内容を読み込む）

### 9.3 見た目

- 色はCSS変数で定義し、`prefers-color-scheme` と手動切替（system / light / dark）に対応する。スライド自体はテーマの色のまま表示する
- 中立的なグレー基調、アクセント色は1色。アニメーションはなし（ホバーの色変化のみ）
- 編集中のブロックは細い枠で示し、読み取り専用の要素はポインターを重ねると点線の枠と理由のツールチップを出す
- フォントはUIに `Segoe UI` / `Yu Gothic UI` を使う

## 10. 配布と更新

- アプリ識別子は `io.github.j23033it.slideapp`、リポジトリは https://github.com/j23033it/slideapp（公開）
- GitHub Actionsで、タグ `v*` のpush時に `tauri-action` でNSISインストーラー（`currentUser` インストール）、更新用の署名、`latest.json` を作り、GitHub Releasesの下書きとして公開する
- アプリは `https://github.com/j23033it/slideapp/releases/latest/download/latest.json` を見て更新を確認する
- 更新の署名鍵（`TAURI_SIGNING_PRIVATE_KEY`）はGitHubのシークレットに置き、リポジトリには入れない
- Windowsのコード署名（Authenticode）は当面行わない。初回インストール時にSmartScreenの警告が出ることをREADMEに書く
- 版番号は `package.json`、`Cargo.toml`、`tauri.conf.json` で一致させ、確認スクリプトでCIが検査する

## 11. 開発の段階

| 段階 | 内容 | 完了の条件 |
|---|---|---|
| 0 技術確認 | Tauri雛形、Marp描画をShadow DOMに表示、`foreignObject` 内での `contenteditable` とIME入力、資産URLでのローカル画像、PPTX用の画像化の可否 | 確認結果を本書に反映 |
| 1 表示 | ファイルを開く、描画、テーマ、画像、スライド一覧、ページ移動、最近使ったファイル、ダークモード | F-01（保存以外）、F-02 |
| 2 編集エンジン | 位置追跡、対応表、検証、範囲置換、改行保持、保存、履歴 | F-03、F-04、テスト一式 |
| 3 同期 | 監視、自己保存の判別、競合の帯 | F-05、F-06 |
| 4 PPTX書き出し | DOM実測、文字・表・画像・背景・ノート、画像化 | F-08 |
| 5 配布 | updater、GitHub Actions、README | F-07、初回リリース |

## 12. 今後の拡張（P1以降）

- Tabで階層変更
- 表のセル、ヘッダー・フッターの編集
- スライドの追加・削除・並べ替え（`---` 単位の移動）
- 書式の付け外し（Ctrl+B / Ctrl+I）
- PDFエクスポート、発表者モード
