import type { ExportReport } from './model'
import { JAPANESE_ALIAS, JAPANESE_FONT, withJapaneseFont } from '../../marp/fonts'

const GENERIC: Record<string, string> = {
  serif: 'Times New Roman', 'sans-serif': 'Arial', monospace: 'Consolas',
  'system-ui': 'Segoe UI', 'ui-sans-serif': 'Segoe UI', 'ui-serif': 'Times New Roman',
  'ui-monospace': 'Consolas', 'ui-rounded': 'Segoe UI',
  cursive: 'Comic Sans MS', fantasy: 'Impact', math: 'Cambria Math',
  fangsong: 'SimSun', emoji: 'Segoe UI Emoji',
}
const genericFallback = (family: string): string | undefined => Object.hasOwn(GENERIC, family.toLowerCase()) ? GENERIC[family.toLowerCase()] : undefined
const fontList = (css: string) => css.split(',').map(f => f.trim().replace(/^["']|["']$/g, '')).filter(f => f !== JAPANESE_ALIAS)

// Chromium's generics depend on its language/preferences (Japanese Windows can
// use Noto Serif JP/BIZ UDGothic). Verify Latin advances instead of assuming the
// English Windows defaults. See README.md for reported Windows approximations.
const GENERIC_CANDIDATES = ['Noto Serif JP', 'BIZ UDGothic', 'Noto Sans JP', 'Yu Gothic UI', 'Yu Gothic', 'MS Gothic', 'MS Mincho', 'Meiryo', 'Arial', 'Times New Roman', 'Consolas', 'Courier New', 'Segoe UI']
const LATIN_SAMPLES = ['Hamburgefontsiv ABC abc 0123456789', 'Wiil.,:;!?@%&()[]{}', 'AVATAR office ffi 1O0lI']
interface GenericFont { font?: string; approximated?: boolean }
async function approximateGeneric(family: string, available: (name: string) => Promise<boolean>): Promise<GenericFont> {
  for (const font of [genericFallback(family)!, 'Segoe UI', 'Arial', 'Consolas', JAPANESE_FONT]) {
    if (await available(font)) return { font, approximated: true }
  }
  return { font: genericFallback(family), approximated: true }
}
async function genericFont(family: string, available: (name: string) => Promise<boolean>): Promise<GenericFont> {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return approximateGeneric(family, available)
  const signature = (name: string) => {
    context.font = `32px ${name}`
    return LATIN_SAMPLES.map(text => context.measureText(text).width)
  }
  const same = (a: number[], b: number[]) => a.every((width, i) => Math.abs(width - b[i]!) < .01)
  // Unknown names are accepted by CSS/canvas too: a solitary ui-monospace
  // measures the default serif on Windows. Change its trailing fallback to
  // distinguish that case from a supported generic before comparing candidates.
  if (!same(signature(`${family}, serif`), signature(`${family}, monospace`))) return {}
  const expected = signature(family)
  for (const candidate of [genericFallback(family)!, ...GENERIC_CANDIDATES]) {
    if (!(await available(candidate))) continue
    if (same(signature(JSON.stringify(candidate)), expected)) return { font: candidate }
  }
  return approximateGeneric(family, available)
}

/** CSS local() matches full/PostScript face names, not necessarily a family. */
export function localFontSources(family: string): string {
  return [family, `${family} Regular`, `${family.replaceAll(' ', '')}-Regular`].map(name => `local(${JSON.stringify(name)})`).join(',')
}

/** Local FontFace lookup excludes downloaded fonts, unlike document.fonts.check(). */
export async function resolveFonts(root: ParentNode, report: ExportReport): Promise<Map<string, string>> {
  const families = new Set([...root.querySelectorAll('*')].flatMap(el => [getComputedStyle(el).fontFamily, ...(el.matches('li') ? [getComputedStyle(el, '::marker').fontFamily] : [])]).filter(Boolean))
  const localCache = new Map<string, Promise<boolean>>()
  const available = (family: string) => {
    if (!localCache.has(family)) localCache.set(family, new FontFace('__slideapp_local_probe', localFontSources(family)).load().then(() => true, () => false))
    return localCache.get(family)!
  }
  const resolved = new Map<string, string>()
  const generics = new Map<string, Promise<GenericFont>>()
  if (!(await available(JAPANESE_FONT))) throw new Error('日本語の書き出しに必要な Noto Sans JP が見つかりません。Windows にフォントをインストールしてください。')
  for (const css of families) {
    const candidates = fontList(css)
    const requested = candidates[0] ?? 'sans-serif'
    let chosen: string | undefined
    let approximated: string | undefined
    for (const family of candidates) {
      if (genericFallback(family)) {
        if (!generics.has(family)) generics.set(family, genericFont(family, available))
        const result = await generics.get(family)!
        if (result.font) { chosen = result.font; if (result.approximated) approximated = family; break }
      } else if (await available(family)) { chosen = family; break }
    }
    if (!chosen) {
      const generic = candidates.find(family => genericFallback(family))
      if (generic) { chosen = (await approximateGeneric(generic, available)).font; approximated = generic }
    }
    chosen ??= /mono|code/i.test(css) ? 'Consolas' : 'Segoe UI'
    resolved.set(css, chosen)
    for (const name of [approximated, !genericFallback(requested) && !['-apple-system', 'BlinkMacSystemFont'].includes(requested) && requested !== chosen ? requested : undefined]) {
      if (name && !report.substitutedFonts.some(f => f.requested === name && f.replacement === chosen)) report.substitutedFonts.push({ requested: name, replacement: chosen })
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
    if (replacement && requested !== replacement && !genericFallback(requested) && !embedded.has(requested.toLowerCase())) {
      element.style.setProperty('font-family', withJapaneseFont(JSON.stringify(replacement)), 'important')
      fonts.set(getComputedStyle(element).fontFamily, replacement)
    }
  }
}
