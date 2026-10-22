import type { ExportReport } from './model'

const GENERIC: Record<string, string> = {
  serif: 'Times New Roman', 'sans-serif': 'Segoe UI', monospace: 'Consolas',
  'system-ui': 'Segoe UI', 'ui-sans-serif': 'Segoe UI', 'ui-serif': 'Times New Roman',
  'ui-monospace': 'Consolas', '-apple-system': 'Segoe UI', 'BlinkMacSystemFont': 'Segoe UI',
}
const fontList = (css: string) => css.split(',').map(f => f.trim().replace(/^["']|["']$/g, ''))

/** Local FontFace lookup excludes downloaded fonts, unlike document.fonts.check(). */
export async function resolveFonts(root: ParentNode, report: ExportReport): Promise<Map<string, string>> {
  const families = new Set([...root.querySelectorAll('*')].flatMap(el => [getComputedStyle(el).fontFamily, ...(el.matches('li') ? [getComputedStyle(el, '::marker').fontFamily] : [])]).filter(Boolean))
  const localCache = new Map<string, Promise<boolean>>()
  const available = (family: string) => {
    if (!localCache.has(family)) localCache.set(family, new FontFace('__slideapp_local_probe', `local(${JSON.stringify(family)})`).load().then(() => true, () => false))
    return localCache.get(family)!
  }
  const resolved = new Map<string, string>()
  for (const css of families) {
    const candidates = fontList(css)
    const requested = candidates[0] ?? 'sans-serif'
    let chosen: string | undefined
    for (const family of candidates) {
      const mapped = GENERIC[family] ?? family
      if (await available(mapped)) { chosen = mapped; break }
    }
    chosen ??= /mono|code/i.test(css) ? 'Consolas' : /Noto.*JP|Gothic|ゴシック/i.test(css) ? 'Yu Gothic' : 'Segoe UI'
    // Prefer Japanese fallback for a missing Japanese Web font, even if sans-serif follows it.
    if (/Noto.*JP/i.test(requested) && !(await available(requested))) chosen = 'Yu Gothic'
    resolved.set(css, chosen)
    if (!GENERIC[requested] && requested !== chosen && !report.substitutedFonts.some(f => f.requested === requested)) {
      report.substitutedFonts.push({ requested, replacement: chosen })
    }
  }
  return resolved
}

/** A globally loaded font must not disappear only when the element is rasterized. */
export function applyUnavailableFontFallbacks(root: ParentNode, fonts: Map<string, string>, embeddedCSS: string): void {
  const embedded = new Set([...embeddedCSS.matchAll(/font-family\s*:\s*([^;}]+)/gi)].map(match => fontList(match[1]!)[0]?.toLowerCase()))
  // Capture the computed families before changing inherited styles.
  const elements = [...root.querySelectorAll<HTMLElement>('*')].map(element => ({ element, family: getComputedStyle(element).fontFamily }))
  for (const { element, family } of elements) {
    const requested = fontList(family)[0] ?? ''
    const replacement = fonts.get(family)
    if (replacement && requested !== replacement && !GENERIC[requested] && !embedded.has(requested.toLowerCase())) {
      element.style.fontFamily = JSON.stringify(replacement)
      fonts.set(getComputedStyle(element).fontFamily, replacement)
    }
  }
}
