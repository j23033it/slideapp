# SlideApp

Marp形式のMarkdown（.md）を、スライドのプレビュー上で直接編集するWindows向けデスクトップアプリです。
AIコーディングエージェントが作ったスライドを、人が見た目を確認しながら細かく直す用途を想定しています。

- ローカルの.mdだけを扱い、ネットワークなしで動作します
- 編集した文字の範囲だけを書き換えるため、Gitの差分が小さく保たれます
- 要件と設計：[docs/requirements.md](docs/requirements.md)、[docs/design.md](docs/design.md)

## インストール

1. [GitHub Releases](https://github.com/j23033it/slideapp/releases) から最新の `SlideApp_x.y.z_x64-setup.exe` をダウンロードします
2. 実行して画面の指示に従います。ユーザー単位のインストールなので管理者権限は不要です

**SmartScreenの警告について**: 現在はWindowsのコード署名（Authenticode）を行っていないため、初回起動時に「WindowsによってPCが保護されました」と表示されます。
「詳細情報」→「実行」で起動できます。配布元がこのリポジトリのReleasesであることを確認してから実行してください。

### 更新

新しい版があると、起動時にツールバーの下へ「v◯◯ があります」と表示されます。
「更新して再起動」を押すと、ダウンロード・インストール・再起動までアプリ内で完了します。
起動時の確認は設定で無効にできます（`checkUpdatesOnStartup`、既定は有効）。
更新パッケージは署名され、アプリ内で検証されます。

## 使い方の要点

- **開く**: ツールバーの「開く」または `Ctrl+O`。最近使ったファイルは最大10件記憶されます
- **編集**: スライド上の文字をクリックすると、その場で編集できます。編集できない要素は理由が表示されます
- **保存**: `Ctrl+S`
- **スライド移動**: 矢印キー、`PageUp` / `PageDown`、`Home` / `End`。左の一覧からも選べます
- **表示**: ダークモードはOS設定に追従します。設定からライト・ダークを固定できます

## 開発

前提：Windows 11、Node.js 20以上、Rust（stable）、WebView2、C++ビルドツール（MSVC）。

```powershell
npm install
npm run tauri dev
```

| コマンド | 内容 |
|---|---|
| `npm run tauri dev` | 開発起動 |
| `npm run typecheck` | TypeScriptの型検査 |
| `npm test` | Vitest |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rustのテスト |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` | Lint |
| `node scripts/check-version.mjs` | 3ファイルの版の一致を検査 |

pushとPull Requestでは、GitHub Actions（`.github/workflows/ci.yml`）が上記の検査をWindows上で実行します。

## リリース手順

1. 次の3ファイルの `version` を同じ値に上げる
   - `package.json`
   - `src-tauri/Cargo.toml`（`[package]` の `version`）
   - `src-tauri/tauri.conf.json`
2. 変更をコミットし、`v0.2.0` のようなタグをpushする

   ```powershell
   git tag v0.2.0
   git push origin v0.2.0
   ```

3. GitHub Actionsの `Release` が、NSISインストーラー・更新署名・`latest.json` を作り、GitHub Releasesに**下書き**として登録します
4. 下書きの内容（配布物とリリースノート）を確認して公開します。公開すると `releases/latest` が新しい版を指し、アプリ内の更新確認に反映されます

### 署名鍵

更新署名には次のGitHubシークレットを使います。秘密鍵はリポジトリに入れないでください。

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

公開鍵は `src-tauri/tauri.conf.json` の `plugins.updater.pubkey` に設定します。
現在は `REPLACE_WITH_UPDATER_PUBKEY` の仮置きなので、初回リリース前に実際の公開鍵へ置き換えてください。
