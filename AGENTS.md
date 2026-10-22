# Slidemark（仮称）

Marp形式のMarkdownを、スライドのプレビュー上で直接編集するWindows向けデスクトップアプリ。Tauri 2で作る。

- 要件：[docs/requirements.md](docs/requirements.md)
- 設計：[docs/design.md](docs/design.md)。設計と異なる実装をする場合は、先に設計書を更新する

## 守ること

- 編集していない部分はバイト単位で変えない（改行コード、BOM、空白を含む）。Markdown全体をHTMLや構文木から作り直さない
- ソースの書き換えは、解析時に記録した位置に基づく範囲置換だけで行う。文字列検索による置換は禁止
- 対応が曖昧な要素や検証に通らない編集は、推測で実行せず読み取り専用にして理由を表示する
- `markdown-it` と `@marp-team/marp-core` の版は固定する。更新するときは `src/editing` のテストをすべて通す
- Marp Coreの出力に任意のHTMLやスクリプトを通さない
- Electronは使わない

## コマンド

- 開発起動：`npm run tauri dev`
- テスト：`npm test`（Vitest）、`cargo test --manifest-path src-tauri/Cargo.toml`
- 型検査：`npm run typecheck`
