import { Marp } from '@marp-team/marp-core'
import browser from '@marp-team/marp-core/browser'
import { toSvg } from 'html-to-image'
import { exportPptx, measureDeck } from './index'
import { generatePptx } from './generate'
import { convertFileSrc } from '@tauri-apps/api/core'
import { splitRenderedSlides } from '../../marp/renderer'
import { rewriteCssUrls, resolveAssetPath } from '../../marp/urls'
import { loadImage } from './raster'
import type { Part } from './model'

/** Pixel regression for unsupported content, independent of its measured-model assertions. */
export async function compareRasterForCDP(reference: string, parts: Part[]) {
  const original = await loadImage(reference)
  const canvas = document.createElement('canvas')
  canvas.width = original.width; canvas.height = original.height
  const context = canvas.getContext('2d')!
  context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(original, 0, 0)
  const expected = context.getImageData(0, 0, canvas.width, canvas.height).data
  const results = []
  for (const part of parts) {
    if (part.kind !== 'image') continue
    context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(await loadImage(part.data), part.rect.x, part.rect.y, part.rect.width, part.rect.height)
    const actual = context.getImageData(0, 0, canvas.width, canvas.height).data
    let ink = 0, different = 0
    for (let y = Math.max(0, Math.floor(part.rect.y)); y < Math.min(canvas.height, Math.ceil(part.rect.y + part.rect.height)); y++) {
      for (let x = Math.max(0, Math.floor(part.rect.x)); x < Math.min(canvas.width, Math.ceil(part.rect.x + part.rect.width)); x++) {
        const offset = (y * canvas.width + x) * 4
        const a = [actual[offset]!, actual[offset + 1]!, actual[offset + 2]!], e = [expected[offset]!, expected[offset + 1]!, expected[offset + 2]!]
        const actualInk = Math.min(...a) < 220, expectedInk = Math.min(...e) < 220
        if (!actualInk && !expectedInk) continue
        ink++
        // Symmetric foreground matching detects missing and added paint. Allow
        // two pixels and LCD/grayscale antialias differences around glyph edges.
        const matches = (color: number[], pixels: Uint8ClampedArray) => {
          for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
            if (x + dx < 0 || x + dx >= canvas.width || y + dy < 0 || y + dy >= canvas.height) continue
            const neighbor = ((y + dy) * canvas.width + x + dx) * 4
            const candidate = [pixels[neighbor]!, pixels[neighbor + 1]!, pixels[neighbor + 2]!]
            const luminance = (c: number[]) => c[0]! * .2126 + c[1]! * .7152 + c[2]! * .0722
            const antialias = Math.min(Math.max(...color) - Math.min(...color), Math.max(...candidate) - Math.min(...candidate)) < 40 && Math.abs(luminance(color) - luminance(candidate)) < 96
            if (Math.min(...candidate) < 220 && (antialias || Math.max(...color.map((value, i) => Math.abs(value - candidate[i]!))) <= 96)) return true
          }
          return false
        }
        if ((expectedInk && !matches(e, actual)) || (actualInk && !matches(a, expected))) different++
      }
    }
    results.push({ rect: part.rect, ink, different, ratio: different / Math.max(1, ink) })
  }
  return results
}

let previewCleanup: (() => void) | undefined
/** Visible 1:1 Marp surface for actual WebView2 screenshots, with no app UI changes. */
export async function showFixtureForCDP(markdown: string, baseDir: string, index: number) {
  previewCleanup?.()
  const marp = new Marp({ script: false, math: 'mathjax' })
  marp.themeSet.add('/* @theme export-custom */\n@import "default"; section { width:1000px; height:600px; font-family:"Yu Gothic"; font-size:30px; padding:60px; }')
  const rendered = marp.render(markdown), deck = splitRenderedSlides(rendered.html)
  const host = document.createElement('div')
  host.style.cssText = `position:fixed;left:0;top:0;width:${deck.width}px;height:${deck.height}px;z-index:2147483647;background:white;`
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>${rewriteCssUrls(rendered.css, baseDir, convertFileSrc)}\n.marpit{width:${deck.width}px;height:${deck.height}px}.marpit>svg{display:block;width:100%;height:100%}</style>${deck.slides[index]}`
  for (const image of root.querySelectorAll<HTMLImageElement>('img[src]')) {
    const absolute = resolveAssetPath(baseDir, image.getAttribute('src')!)
    if (absolute) image.src = convertFileSrc(absolute)
  }
  for (const element of root.querySelectorAll<HTMLElement>('[style]')) element.setAttribute('style', rewriteCssUrls(element.getAttribute('style')!, baseDir, convertFileSrc))
  document.body.append(host)
  const handle = browser(root)
  previewCleanup = () => { handle.cleanup(); host.remove() }
  // Keep the visible reference independent of export asset inlining.
  await Promise.all([...root.querySelectorAll('img')].map(image => image.decode()))
  await document.fonts.ready
  handle.update()
  await new Promise(resolve => setTimeout(resolve, 300))
  const heading = root.querySelector('h1,marp-h1')?.getBoundingClientRect()
  return { width: deck.width, height: deck.height, heading: heading?.toJSON() }
}

export function hideFixtureForCDP() { previewCleanup?.(); previewCleanup = undefined }

const fixtures = import.meta.glob('../../../tests/fixtures/export/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
export async function exportFixtureForCDP(markdown: string, baseDir: string, fontEmbedCSS?: string) {
  const marp = new Marp({ script: false, math: 'mathjax' })
  marp.themeSet.add('/* @theme export-custom */\n@import "default"; section { width:1000px; height:600px; font-family:"Yu Gothic"; font-size:30px; padding:60px; }')
  let scaling: unknown[] = []
  const measured = await measureDeck({ markdown, marp, baseDir }, { fontEmbedCSS, onProgress: () => {
    const root = document.querySelector<HTMLElement>('[data-pptx-export]')?.shadowRoot
    scaling = [...root?.querySelectorAll<HTMLElement>('[data-auto-scaling]') ?? []].map(element => {
      const autoscaling = element.shadowRoot?.querySelector('marp-auto-scaling')
      const svg = autoscaling?.shadowRoot?.querySelector('svg')
      return { tag: element.tagName, html: element.shadowRoot?.innerHTML, svg: svg?.outerHTML, matrix: svg?.getScreenCTM()?.toString() }
    })
  } })
  const bytes = await generatePptx(measured.slides)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return { base64: btoa(binary), ...measured, scaling }
}
export async function exportFixtures() {
  const info = await fetch('/__export_info').then(response => response.json()) as { baseDir: string; outputDir: string }
  const results = []
  for (const [path, markdown] of Object.entries(fixtures)) {
    const name = path.split('/').at(-1)!.slice(0, -3)
    const marp = new Marp({ script: false, math: 'mathjax' })
    marp.themeSet.add('/* @theme export-custom */\n@import "default"; section { width:1000px; height:600px; font-family:"Yu Gothic"; font-size:30px; padding:60px; }')
    const source = { markdown, marp, baseDir: info.baseDir }
    const options = { toAssetUrl: (absolute: string) => `/@fs/${absolute.replace(/\\/g, '/')}` }
    const { bytes, report } = await exportPptx(source, options)
    const measured = await measureDeck(source, options)
    for (const [extension, body] of [['pptx', new Blob([new Uint8Array(bytes)])], ['json', JSON.stringify({ report, slides: measured.slides })]] as const) {
      const response = await fetch(`/__export_artifact?name=${name}.${extension}`, { method: 'POST', body })
      if (!response.ok) throw new Error(await response.text())
    }
    results.push({ name, bytes: bytes.length, report })
    Reflect.set(window, 'exportProgress', results)
  }
  return { outputDir: info.outputDir, results }
}

/** Development-only entry point. Import from the Vite console; no application UI changes. */
export async function probeRasterization(theme = 'default', fontEmbedCSS = '') {
  const host = document.createElement('div')
  document.body.append(host)
  const shadow = host.attachShadow({ mode: 'open' })
  const fonts = document.createElement('style')
  fonts.textContent = fontEmbedCSS
  document.head.append(fonts)
  const marp = new Marp({ script: false, math: 'mathjax' })
  const rendered = marp.render(`---\nmarp: true\ntheme: ${theme}\n---\n# 日本語 Test\n\n$$E=mc^2$$`)
  shadow.innerHTML = `<style>${rendered.css}</style>${rendered.html}`
  if (fontEmbedCSS) shadow.querySelector<HTMLElement>('h1')!.style.fontFamily = 'SlideAppProbeWebFont'
  const handle = browser(shadow)
  await document.fonts.ready
  try {
    const element = shadow.querySelector<HTMLElement>('h1')!
    const png = await toSvg(element, { fontEmbedCSS })
    const image = new Image()
    image.src = png
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.width * 2; canvas.height = image.height * 2
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    return { theme, width: canvas.width, height: canvas.height, nonTransparent: pixels.filter((_, i) => i % 4 === 3 && pixels[i]! > 0).length, pngBytes: atob(canvas.toDataURL('image/png').split(',')[1]!).length }
  } finally { handle.cleanup(); host.remove(); fonts.remove() }
}
