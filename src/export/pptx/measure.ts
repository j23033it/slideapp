import type PptxGenJS from 'pptxgenjs'
import { cssColor, type ExportReport, type MeasuredSlide, type Paragraph, type Part, type Rect, type RunStyle, type TableCell, type TextRun } from './model'
import { rasterize, rasterBounds } from './raster'
import { cellAlignment, pseudoNeedsRaster, rasterReason, type ElementFacts, type PseudoFacts } from './classify'

const px = (value: string) => Number.parseFloat(value) || 0
const BLOCKS = 'h1,h2,h3,h4,h5,h6,marp-h1,marp-h2,marp-h3,marp-h4,marp-h5,marp-h6,p,li,pre,marp-pre,blockquote,header,footer'
const MATH = 'svg,mjx-container,.katex,.MathJax,marp-auto-scaling'
const visible = (element: Element) => {
  const style = getComputedStyle(element), rect = element.getBoundingClientRect()
  return style.display !== 'none' && rect.width > 0 && rect.height > 0
}
function textScale(element: Element): number {
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    const svg = ancestor.shadowRoot?.querySelector<SVGSVGElement>('svg[data-marp-auto-scaling-svg]') ?? ancestor.shadowRoot?.querySelector('marp-auto-scaling')?.shadowRoot?.querySelector<SVGSVGElement>('svg[data-marp-auto-scaling-svg]')
    const matrix = svg?.getScreenCTM()
    if (matrix) return Math.hypot(matrix.a, matrix.b)
  }
  return 1
}
export function relativeRect(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, origin: Pick<DOMRect, 'left' | 'top'>): Rect {
  return { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height }
}

function richStyle(element: Element, fonts: Map<string, string>): RunStyle {
  const style = getComputedStyle(element)
  const scale = textScale(element)
  let decoration = style.textDecorationLine
  for (let ancestor = element.parentElement; ancestor && ancestor.tagName !== 'SECTION'; ancestor = ancestor.parentElement) decoration += ` ${getComputedStyle(ancestor).textDecorationLine}`
  const href = element.closest('a[href]')?.getAttribute('href')
  const hyperlink = href && /^(https?:|mailto:|file:|tel:)/i.test(href) ? href : undefined
  let hyperlinkSlide: number | undefined
  if (href?.startsWith('#')) {
    const root = element.getRootNode() as Document | ShadowRoot
    let id = href.slice(1)
    try { id = decodeURIComponent(id) } catch { /* Keep the literal anchor. */ }
    const target = root.getElementById(id) ?? root.getElementById(href.slice(1))
    const targetSvg = target?.closest('svg[data-marpit-svg]')
    const index = targetSvg ? [...root.querySelectorAll('svg[data-marpit-svg]')].indexOf(targetSvg) : -1
    if (index >= 0) hyperlinkSlide = index + 1
  }
  return {
    fontFace: fonts.get(style.fontFamily) ?? 'Yu Gothic', fontSize: px(style.fontSize) * scale,
    color: cssColor(style.color).color, transparency: cssColor(style.color).transparency, bold: Number(style.fontWeight) >= 600 || style.fontWeight === 'bold',
    italic: style.fontStyle === 'italic' || style.fontStyle === 'oblique',
    underline: decoration.includes('underline'), strike: decoration.includes('line-through'),
    letterSpacing: px(style.letterSpacing) * scale, hyperlink, hyperlinkSlide,
    superscript: style.verticalAlign === 'super', subscript: style.verticalAlign === 'sub',
  }
}

/** Excludes child lists so a parent's text and nested bullets are emitted exactly once. */
export function collectRuns(element: Element, fonts: Map<string, string>, ownListItem = false): TextRun[] {
  const runs: TextRun[] = []
  const preserve = getComputedStyle(element).whiteSpace.startsWith('pre')
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
      if (['hidden', 'collapse'].includes(getComputedStyle(node.parentElement).visibility)) return
      let text = node.textContent ?? ''
      if (!preserve) text = text.replace(/[\t\n\r ]+/g, ' ')
      if (text) runs.push({ text, style: richStyle(node.parentElement, fonts) })
    } else if (node instanceof Element) {
      if (getComputedStyle(node).display === 'none') return
      if (ownListItem && node !== element && node.matches('ul,ol,li')) return
      if (node.matches('img,svg,mjx-container')) return
      if (node.tagName === 'BR' && !['hidden', 'collapse'].includes(getComputedStyle(node).visibility)) { runs.push({ text: '\n', style: richStyle(node.parentElement!, fonts) }); return }
      for (const child of node.childNodes) walk(child)
    }
  }
  walk(element)
  if (!preserve) {
    while (runs[0] && !(runs[0].text = runs[0].text.trimStart())) runs.shift()
    while (runs.at(-1) && !(runs.at(-1)!.text = runs.at(-1)!.text.trimEnd())) runs.pop()
  }
  return runs.filter(r => r.text !== '')
}

function listInfo(element: HTMLElement): Paragraph['list'] {
  const li = element.matches('li') ? element : element.parentElement?.matches('li') && element === element.parentElement.firstElementChild ? element.parentElement : null
  const list = li?.parentElement
  if (!li || !list?.matches('ul,ol')) return undefined
  let level = -1
  for (let ancestor: Element | null = list; ancestor; ancestor = ancestor.parentElement) if (ancestor.matches('ul,ol')) level++
  const items = [...list.children].filter(el => el.tagName === 'LI')
  let number = list instanceof HTMLOListElement ? list.start : 1
  for (const item of items) {
    if (item.hasAttribute('value')) number = Number(item.getAttribute('value'))
    if (item === li) break
    number++
  }
  const style = getComputedStyle(li), type = style.listStyleType
  const context = document.createElement('canvas').getContext('2d')
  if (context) context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  // CSS outside decimal markers include the period and a space. Reserve the actual
  // glyph advance instead of a fixed .8em, which made Office's marker touch text.
  const marker = type === 'decimal' ? `${number}. ` : type === 'decimal-leading-zero' ? `${String(number).padStart(2, '0')}. ` : ''
  const indent = marker && context ? context.measureText(marker).width : px(style.fontSize) * .8
  return { level, type, start: number, indent }
}

function paragraph(element: HTMLElement, origin: DOMRect, fonts: Map<string, string>, rect = element.getBoundingClientRect()): Paragraph {
  const style = getComputedStyle(element)
  const align = style.textAlign === 'start' ? 'left' : style.textAlign === 'end' ? 'right' : style.textAlign
  const lineHeight = (style.lineHeight === 'normal' ? px(style.fontSize) * 1.2 : px(style.lineHeight)) * textScale(element)
  return {
    rect: relativeRect(rect, origin), runs: collectRuns(element, fonts, element.tagName === 'LI'),
    align: ['left', 'center', 'right', 'justify'].includes(align) ? align as Paragraph['align'] : 'left',
    lineHeight, spaceBefore: 0, spaceAfter: 0,
    // External margins are already present in the absolute DOM coordinates.
    padding: [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)],
    fill: cssColor(style.backgroundColor), list: listInfo(element),
  }
}

function hasEffects(style: CSSStyleDeclaration): boolean {
  return [style.transform, style.filter, style.textShadow, style.boxShadow].some(value => !!value && value !== 'none') || (!!style.opacity && style.opacity !== '1')
}
function pseudoFacts(element: Element, pseudo: string): PseudoFacts {
  const style = getComputedStyle(element, pseudo)
  return { content: style.content, display: style.display, visibility: style.visibility,
    background: cssColor(style.backgroundColor).transparency < 100 || style.backgroundImage !== 'none',
    border: ['top', 'right', 'bottom', 'left'].some(side => px(style.getPropertyValue(`border-${side}-width`)) > 0),
    effects: hasEffects(style), sized: px(style.width) > 0 || px(style.height) > 0 }
}
function complexReason(element: Element): string | undefined {
  const kind = element.matches('section') ? 'section' : element.matches('table') ? 'table' : element.matches('ul,ol') ? 'list' : 'text'
  const facts: ElementFacts = { kind }
  const nodes = kind === 'section' ? [element] : [element, ...element.querySelectorAll('*')]
  for (const el of nodes) {
    const style = getComputedStyle(el)
    if (style.display === 'none' || el.closest('[hidden]')) continue
    if (style.visibility === 'hidden') { facts.hiddenLayout = true; continue }
    facts.effects ||= hasEffects(style)
    facts.pseudo ||= ['::before', '::after'].some(pseudo => pseudoNeedsRaster(pseudoFacts(el, pseudo), kind === 'section'))
    if (kind === 'section') continue
    facts.math ||= el.matches(MATH)
    facts.emoji ||= [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && /\p{Extended_Pictographic}/u.test(node.textContent ?? ''))
    facts.background ||= style.backgroundImage !== 'none' || style.backgroundClip === 'text'
    facts.verticalText ||= !!style.writingMode && style.writingMode !== 'horizontal-tb'
    facts.rounded ||= px(style.borderRadius) > 0
    facts.customMarker ||= style.listStyleImage !== 'none' || (el.matches('ol') && el.hasAttribute('reversed'))
    const inline = el !== element && (style.display === 'inline' || style.display === 'inline-block')
    facts.inlineDecoration ||= inline && (cssColor(style.backgroundColor).transparency < 100 ||
      ['top', 'right', 'bottom', 'left'].some(side => px(style.getPropertyValue(`padding-${side}`)) > 0 || px(style.getPropertyValue(`border-${side}-width`)) > 0))
    const hasText = [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
    facts.textTransform ||= hasText && !!style.textTransform && style.textTransform !== 'none'
    facts.image ||= el.matches('img')
  }
  if (kind === 'list') facts.complexList = [...element.querySelectorAll('li > *')].some(el => !el.matches('p,ul,ol') && !['inline', 'inline-block'].includes(getComputedStyle(el).display)) || !!element.querySelector('table,pre,marp-pre,blockquote')
  if (kind === 'table') {
    const cells = [...(element as HTMLTableElement).rows].flatMap(row => [...row.cells])
    facts.mergedCells = cells.some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)
    facts.unsupportedCellAlignment = cells.some(cell => !cellAlignment(getComputedStyle(cell).verticalAlign))
  }
  return rasterReason(facts)
}

function ownTextRect(element: HTMLElement): DOMRect {
  const nodes = [...element.childNodes].filter(node => !(node instanceof Element && node.matches('ul,ol')))
  const rectangles = nodes.flatMap(node => {
    const range = document.createRange(); range.selectNodeContents(node)
    return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
  })
  if (!rectangles.length) return element.getBoundingClientRect()
  const left = Math.min(...rectangles.map(r => r.left)), top = Math.min(...rectangles.map(r => r.top))
  return new DOMRect(left, top, Math.max(...rectangles.map(r => r.right)) - left, Math.max(...rectangles.map(r => r.bottom)) - top)
}

export function measureTable(table: HTMLTableElement, origin: DOMRect, fonts: Map<string, string>): Extract<Part, { kind: 'table' }> {
  const rows = [...table.rows]
  const result: TableCell[][] = rows.map(row => [...row.cells].map(cell => {
    const style = getComputedStyle(cell)
    const borders = ['Top', 'Right', 'Bottom', 'Left'].map(side => {
      const color = cssColor(style.getPropertyValue(`border-${side.toLowerCase()}-color`))
      const width = px(style.getPropertyValue(`border-${side.toLowerCase()}-width`))
      return { type: color.transparency === 100 || width === 0 ? 'none' : 'solid', color: color.color, pt: width * .75 } as PptxGenJS.BorderProps
    }) as TableCell['border']
    let fill = cssColor(style.backgroundColor)
    if (fill.transparency === 100) fill = cssColor(getComputedStyle(row).backgroundColor)
    return { runs: collectRuns(cell, fonts), style: paragraph(cell, origin, fonts), fill, border: borders, valign: cellAlignment(style.verticalAlign) ?? 'top' }
  }))
  const columnWidths = [...rows[0]!.cells].map((cell, column) => Math.max(cell.getBoundingClientRect().width,
    ...rows.map((row, index) => {
      const measured = result[index]![column]!
      // Keep the browser's existing wraps, reserving space for Office's glyph metrics.
      const reserve = Math.max(3, ...measured.runs.map(run => run.style.fontSize * .2))
      return ownTextRect(row.cells[column]!).width + measured.style.padding[1] + measured.style.padding[3] + reserve + 2
    })))
  return { kind: 'table', rect: { ...relativeRect(table.getBoundingClientRect(), origin), width: columnWidths.reduce((sum, width) => sum + width, 0) }, rows: result,
    columnWidths, rowHeights: rows.map(row => row.getBoundingClientRect().height) }
}

/** A whole list shares one available width; nested items only change paragraph indentation. */
export function measureList(list: HTMLElement, origin: DOMRect, fonts: Map<string, string>): Extract<Part, { kind: 'list' }> {
  const paragraphs: Paragraph[] = []
  for (const li of list.querySelectorAll<HTMLElement>('li')) {
    if (getComputedStyle(li).display === 'none') continue
    const blocks = [...li.querySelectorAll<HTMLElement>(':scope > p')]
    for (const [index, block] of (blocks.length ? blocks : [li]).entries()) {
      if (getComputedStyle(block).display === 'none' || getComputedStyle(block).visibility === 'hidden') continue
      const p = paragraph(block, origin, fonts, ownTextRect(block))
      p.padding = [0, 0, 0, 0]
      if (index > 0) p.list = undefined
      if (p.runs.length) paragraphs.push(p)
    }
  }
  // Loose lists can have continuation paragraphs after a nested list.
  paragraphs.sort((a, b) => a.rect.y - b.rect.y)
  for (let index = 0; index < paragraphs.length - 1; index++) {
    const p = paragraphs[index]!, next = paragraphs[index + 1]!
    const lines = Math.max(1, Math.round(p.rect.height / p.lineHeight))
    p.spaceAfter = Math.max(0, next.rect.y - p.rect.y - lines * p.lineHeight)
  }
  const rect = relativeRect(list.getBoundingClientRect(), origin)
  const first = paragraphs[0], last = paragraphs.at(-1)
  if (first && last) {
    rect.y = first.rect.y
    rect.height = last.rect.y + Math.max(last.rect.height, last.lineHeight) - first.rect.y
  }
  return { kind: 'list', rect, paragraphs }
}

function pseudoText(section: HTMLElement, pseudo: string): HTMLElement | null {
  const style = getComputedStyle(section, pseudo)
  if (style.display === 'none' || style.visibility === 'hidden') return null
  let content = style.content
  if (!content || ['none', 'normal', '""', "''"].includes(content)) return null
  content = content.replace(/attr\(([^)]+)\)/g, (_, attr: string) => JSON.stringify(section.getAttribute(attr) ?? ''))
  const pieces = [...content.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)]
  if (!pieces.length) return null
  const span = document.createElement('span')
  span.textContent = pieces.map(m => (m[1] ?? m[2] ?? '').replace(/\\(["'\\])/g, '$1')).join('')
  for (const key of style) span.style.setProperty(key, style.getPropertyValue(key))
  span.style.content = 'normal'
  section.append(span)
  return span
}

export async function measureSlide(svg: SVGSVGElement, notes: string[], fonts: Map<string, string>, fontCSS: string, report: ExportReport, slideIndex: number, backgrounds = new Map<string, Promise<string>>()): Promise<MeasuredSlide> {
  const origin = svg.getBoundingClientRect(), viewBox = svg.viewBox.baseVal
  if (Math.abs(origin.width - viewBox.width) > .1 || Math.abs(origin.height - viewBox.height) > .1) throw new Error('Export surface must be rendered at 1:1 scale')
  const parts: Part[] = []
  const sections = [...svg.querySelectorAll<HTMLElement>('foreignObject > section')]
  let background = 'FFFFFF'
  const fallback = async (el: HTMLElement, reason: string) => {
    parts.push({ kind: 'image', rect: relativeRect(rasterBounds(el), origin), data: await rasterize(el, fontCSS, undefined, false, svg) })
    report.rasterizedElements.push({ slide: slideIndex + 1, element: el.tagName.toLowerCase(), reason })
  }
  // Keep ancestor effects and generated decoration in the slide's compositing context.
  const generatedDecoration = sections.some(section => [section, ...section.querySelectorAll('*')].some(element =>
    getComputedStyle(element).display !== 'none' && ['::before', '::after'].some(pseudo => pseudoNeedsRaster(pseudoFacts(element, pseudo), element === section))))
  const sectionReason = sections.map(section => complexReason(section)).find(Boolean) ?? (generatedDecoration ? 'CSS pseudo-element decoration' : undefined)
  if (sectionReason) {
    await fallback(svg as unknown as HTMLElement, `Slide: ${sectionReason}`)
    return { width: viewBox.width, height: viewBox.height, background, parts, notes }
  }
  for (const section of sections) {
    const style = getComputedStyle(section)
    const color = cssColor(style.backgroundColor)
    if (color.transparency === 0) background = color.color
    if (section.dataset.marpitAdvancedBackground === 'background' || style.backgroundImage !== 'none') {
      // Only a leaf-free CSS background has a content-independent appearance.
      const cacheable = section.dataset.marpitAdvancedBackground !== 'background'
      const key = JSON.stringify([fontCSS, ...[...style].map(property => [property, style.getPropertyValue(property)])])
      if (!cacheable || !backgrounds.has(key)) {
        const image = rasterize(section, fontCSS, node => !(node instanceof Element) || !node.matches(`${BLOCKS},ul,ol,table`), true)
        if (cacheable) backgrounds.set(key, image)
        else parts.push({ kind: 'image', rect: relativeRect(section.getBoundingClientRect(), origin), data: await image })
      }
      if (cacheable) parts.push({ kind: 'image', rect: relativeRect(section.getBoundingClientRect(), origin), data: await backgrounds.get(key)! })
      if (style.backgroundImage.includes('gradient(')) report.rasterizedElements.push({ slide: slideIndex + 1, element: 'section', reason: 'CSS gradient background' })
    }
  }
  const walk = async (element: HTMLElement): Promise<void> => {
    if (!visible(element)) return
    if (element.matches('ul,ol')) {
      const reason = complexReason(element)
      if (reason) await fallback(element, reason)
      else {
        const list = measureList(element, origin, fonts)
        if (list.paragraphs.length) parts.push(list)
      }
      return
    }
    if (element.matches('table')) {
      const table = element as HTMLTableElement
      const reason = complexReason(element)
      if (reason) await fallback(element, reason)
      else parts.push(measureTable(table, origin, fonts))
      return
    }
    if (element.matches('img')) {
      parts.push({ kind: 'image', rect: relativeRect(rasterBounds(element), origin), data: await rasterize(element, fontCSS) })
      if (element.dataset.pptxRasterReason) report.rasterizedElements.push({ slide: slideIndex + 1, element: 'img', reason: element.dataset.pptxRasterReason })
      return
    }
    if (element.matches(BLOCKS)) {
      const reason = complexReason(element)
      if (reason) { await fallback(element, reason); return }
      const children = [...element.children] as HTMLElement[]
      const rect = relativeRect(element.getBoundingClientRect(), origin)
      const style = getComputedStyle(element)
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const thickness = px(style.getPropertyValue(`border-${side}-width`))
        const borderStyle = style.getPropertyValue(`border-${side}-style`)
        const color = cssColor(style.getPropertyValue(`border-${side}-color`))
        if (thickness <= 0 || borderStyle === 'none' || color.transparency === 100) continue
        const vertical = side === 'left' || side === 'right'
        parts.push({ kind: 'line', x: rect.x + (side === 'right' ? rect.width - thickness / 2 : vertical ? thickness / 2 : 0),
          y: rect.y + (side === 'bottom' ? rect.height - thickness / 2 : vertical ? 0 : thickness / 2),
          width: vertical ? 0 : rect.width, height: vertical ? rect.height : 0, color: color.color, points: thickness * .75 })
      }
      if (element.matches('blockquote') || (element.matches('li') && children.some(c => c.matches('p')))) {
        const fill = cssColor(style.backgroundColor)
        if (fill.transparency < 100) parts.push({ kind: 'box', rect, fill })
        for (const child of children) await walk(child)
        return
      }
      const scaled = Math.abs(textScale(element) - 1) > .001
      const textRect = element.matches('li') || scaled ? ownTextRect(element) : element.getBoundingClientRect()
      const p = paragraph(element, origin, fonts, textRect)
      if (scaled || element.matches('li')) p.padding = [0, 0, 0, 0]
      // Marp has already fitted a single line. Office's slightly wider glyphs
      // must not introduce another line after that fit was measured.
      if (scaled && p.rect.height < p.lineHeight * 1.5 && !p.runs.some(run => run.text.includes('\n'))) p.wrap = false
      if (p.runs.length && p.rect.width > 0 && p.rect.height > 0) parts.push({ kind: 'text', paragraph: p })
      for (const child of element.querySelectorAll<HTMLElement>(':scope > ul,:scope > ol,:scope > img')) await walk(child)
      // Images can be nested inside links or emphasis.
      for (const image of element.querySelectorAll<HTMLElement>('a > img,em > img,strong > img')) await walk(image)
      return
    }
    if (element.matches(MATH) || element.namespaceURI === 'http://www.w3.org/2000/svg') { await fallback(element, 'Math or SVG'); return }
    for (const child of element.children) await walk(child as HTMLElement)
  }
  for (const section of sections) {
    if (section.dataset.marpitAdvancedBackground === 'background') continue
    for (const child of [...section.children]) await walk(child as HTMLElement)
    for (const pseudo of ['::before', '::after']) {
      const span = pseudoText(section, pseudo)
      if (span) {
        try { const p = paragraph(span, origin, fonts); if (p.runs.length && p.rect.width > 0 && p.rect.height > 0) parts.push({ kind: 'text', paragraph: p }) }
        finally { span.remove() }
      }
    }
  }
  return { width: viewBox.width, height: viewBox.height, background, parts, notes }
}
