// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Marp } from '@marp-team/marp-core'
import { MarpRenderer } from '../../src/marp/renderer'
import { SlideSurface } from '../../src/marp/surface'
import { applyJapaneseFonts, isJapaneseCharacter, JAPANESE_ALIAS, JAPANESE_FONT_CSS, withJapaneseFont } from '../../src/marp/fonts'
import { applyUnavailableFontFallbacks, resolveFonts } from '../../src/export/pptx/fonts'
import type { ExportReport } from '../../src/export/pptx/model'

let installed: string[], browserFonts: Record<string, string>
beforeEach(() => {
  installed = []
  browserFonts = { serif: 'Times New Roman', 'sans-serif': 'Segoe UI', monospace: 'Consolas', 'system-ui': 'Unlisted UI Font' }
  const context = { font: '', measureText() {
    const candidates = this.font.slice(5).split(',').map(f => f.trim().replace(/^["']|["']$/g, ''))
    const name = candidates.map(f => browserFonts[f] ?? (installed.includes(f) ? f : undefined)).find(Boolean) ?? 'Times New Roman'
    return { width: [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) }
  } }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as CanvasRenderingContext2D)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = ''; document.head.innerHTML = '' })
const report = (): ExportReport => ({ slideCount: 1, rasterizedCount: 0, rasterizedElements: [], substitutedFonts: [], warnings: [] })
function surface(family = 'Arial, "Yu Gothic"') {
  const host = document.createElement('div')
  document.body.append(host)
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = '<section><p>日本語 ABC 123 カタカナ、全角！ ｶﾅ</p></section>'
  root.querySelector('p')!.style.fontFamily = family
  return root
}
function localFonts(available: string[]) {
  installed = available.map(name => name.replace(/ Regular$/, ''))
  const sources: string[] = []
  vi.stubGlobal('FontFace', class {
    constructor(_name: string, private source: string) { sources.push(source) }
    load() { return available.some(name => this.source.includes(`local("${name}")`)) ? Promise.resolve(this) : Promise.reject(new Error('missing')) }
  })
  return sources
}

describe('Japanese font policy shared by preview/export', () => {
  it('preserves inherited first-line fonts through the production renderer without decorating editing DOM', () => {
    const deck = new MarpRenderer(path => path).render('---\nstyle: |\n  p { font-family:Arial }\n  p::first-line { font-family:Consolas }\n---\nEnglish **BOLD** ABC 日本語', null)
    const original = document.createElement('div')
    original.innerHTML = deck.slides[0]!
    const host = document.createElement('div')
    document.body.append(host)
    const surface = new SlideSurface(host, { layout: 'single' })
    try {
      surface.update(deck, 0)
      const runs = [...surface.root.querySelectorAll('[data-sm-run]')]
      expect(runs.length).toBeGreaterThan(1)
      expect(runs.map(run => run.outerHTML)).toEqual([...original.querySelectorAll('[data-sm-run]')].map(run => run.outerHTML))
      expect(surface.root.querySelector('strong')!.hasAttribute('style')).toBe(false)
      const pseudoRules = [...surface.root.querySelectorAll('style')].flatMap(style => [...style.sheet!.cssRules]).filter(rule => rule.cssText.includes('::first-line'))
      expect(pseudoRules.some(rule => rule.cssText.includes(JAPANESE_ALIAS) && rule.cssText.includes('Consolas'))).toBe(true)
      surface.update(deck, 0)
      expect(runs[0]).toBe(surface.root.querySelector('[data-sm-run]'))
      expect(runs.map(run => run.outerHTML)).toEqual([...original.querySelectorAll('[data-sm-run]')].map(run => run.outerHTML))
    } finally { surface.dispose() }
  })
  it('includes kana/kanji/fullwidth forms and excludes ASCII/Hangul/emoji', () => {
    for (const c of 'あア漢、。　Ａ１！ｶﾅㇰ㆐𠮷') expect(isJapaneseCharacter(c), c).toBe(true)
    for (const c of 'Aa1! 한ㄅㄆㄇㄈ😀é') expect(isJapaneseCharacter(c), c).toBe(false)
  })
  it('preserves SVG selector casing, conditional families and font shorthand across repeat application', () => {
    const root = surface('')
    const style = document.createElement('style')
    style.textContent = '@font-face{font-family:Author;src:local("Arial")} @media screen { foreignObject p { font:italic 24px Consolas !important } foreignObject strong {font-family:inherit} }'
    root.prepend(style)
    applyJapaneseFonts(root)
    const css = style.textContent!
    expect(css).toContain('foreignObject p')
    expect(css).toContain('foreignObject strong {font-family:inherit}')
    expect(css).toContain('@font-face{font-family:Author;')
    expect(css).toContain(JAPANESE_ALIAS)
    applyJapaneseFonts(root)
    expect(style.textContent).toBe(css)
    // Reparse after a theme refresh, rather than merely hitting the style cache.
    style.textContent = css + '\n'
    applyJapaneseFonts(root)
    expect(style.textContent).toBe(css + '\n')
  })
  it('keeps original Latin families and text nodes; re-evaluates theme changes', () => {
    const root = surface(), p = root.querySelector('p')!, text = p.firstChild
    applyJapaneseFonts(root)
    expect(p.style.fontFamily).toContain(JAPANESE_ALIAS)
    expect(p.style.fontFamily).toContain('Arial')
    expect(p.style.fontFamily).toContain('Yu Gothic')
    expect(p.firstChild).toBe(text)
    applyJapaneseFonts(root)
    expect(p.style.fontFamily.match(/__SlideApp Japanese/g)).toHaveLength(1)
    expect(document.head.querySelectorAll('[data-role="marp-japanese-font"]')).toHaveLength(1)
    expect(document.head.textContent).toContain('unicode-range:')
    expect(document.head.textContent).toContain('font-weight:100 900')
    expect(getComputedStyle(root.querySelector('section')!).fontFamily).toContain(JAPANESE_ALIAS)
  })
  it('re-evaluates inherited families after a theme change without replacing text', () => {
    const root = surface(''), p = root.querySelector('p')!, text = p.firstChild
    const style = document.createElement('style')
    style.textContent = 'section {font-family:Arial}'
    root.prepend(style)
    applyJapaneseFonts(root)
    expect(getComputedStyle(p).fontFamily).toContain('Arial')
    style.textContent = 'section {font-family:Consolas}'
    applyJapaneseFonts(root)
    expect(getComputedStyle(p).fontFamily).toContain('Consolas')
    expect(getComputedStyle(p).fontFamily).not.toContain('Arial')
    expect(p.style.fontFamily).toBe('')
    expect(p.firstChild).toBe(text)
  })
  it('adds the Japanese face to an explicitly styled pseudo even when its family matches the body', () => {
    const root = surface('"Yu Mincho"')
    const style = document.createElement('style')
    style.textContent = 'section.alpha.beta.gamma.delta p::before { content:"日本語"; font-family:"Yu Mincho" !important }'
    root.prepend(style)
    applyJapaneseFonts(root)
    const rule = style.sheet!.cssRules[0] as CSSStyleRule
    expect(rule.style.fontFamily).toContain(JAPANESE_ALIAS)
    expect(rule.style.fontFamily).toContain('Yu Mincho')
    expect(rule.style.getPropertyPriority('font-family')).toBe('important')
    expect(rule.selectorText).toBe('section.alpha.beta.gamma.delta p::before')
    applyJapaneseFonts(root)
    expect(style.textContent!.match(/__SlideApp Japanese/g)).toHaveLength(1)
  })
  it('leaves inherited pseudos inherited when export substitutes an unavailable Latin font', async () => {
    localFonts(['Noto Sans JP', 'Arial'])
    const root = surface('MissingFont, Arial'), p = root.querySelector('p')!
    // happy-dom returns the element style for pseudos, like browser inheritance.
    applyJapaneseFonts(root)
    expect(root.querySelector('[data-role="marp-japanese-pseudos"]')).toBeNull()
    const fonts = await resolveFonts(root, report())
    applyUnavailableFontFallbacks(root, fonts, JAPANESE_FONT_CSS)
    expect(getComputedStyle(p, '::first-letter').fontFamily).toBe(getComputedStyle(p).fontFamily)
  })
  it.each([
    ['default', 'ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace'],
    ['gaia', 'Roboto Mono,monospace'],
    ['uncover', 'SFMono-Regular,Consolas,Liberation Mono,Menlo,Courier,monospace'],
  ])('keeps the actual %s theme code stack on Consolas when earlier names are unavailable', async (theme, family) => {
    const rendered = new Marp().render(`---\ntheme: ${theme}\n---\n~~~\nconst ABC = 123;\n~~~`)
    expect(rendered.css).toContain(family)
    localFonts(['Noto Sans JP', 'Times New Roman', 'Consolas', 'Segoe UI'])
    const root = surface(family), state = report()
    const fonts = await resolveFonts(root, state)
    expect(fonts.get(getComputedStyle(root.querySelector('p')!).fontFamily)).toBe('Consolas')
  })
  it.each([
    ['system-ui', 'Segoe UI'], ['ui-sans-serif', 'Segoe UI'], ['ui-serif', 'Times New Roman'],
    ['ui-monospace', 'Consolas'], ['ui-rounded', 'Segoe UI'], ['sans-serif', 'Arial'],
    ['serif', 'Times New Roman'], ['monospace', 'Consolas'], ['cursive', 'Comic Sans MS'],
    ['fantasy', 'Impact'], ['math', 'Cambria Math'], ['fangsong', 'SimSun'], ['emoji', 'Segoe UI Emoji'],
  ])('continues with a reported approximation for unmatched %s', async (family, expected) => {
    // A supported generic with advances unlike any installed candidate.
    browserFonts[family] = 'Unlisted browser face'
    localFonts(['Noto Sans JP', 'Segoe UI', 'Arial', 'Times New Roman', 'Consolas', 'Comic Sans MS', 'Impact', 'Cambria Math', 'SimSun', 'Segoe UI Emoji'])
    const root = surface(family), state = report()
    const fonts = await resolveFonts(root, state)
    const replacement = fonts.get(getComputedStyle(root.querySelector('p')!).fontFamily)
    expect(replacement).toBe(expected)
    expect(state.substitutedFonts).toContainEqual({ requested: family, replacement })
  })
  it('maps system-ui by actual advances when a known installed face matches', async () => {
    browserFonts['system-ui'] = 'Segoe UI'
    localFonts(['Noto Sans JP', 'Segoe UI'])
    const root = surface('system-ui'), state = report()
    expect((await resolveFonts(root, state)).get('system-ui')).toBe('Segoe UI')
    expect(state.substitutedFonts.some(f => f.requested === 'system-ui')).toBe(false)
  })
  it('approximates a lone unsupported ui-monospace instead of adopting the default serif', async () => {
    localFonts(['Noto Sans JP', 'Consolas', 'Times New Roman'])
    const state = report()
    expect((await resolveFonts(surface('ui-monospace'), state)).get('ui-monospace')).toBe('Consolas')
    expect(state.substitutedFonts).toContainEqual({ requested: 'ui-monospace', replacement: 'Consolas' })
  })
  it('continues with a reported Windows approximation when canvas measurement is unavailable', async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null)
    localFonts(['Noto Sans JP', 'Segoe UI'])
    const state = report()
    expect((await resolveFonts(surface('system-ui'), state)).get('system-ui')).toBe('Segoe UI')
    expect(state.substitutedFonts).toContainEqual({ requested: 'system-ui', replacement: 'Segoe UI' })
  })
  it.each(['Arial, "Yu Gothic"', '"Yu Gothic", Arial', 'sans-serif', 'serif', 'monospace'])('resolves Latin independently of the Japanese face: %s', async (family) => {
    const sources = localFonts(['Noto Sans JP', 'Arial', 'Yu Gothic Regular', 'Segoe UI', 'Times New Roman', 'Consolas'])
    const root = surface(family), state = report()
    applyJapaneseFonts(root)
    const computed = getComputedStyle(root.querySelector('p')!).fontFamily
    const fonts = await resolveFonts(root, state)
    expect(fonts.get(computed)).toBe(family.startsWith('Arial') ? 'Arial' : family.includes('Yu Gothic') ? 'Yu Gothic' : family === 'serif' ? 'Times New Roman' : family === 'monospace' ? 'Consolas' : 'Segoe UI')
    if (family.includes('Yu Gothic')) expect(sources.some(s => s.includes('local("Yu Gothic Regular")'))).toBe(!family.startsWith('Arial'))
    expect(state.substitutedFonts).toEqual([])
  })
  it('retains Japanese policy when an unavailable Latin font is replaced', async () => {
    localFonts(['Noto Sans JP', 'Arial'])
    const root = surface('MissingFont, Arial'), state = report()
    applyJapaneseFonts(root)
    const fonts = await resolveFonts(root, state)
    applyUnavailableFontFallbacks(root, fonts, JAPANESE_FONT_CSS)
    expect(root.querySelector('p')!.style.fontFamily.replaceAll('"', '')).toBe(withJapaneseFont('Arial').replaceAll('"', ''))
    expect(state.substitutedFonts).toContainEqual({ requested: 'MissingFont', replacement: 'Arial' })
  })
  it('fails explicitly when the required Japanese font is missing', async () => {
    localFonts(['Arial'])
    await expect(resolveFonts(surface(), report())).rejects.toThrow('Noto Sans JP')
  })
})
