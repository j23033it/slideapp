---
marp: true
theme: gaia
paginate: true
size: 16:9
---

<!-- _class: lead -->

# SlideApp サンプル

Marp形式のMarkdownを、そのままスライドとして表示します。

---

## 表示できるもの

- **太字** と *斜体* のテキスト
- 箇条書き
- `インラインコード`
- [リンク](https://example.com)

---

## 表

| 項目 | 内容 |
| --- | --- |
| 描画 | Marp Core |
| UI | Preact |
| 基盤 | Tauri 2 |

---

![bg right:38%](images/sample.png)

## 背景画像

`![bg right](...)` でローカル画像を背景に表示します。

- 相対パスはMarkdownの場所から解決
- スライドサイズは16:9

---

## 最後のスライド

矢印キー、PageUp / PageDown、Home / End で移動できます。
