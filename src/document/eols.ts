/**
 * 本文を「LF正規化した text」と「行ごとの改行コード eols」に分ける。
 *
 * 不変条件: `joinEols(...splitEols(raw)) === raw`（バイト列として同一の文字列）
 *
 * - `eols` の長さは常に行数と等しい
 * - 末尾に改行がある場合、最後に空の行が1行増え、その `eols` は `""` になる
 *   （例: `"a\n"` → `text: "a\n"`, `eols: ["\n", ""]`）
 * - 設計上の改行コードは `\r\n` / `\n` のみ。孤立した `\r`（CRLFでもLFでもないCR）は
 *   行の内容として `text` に残す（往復で失われないようにするため）
 */
export type Eol = '\r\n' | '\n' | ''

export interface SplitDocument {
  /** LF正規化した本文 */
  text: string
  /** 行ごとの改行コード。長さは `text.split('\n').length` と等しい */
  eols: Eol[]
}

export function splitEols(raw: string): SplitDocument {
  const lines: string[] = []
  const eols: Eol[] = []
  let start = 0
  let i = 0

  while (i < raw.length) {
    if (raw.charCodeAt(i) === 0x0a /* \n */) {
      lines.push(raw.slice(start, i))
      eols.push('\n')
      i += 1
      start = i
    } else if (raw.charCodeAt(i) === 0x0d /* \r */ && raw.charCodeAt(i + 1) === 0x0a) {
      lines.push(raw.slice(start, i))
      eols.push('\r\n')
      i += 2
      start = i
    } else {
      i += 1
    }
  }

  lines.push(raw.slice(start))
  eols.push('')

  return { text: lines.join('\n'), eols }
}

/** ファイル内で最も多い改行コード。改行がなければ `\n` */
export function dominantEol(eols: readonly Eol[]): '\r\n' | '\n' {
  let crlf = 0
  let lf = 0
  for (const eol of eols) {
    if (eol === '\r\n') crlf += 1
    else if (eol === '\n') lf += 1
  }
  return crlf > lf ? '\r\n' : '\n'
}

/**
 * `splitEols` の逆変換。`eols` が足りない行（将来の行追加）は、
 * ファイル内で最も多い改行コードを使う。
 */
export function joinEols(text: string, eols: readonly Eol[]): string {
  const lines = text.split('\n')
  const fallback = dominantEol(eols)

  let out = ''
  for (let i = 0; i < lines.length; i += 1) {
    out += lines[i] ?? ''
    if (i < lines.length - 1) {
      out += eols[i] ?? fallback
    }
  }
  return out
}
