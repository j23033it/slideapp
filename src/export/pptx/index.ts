import type { Marp } from '@marp-team/marp-core'
import type { MarpCoreBrowser } from '@marp-team/marp-core/browser'
import { convertFileSrc } from '@tauri-apps/api/core'
import { splitRenderedSlides } from '../../marp/renderer'
import { rewriteCssUrls, resolveAssetPath } from '../../marp/urls'
import { splitCssImports } from '../../marp/fonts'
import { applyUnavailableFontFallbacks, resolveFonts } from './fonts'
import { generatePptx } from './generate'
import { measureSlide } from './measure'
import { inlineImages, rasterize } from './raster'
import { reportElementError, type ExportReport, type MeasuredSlide } from './model'

export type { ExportReport, MeasuredSlide } from './model'
export interface ExportSource { markdown: string; marp: Marp; baseDir: string }
export interface ExportOptions {
  title?: string
  toAssetUrl?: (absolutePath: string) => string
  /** Optional pre-embedded @font-face rules; every url must be a data URL. */
  fontEmbedCSS?: string
  /** Allows cancellable progress UI without coupling the exporter to App. */
  signal?: AbortSignal
  onProgress?: (completed: number, total: number) => void
}

function checkAbort(signal?: AbortSignal): void { signal?.throwIfAborted() }

/**
 * Offline-safe font imports. Network/CSP failures use the same local font in the
 * measurement and raster surfaces, with substitutions recorded by resolveFonts.
 */
async function fontRules(imports: string[], warnings: string[]): Promise<string> {
  const rules: string[] = []
  for (const entry of imports) {
    const url = /@import\s+(?:url\(\s*)?["']?([^"'\s);]+)/.exec(entry)?.[1]
    if (!url) continue
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (!response.ok) throw new Error('Font stylesheet fetch failed')
      let css = await response.text()
      for (const match of [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)]) {
        const fontResponse = await fetch(new URL(match[1]!, url), { signal: AbortSignal.timeout(4000) })
        if (!fontResponse.ok) throw new Error('Font fetch failed')
        const blob = await fontResponse.blob()
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob)
        })
        css = css.replace(match[0], `url("${data}")`)
      }
      rules.push(css)
    } catch { warnings.push(`Web font stylesheet could not be embedded: ${url}. Local fallback fonts were used.`) }
  }
  return rules.join('\n')
}

export async function measureDeck(source: ExportSource, options: ExportOptions = {}): Promise<{ slides: MeasuredSlide[]; report: ExportReport }> {
  if (source.marp.options.html === true || source.marp.options.script !== false) throw new Error('Export requires Marp with script:false and the default HTML allowlist')
  checkAbort(options.signal)
  const rendered = source.marp.render(source.markdown)
  const split = splitRenderedSlides(rendered.html)
  if (!split.slides.length) throw new Error('Marp did not produce SVG slides')
  const host = document.createElement('div')
  host.dataset.pptxExport = 'true'
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;contain:layout style;'
  const shadow = host.attachShadow({ mode: 'open' })
  const fontStyle = document.createElement('style')
  let handle: MarpCoreBrowser | undefined
  try {
    const toAssetUrl = options.toAssetUrl ?? convertFileSrc
    const styles = splitCssImports(rewriteCssUrls(rendered.css, source.baseDir, toAssetUrl))
    const warnings: string[] = []
    const inlineFontFaces = (styles.css.match(/@font-face\s*\{[^}]+\}/gi) ?? []).filter(rule => [...rule.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].every(match => match[1]!.startsWith('data:'))).join('\n')
    const fontCSS = options.fontEmbedCSS ?? `${inlineFontFaces}\n${await fontRules(styles.imports, warnings)}`
    if ([...fontCSS.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].some(match => !match[1]!.startsWith('data:'))) throw new Error('fontEmbedCSS must contain embedded data URLs only')
    fontStyle.textContent = fontCSS
    document.head.append(fontStyle)
    const themeStyle = document.createElement('style')
    themeStyle.textContent = styles.css
    const geometryStyle = document.createElement('style')
    geometryStyle.textContent = `.marpit{width:${split.width}px;height:${split.height}px}.marpit>svg[data-marpit-svg]{display:block;width:${split.width}px;height:${split.height}px}`
    const content = document.createElement('div')
    content.innerHTML = split.slides.join('')
    shadow.append(themeStyle, geometryStyle, content)
    // Rendering is from Marp's allowlist. Extra safety for a customized renderer.
    if (shadow.querySelector('script,iframe,object,embed') || [...shadow.querySelectorAll('*')].some(el => [...el.attributes].some(attr => /^on/i.test(attr.name)))) throw new Error('Unsafe rendered HTML')
    // Resolve URLs in the exported DOM without modifying the supplied Marp instance or source.
    for (const image of shadow.querySelectorAll<HTMLImageElement>('img[src]')) {
      const absolute = resolveAssetPath(source.baseDir, image.getAttribute('src')!)
      if (absolute) image.src = toAssetUrl(absolute)
    }
    for (const anchor of shadow.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const absolute = resolveAssetPath(source.baseDir, anchor.getAttribute('href')!)
      if (absolute) {
        const normalized = absolute.replace(/\\/g, '/')
        anchor.href = new URL(normalized.startsWith('//') ? `file:${normalized}` : `file:///${normalized}`).href
      }
    }
    for (const element of shadow.querySelectorAll<HTMLElement>('[style]')) element.setAttribute('style', rewriteCssUrls(element.getAttribute('style')!, source.baseDir, toAssetUrl))
    document.body.append(host)
    const { default: browser } = await import('@marp-team/marp-core/browser')
    handle = browser(shadow)
    await inlineImages(shadow, undefined, (element, error) => { element.dataset.pptxAssetError = error instanceof Error ? error.message : String(error) })
    // Explicit loads also cover fonts inside Shadow DOM, which fonts.ready alone can miss.
    const fontLoads = [...shadow.querySelectorAll('h1,h2,h3,h4,h5,h6,marp-h1,marp-h2,marp-h3,marp-h4,marp-h5,marp-h6,p,li,td,th,pre,marp-pre,header,footer')].map(el => {
      const style = getComputedStyle(el)
      return document.fonts.load(`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, el.textContent ?? '').catch(() => { warnings.push(`Font load failed: ${style.fontFamily}`) })
    })
    await Promise.all(fontLoads)
    await document.fonts.ready
    checkAbort(options.signal)
    handle.update()
    // Marp auto-scaling uses ResizeObserver and custom-element SVGs. Let it settle
    // after images/fonts load; a backgrounded window must not wait indefinitely.
    await new Promise<void>(resolve => {
      const timeout = window.setTimeout(resolve, 250)
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timeout); resolve() }))
    })
    // Flush layout before reading coordinates, including Marp's registered custom elements.
    void host.offsetWidth
    const report: ExportReport = { slideCount: split.slides.length, rasterizedCount: 0, rasterizedElements: [], substitutedFonts: [], warnings }
    const fonts = await resolveFonts(shadow, report)
    applyUnavailableFontFallbacks(shadow, fonts, fontCSS)
    const slides: MeasuredSlide[] = []
    const backgrounds = new Map<string, Promise<string>>()
    for (const [index, svg] of [...shadow.querySelectorAll<SVGSVGElement>('svg[data-marpit-svg]')].entries()) {
      checkAbort(options.signal)
      try {
        slides.push(await measureSlide(svg, rendered.comments[index] ?? [], fonts, fontCSS, report, index, backgrounds))
      } catch (error) {
        const slide: MeasuredSlide = { width: split.width, height: split.height, background: 'FFFFFF', parts: [], notes: rendered.comments[index] ?? [] }
        const reason = `Slide measurement failed: ${error instanceof Error ? error.message : String(error)}`
        try {
          const failed = svg.querySelector<HTMLElement>('[data-pptx-asset-error]')
          if (failed) throw new Error(failed.dataset.pptxAssetError)
          slide.parts.push({ kind: 'image', rect: { x: 0, y: 0, width: split.width, height: split.height }, data: await rasterize(svg as unknown as HTMLElement, fontCSS) })
          report.rasterizedElements.push({ slide: index + 1, element: 'svg', reason })
        } catch (rasterError) { reportElementError(report, index + 1, 'svg', `${reason}; rasterization failed: ${rasterError instanceof Error ? rasterError.message : String(rasterError)}`) }
        slides.push(slide)
      }
      options.onProgress?.(index + 1, split.slides.length)
    }
    report.rasterizedCount = report.rasterizedElements.length
    return { slides, report }
  } finally { handle?.cleanup(); host.remove(); fontStyle.remove() }
}

export async function exportPptx(source: ExportSource, options: ExportOptions = {}): Promise<{ bytes: Uint8Array; report: ExportReport }> {
  const { slides, report } = await measureDeck(source, options)
  checkAbort(options.signal)
  const bytes = await generatePptx(slides, options.title)
  checkAbort(options.signal)
  return { bytes, report }
}

/** Default save dialog path without rewriting the Markdown file. */
export function defaultPptxPath(markdownPath: string): string {
  return /\.(md|markdown)$/i.test(markdownPath) ? markdownPath.replace(/\.(md|markdown)$/i, '.pptx') : `${markdownPath}.pptx`
}
