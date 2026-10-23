/**
 * Marpのフォント読み込みと、プレビュー・書き出し共通の和文指定を扱う。
 *
 * Chromium（WebView2）はShadow DOM内の`@font-face`を登録しないため、
 * `@import`と日本語専用フォント面はdocument.headで読み込ませる。
 */

import postcss from 'postcss'

const IMPORT_PATTERN = /@import\s+[^;]+;/g

export const JAPANESE_FONT = 'Noto Sans JP'
// A separate name leaves the author's/system font faces available for Latin.
export const JAPANESE_ALIAS = '__SlideApp Japanese'
// Unicode 17 Japanese-related blocks; see docs/design.md for scope and sources.
export const JAPANESE_RANGES = 'U+2E80-30FF,U+3190-319F,U+31F0-33FF,U+3400-4DBF,U+4E00-9FFF,U+F900-FAFF,U+FE10-FE1F,U+FE30-FE4F,U+FF01-FF9F,U+FFE0-FFE6,U+1AFF0-1AFFF,U+1B000-1B16F,U+20000-3347F'
export const JAPANESE_FONT_CSS = `@font-face{font-family:"${JAPANESE_ALIAS}";src:local("Noto Sans JP"),local("Noto Sans JP Regular"),local("NotoSansJP-Regular");font-weight:100 900;unicode-range:${JAPANESE_RANGES};}`
const japaneseCodepoints = JAPANESE_RANGES.split(',').map(range => range.slice(2).split('-').map(n => Number.parseInt(n, 16)))
export function isJapaneseCharacter(character: string): boolean {
  const point = character.codePointAt(0)
  return point !== undefined && japaneseCodepoints.some(([start, end]) => point >= start! && point <= end!)
}

export function withJapaneseFont(family: string): string {
  return family.includes(JAPANESE_ALIAS) ? family : `"${JAPANESE_ALIAS}", ${family || 'serif'}`
}

function prependJapaneseFamily(style: CSSStyleDeclaration): boolean {
  const family = style.getPropertyValue('font-family')
  // Keep inheritance (notably ::first-line through editing spans) intact.
  if (!family || family.includes(JAPANESE_ALIAS) || /^(inherit|unset|revert|revert-layer)$/i.test(family)) return false
  style.setProperty('font-family', withJapaneseFont(family === 'initial' ? 'serif' : family), style.getPropertyPriority('font-family'))
  return true
}

function rewriteFontRules(css: string): string {
  const sheet = postcss.parse(css)
  sheet.walkDecls(/^font(?:-family)?$/i, declaration => {
    if (declaration.parent?.type !== 'rule') return // Keep @font-face names.
    const next = declaration.next()
    if (declaration.prop.toLowerCase() === 'font' && next?.type === 'decl' && next.prop === 'font-family' && next.value.includes(JAPANESE_ALIAS)) return
    const style = document.createElement('span').style
    style.setProperty(declaration.prop.toLowerCase(), declaration.value)
    if (!prependJapaneseFamily(style)) return
    if (declaration.prop.toLowerCase() === 'font-family') declaration.value = style.fontFamily
    else declaration.cloneAfter({ prop: 'font-family', value: style.fontFamily })
  })
  // CSSOM cssText lowercases foreignObject in HTML documents. Preserve the
  // authored selectors so they also match case-sensitive SVG raster surfaces.
  return sheet.toString()
}

const processedStyles = new WeakMap<HTMLStyleElement, string>()

/** Rendering-only font policy. Never splits text nodes or changes Markdown. */
export function applyJapaneseFonts(root: ShadowRoot): void {
  if (!document.head.querySelector('[data-role="marp-japanese-font"]')) {
    const face = document.createElement('style')
    face.dataset.role = 'marp-japanese-font'
    face.textContent = JAPANESE_FONT_CSS
    document.head.append(face)
  }
  if (!root.querySelector('[data-role="marp-japanese-default"]')) {
    const style = document.createElement('style')
    style.dataset.role = 'marp-japanese-default'
    style.textContent = `:where(section){font-family:${withJapaneseFont('serif')}}`
    root.prepend(style)
  }
  for (const style of root.querySelectorAll('style')) {
    const css = style.textContent ?? ''
    if (processedStyles.get(style) === css) continue
    const rewritten = rewriteFontRules(css)
    if (rewritten !== css) style.textContent = rewritten
    processedStyles.set(style, rewritten)
  }
  for (const el of root.querySelectorAll<HTMLElement | SVGElement>('section[style],section [style]')) prependJapaneseFamily(el.style)
  for (const el of root.querySelectorAll('section [font-family]')) {
    const family = el.getAttribute('font-family')!
    if (!/^(inherit|unset|revert|revert-layer)$/i.test(family)) el.setAttribute('font-family', withJapaneseFont(family))
  }
}

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
