/**
 * MarpのテーマCSSに含まれるWebフォントの`@import`を扱う。
 *
 * Chromium（WebView2）はShadow DOM内の`@font-face`を登録しないため、
 * `@import`だけをdocument.headへ移して読み込ませる。
 */

const IMPORT_PATTERN = /@import\s+[^;]+;/g

export interface SplitCss {
  /** 元のCSSから取り出した`@import`（元の順序を保つ） */
  imports: string[]
  /** `@import`を取り除いたCSS */
  css: string
}

export function splitCssImports(css: string): SplitCss {
  const imports = css.match(IMPORT_PATTERN)
  if (!imports) return { imports: [], css }

  return {
    imports: imports.map((rule) => rule.trim()),
    css: css.replace(IMPORT_PATTERN, '').replace(/^\s+/, ''),
  }
}

/** 取り出した`@import`を、重複させずにdocument.headの1つのstyleへ入れる */
export function ensureDocumentImports(imports: string[]): void {
  if (imports.length === 0) return

  let style = document.querySelector<HTMLStyleElement>('style[data-role="marp-fonts"]')
  if (!style) {
    style = document.createElement('style')
    style.dataset.role = 'marp-fonts'
    document.head.append(style)
  }

  const current = style.textContent ?? ''
  const missing = imports.filter((rule) => !current.includes(rule))
  if (missing.length === 0) return

  style.textContent = current.length === 0 ? missing.join('\n') : `${current}\n${missing.join('\n')}`
}
