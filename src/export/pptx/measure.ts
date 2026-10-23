import type PptxGenJS from 'pptxgenjs'
import { reportElementError, validatePart, cssColor, type ExportReport, type MeasuredSlide, type Paragraph, type Part, type Rect, type RunStyle, type TableCell, type TextRun } from './model'
import { rasterize, rasterBounds, rasterizePseudo, rasterizeBackground } from './raster'
import { cellAlignment, pseudoNeedsRaster, rasterReason, type ElementFacts, type PseudoFacts } from './classify'
import { isPainted, paintedState } from './visibility'
import { nativeStyleReason, pixels, styleApproximations, nativeLetterSpacing, borderColor } from './styles'

import { separateBox as separateBackground, rasterBox, nativeBox } from './paint'
import { layoutPaintReason, clipsContent, textPseudoReason } from './cssAudit'
import { measureMarker } from './markers'
import { measureSvg } from './svg'

const px = pixels
const BLOCKS = 'h1,h2,h3,h4,h5,h6,marp-h1,marp-h2,marp-h3,marp-h4,marp-h5,marp-h6,p,li,pre,marp-pre,blockquote,header,footer'
const MATH = 'svg,mjx-container,.katex,.MathJax,marp-auto-scaling'
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

function resolvedFont(family: string, fonts: Map<string, string>): string {
  const font = fonts.get(family)
  if (!font) throw new Error(`Unresolved font family: ${family}`)
  return font
}
function paragraphAlignment(value: string): Paragraph['align'] {
  if (value === 'start') return 'left'
  if (value === 'end') return 'right'
  if (value === 'left' || value === 'center' || value === 'right' || value === 'justify') return value
  throw new Error(`Unsupported CSS text-align: ${value}`)
}
function requiredCellAlignment(value: string): NonNullable<TableCell['valign']> {
  const alignment = cellAlignment(value)
  if (!alignment) throw new Error(`Unsupported CSS vertical-align: ${value}`)
  return alignment
}

export function tableShapeReason(table: HTMLTableElement): string | undefined {
  const tableStyle = getComputedStyle(table)
  if (tableStyle.borderCollapse === 'separate' && tableStyle.borderSpacing.split(/\s+/).some(n => Number.parseFloat(n) > 0)) return `CSS border-spacing: ${tableStyle.borderSpacing}`
  if ([...table.querySelectorAll('caption')].some(el => isPainted(el))) return 'Table caption layout'
  const rows = [...table.rows], columns = rows[0]?.cells.length ?? 0
  if (!rows.length || !columns) return 'Empty table grid'
  if ([...table.querySelectorAll('col,colgroup')].some(el => {
    const style = getComputedStyle(el)
    return paintedState(el).subtreeHidden || ['hidden', 'collapse'].includes(style.visibility) || style.width === '0px'
  })) return 'Hidden table column'
  for (const row of rows) {
    if (!isPainted(row)) return 'Hidden table row'
    if (row.cells.length !== columns) return 'Nonrectangular table grid'
    for (const [index, cell] of [...row.cells].entries()) {
      if (!isPainted(cell)) return 'Hidden table cell'
      if (cell.colSpan !== 1 || cell.rowSpan !== 1) return 'Merged table cells'
      const rect = cell.getBoundingClientRect(), first = rows[0]!.cells[index]!.getBoundingClientRect()
      if (Math.abs(rect.left - first.left) > .5 || Math.abs(rect.width - first.width) > .5) return 'Table grid differs from rendered columns'
    }
  }
  return undefined
}

function richStyle(element: Element, fonts: Map<string, string>): RunStyle {
  const style = getComputedStyle(element)
  const unsupported = nativeStyleReason(style, element.matches('td,th') ? 'cell' : 'text', separateBackground(element))
  if (unsupported) throw new Error(unsupported)
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
    fontFace: resolvedFont(style.fontFamily, fonts), fontSize: px(style.fontSize) * scale,
    color: cssColor(style.color).color, transparency: cssColor(style.color).transparency, bold: ['600', '700', 'bold'].includes(style.fontWeight),
    italic: style.fontStyle === 'italic',
    underline: decoration.includes('underline'), strike: decoration.includes('line-through'),
    letterSpacing: nativeLetterSpacing(style) * scale, hyperlink, hyperlinkSlide,
    superscript: style.verticalAlign === 'super', subscript: style.verticalAlign === 'sub',
  }
}

/** Excludes child lists so a parent's text and nested bullets are emitted exactly once. */
export function collectRuns(element: Element, fonts: Map<string, string>, ownListItem = false, nodes?: Node[]): TextRun[] {
  const runs: TextRun[] = []
  const preserve = getComputedStyle(element).whiteSpace.startsWith('pre')
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
      if (!isPainted(node.parentElement)) return
      let text = node.textContent ?? ''
      if (!preserve) text = text.replace(/[\t\n\r ]+/g, ' ')
      if (text) runs.push({ text, style: richStyle(node.parentElement, fonts) })
    } else if (node instanceof Element) {
      if (paintedState(node).subtreeHidden) return
      if (ownListItem && node !== element && node.matches('ul,ol,li')) return
      if (node.matches('img,svg,mjx-container')) return
      if (node.tagName === 'BR' && isPainted(node)) { runs.push({ text: '\n', style: richStyle(node.parentElement!, fonts) }); return }
      for (const child of node.childNodes) walk(child)
    }
  }
  if (nodes) nodes.forEach(walk)
  else walk(element)
  if (!preserve) {
    let lineStart = true
    for (const [index, run] of runs.entries()) {
      if (run.text === '\n') {
        if (index) runs[index - 1]!.text = runs[index - 1]!.text.replace(/ +$/, '')
        lineStart = true
      } else {
        if (lineStart) run.text = run.text.replace(/^ +/, '')
        if (run.text) lineStart = false
      }
    }
    if (runs.at(-1)) runs.at(-1)!.text = runs.at(-1)!.text.replace(/ +$/, '')
  }
  return runs.filter(r => r.text !== '')
}

function listInfo(element: HTMLElement, fonts: Map<string, string>): Paragraph['list'] {
  const li = element.matches('li') ? element : element.parentElement?.matches('li') && element === element.parentElement.firstElementChild ? element.parentElement : null
  const list = li?.parentElement
  if (!li || !list?.matches('ul,ol')) return undefined
  let level = -1
  for (let ancestor: Element | null = list; ancestor; ancestor = ancestor.parentElement) if (ancestor.matches('ul,ol')) level++
  const items = [...list.children].filter(el => el.tagName === 'LI' && isPainted(el))
  let number = list instanceof HTMLOListElement ? list.start : 1
  for (const item of items) {
    if (item.hasAttribute('value')) number = Number(item.getAttribute('value'))
    if (item === li) break
    number++
  }
  const style = getComputedStyle(li)
  const measured = measureMarker(li, fonts, textScale(element))
  const type = measured.suppressed ? 'none' : style.listStyleType
  const context = document.createElement('canvas').getContext('2d')
  if (context) context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  // CSS outside decimal markers include the period and a space. Reserve the actual
  // glyph advance instead of a fixed .8em, which made Office's marker touch text.
  const marker = measured.marker?.character ? measured.text! : type === 'decimal' ? `${number}. ` : ''
  if (context && measured.marker) context.font = `${measured.marker.fontSize}px ${measured.marker.fontFace}`
  const indent = marker && context ? context.measureText(marker).width : type === 'disc' ? px(style.fontSize) * 1.075 : (measured.marker?.fontSize ?? px(style.fontSize)) * .8
  return { level, type, start: number, indent, marker: measured.marker }
}

function paragraph(element: HTMLElement, origin: DOMRect, fonts: Map<string, string>, rect = element.getBoundingClientRect()): Paragraph {
  const style = getComputedStyle(element)
  const align = paragraphAlignment(style.textAlign)
  const lineHeight = (style.lineHeight === 'normal' ? px(style.fontSize) * 1.2 : px(style.lineHeight)) * textScale(element)
  return {
    rect: relativeRect(rect, origin), runs: collectRuns(element, fonts, element.tagName === 'LI'),
    align, valign: 'top', sizeTolerance: [2, 0], wrap: ['pre', 'nowrap'].includes(style.whiteSpace) ? false : undefined,
    lineHeight, spaceBefore: 0, spaceAfter: 0,
    // External margins are already present in the absolute DOM coordinates.
    padding: [px(style.paddingTop), px(style.paddingRight), px(style.paddingBottom), px(style.paddingLeft)],
    fill: separateBackground(element) ? undefined : cssColor(style.backgroundColor), list: listInfo(element, fonts),
  }
}

function hasCompositeEffects(style: CSSStyleDeclaration): boolean {
  return ['transform', 'filter', 'clip-path', 'mask-image', 'mask-border-source', '-webkit-mask-box-image-source', 'backdrop-filter'].some(property => {
    const value = style.getPropertyValue(property)
    return value && value !== 'none'
  }) || (!!style.opacity && style.opacity !== '1') || (!!style.mixBlendMode && style.mixBlendMode !== 'normal')
}
function hasEffects(style: CSSStyleDeclaration, separateBox = false): boolean {
  return hasCompositeEffects(style) || [style.textShadow, separateBox ? 'none' : style.boxShadow].some(value => !!value && value !== 'none')
}
function pseudoFacts(element: Element, pseudo: string): PseudoFacts {
  const style = getComputedStyle(element, pseudo)
  return { content: style.content, display: style.display, visibility: style.visibility,
    background: cssColor(style.backgroundColor).transparency < 100 || style.backgroundImage !== 'none',
    border: ['top', 'right', 'bottom', 'left'].some(side => px(style.getPropertyValue(`border-${side}-width`)) > 0),
    effects: hasEffects(style), sized: Number.parseFloat(style.width) > 0 || Number.parseFloat(style.height) > 0 }
}
function complexReason(element: Element, collectedNodes?: Element[]): string | undefined {
  const kind = element.matches('section') ? 'section' : element.matches('table') ? 'table' : element.matches('ul,ol') ? 'list' : 'text'
  if (kind === 'table') { const reason = tableShapeReason(element as HTMLTableElement); if (reason) return reason }
  const facts: ElementFacts = { kind }
  const nodes = collectedNodes ?? (kind === 'section' ? [element] : [element, ...element.querySelectorAll('*')])
  for (const el of nodes) {
    const style = getComputedStyle(el)
    if (!isPainted(el)) {
      const rect = el.getBoundingClientRect()
      // Nonpainted inline boxes can still reserve space in a line. Native runs
      // cannot express that gap, even for content-visibility or zero opacity.
      if (el !== element && style.display !== 'none' && rect.width > 0 && rect.height > 0) facts.hiddenLayout = true
      continue
    }
    const separate = separateBackground(el)
    const unsupported = nativeStyleReason(style, el.matches('td,th') ? 'cell' : el.matches('table,thead,tbody,tfoot,tr,col,colgroup') ? 'structural' : el.matches('li,ul,ol') ? 'list' : kind === 'section' ? 'section' : 'text', separate)
    if (unsupported) return unsupported
    const layout = layoutPaintReason(style) ?? clipsContent(el) ?? textPseudoReason(el)
    if (layout) return layout
    if (el.matches('li')) {
      // Validate before committing a native list; measurement resolves its font later.
      const families = new Map([[style.fontFamily, style.fontFamily], [getComputedStyle(el, '::marker').fontFamily, 'marker']])
      try { measureMarker(el, families, 1) } catch (error) { return String(error) }
    }
    if (el !== element) for (const pseudo of ['::before', '::after']) {
      const generated = getComputedStyle(el, pseudo)
      if (pseudoNeedsRaster(pseudoFacts(el, pseudo)) && !['absolute', 'fixed'].includes(generated.position)) return `CSS generated inline/nested layout: ${pseudo}`
    }
    if (el !== element && ((style.position && style.position !== 'static') || (style.cssFloat && style.cssFloat !== 'none'))) return `CSS inline/nested positioning: ${style.position} / ${style.cssFloat}`
    facts.effects ||= hasEffects(style, kind === 'section' || separate)
    if (kind === 'section') continue
    facts.math ||= el.matches(MATH)
    facts.emoji ||= [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && /\p{Extended_Pictographic}/u.test(node.textContent ?? ''))
    facts.background ||= (!separate && style.backgroundImage !== 'none') || style.backgroundClip === 'text'
    facts.verticalText ||= !!style.writingMode && style.writingMode !== 'horizontal-tb'
    facts.customMarker ||= style.listStyleImage !== 'none' || (el.matches('ol') && el.hasAttribute('reversed'))
    const inline = el !== element && (style.display === 'inline' || style.display === 'inline-block')
    if (el !== element && style.display === 'inline-block') return 'CSS inline-block layout'
    if (inline && ['top', 'right', 'bottom', 'left'].some(side => Number.parseFloat(style.getPropertyValue(`margin-${side}`)) !== 0 && style.getPropertyValue(`margin-${side}`))) return 'CSS inline margin layout'
    if (style.whiteSpace.startsWith('pre') && [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.includes('\t'))) return 'CSS preserved tab layout'
    facts.inlineDecoration ||= inline && ((!separate && cssColor(style.backgroundColor).transparency < 100) ||
      ['top', 'right', 'bottom', 'left'].some(side => px(style.getPropertyValue(`padding-${side}`)) > 0 || (!separate && px(style.getPropertyValue(`border-${side}-width`)) > 0)))
    if (['flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display)) return `CSS text layout display: ${style.display}`
    // Cells may differ from one another, but collectRuns uses one whitespace
    // mode within each cell. Never flatten a preserved inline newline to a space.
    const whitespaceRoot = kind === 'table' ? el.closest('td,th') : element
    if (whitespaceRoot && el !== whitespaceRoot && style.whiteSpace !== getComputedStyle(whitespaceRoot).whiteSpace) return `Mixed CSS white-space: ${style.whiteSpace}`
    const hasText = [...el.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
    facts.textTransform ||= hasText && !!style.textTransform && style.textTransform !== 'none'
    facts.image ||= el.matches('img')
  }
  if (kind === 'list') facts.complexList = [...element.querySelectorAll('li > *')].filter(el => isPainted(el)).some(el => !el.matches('p,ul,ol') && !['inline', 'inline-block'].includes(getComputedStyle(el).display)) || [...element.querySelectorAll('table,pre,marp-pre,blockquote')].some(el => isPainted(el))
  if (kind === 'table') {
    const cells = [...(element as HTMLTableElement).rows].flatMap(row => [...row.cells])
    facts.mergedCells = cells.some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)
    facts.unsupportedCellAlignment = cells.some(cell => !cellAlignment(getComputedStyle(cell).verticalAlign))
  }
  return rasterReason(facts)
}

function ownTextBounds(element: HTMLElement): DOMRect | undefined {
  const nodes = [...element.childNodes].filter(node => !(node instanceof Element && node.matches('ul,ol')))
  const rectangles = nodes.flatMap(node => {
    const range = document.createRange(); range.selectNodeContents(node)
    return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
  })
  if (!rectangles.length) return undefined
  const left = Math.min(...rectangles.map(r => r.left)), top = Math.min(...rectangles.map(r => r.top))
  return new DOMRect(left, top, Math.max(...rectangles.map(r => r.right)) - left, Math.max(...rectangles.map(r => r.bottom)) - top)
}
function ownTextRect(element: HTMLElement): DOMRect { return ownTextBounds(element) ?? element.getBoundingClientRect() }

/** Center only the font leading of a measured, fully occupied line box. Extra
 * height from height/min-height must remain above-aligned instead of centering
 * the text in that spare space. Range/glyph-only boxes are handled explicitly. */
function measuredLineAlignment(element: HTMLElement, paragraph: Paragraph): void {
  const bounds = ownTextBounds(element)
  const leading = Math.max(0, paragraph.lineHeight - px(getComputedStyle(element).fontSize) * textScale(element))
  if (bounds && paragraph.rect.height <= bounds.height + leading + .5) paragraph.valign = 'middle'
}

/** Collapsed tables can put visible borders on rows/groups instead of cells. */
function cellBorder(cell: HTMLTableCellElement, side: string, table: HTMLTableElement): PptxGenJS.BorderProps {
  const candidates: Element[] = [cell]
  if (getComputedStyle(table).borderCollapse === 'collapse') {
    const rect = cell.getBoundingClientRect()
    for (let node = cell.parentElement; node; node = node.parentElement) {
      const box = node.getBoundingClientRect()
      const edge = (r: DOMRect) => side === 'top' ? r.top : side === 'bottom' ? r.bottom : side === 'left' ? r.left : r.right
      if (!(node === table && separateBackground(table)) && Math.abs(edge(rect) - edge(box)) < 1) candidates.push(node)
      if (node === table) break
    }
  }
  let result: PptxGenJS.BorderProps = { type: 'none', color: 'FFFFFF', pt: 0 }
  for (const node of candidates) {
    const style = getComputedStyle(node)
    if (separateBackground(node) && rasterBox(style, node.matches('thead,tbody,tfoot,tr,td,th,col,colgroup'))) continue
    const width = px(style.getPropertyValue(`border-${side}-width`))
    const type = style.getPropertyValue(`border-${side}-style`), color = style.getPropertyValue(`border-${side}-color`)
    if (type === 'hidden') return { type: 'none', color: 'FFFFFF', pt: 0 }
    if (type !== 'solid' || width <= Number(result.pt) / .75 || cssColor(color).transparency === 100) continue
    result = { type: 'solid', color: borderColor(cell, color), pt: width * .75 }
  }
  return result
}

/** An opaque native cell would cover independent inline decoration below the table. */
function tableHasLayeredDecoration(table: HTMLTableElement): boolean {
  return [table, ...table.querySelectorAll('*')].some(node => isPainted(node) && (
    (!node.matches('table,thead,tbody,tfoot,tr,td,th,col,colgroup') && separateBackground(node)) ||
    ['::before', '::after'].some(pseudo => isPainted(node, pseudo) && pseudoNeedsRaster(pseudoFacts(node, pseudo)))
  ))
}

export function measureTable(table: HTMLTableElement, origin: DOMRect, fonts: Map<string, string>): Extract<Part, { kind: 'table' }> {
  const reason = tableShapeReason(table)
  if (reason) throw new Error(reason)
  const rows = [...table.rows]
  const layeredDecoration = tableHasLayeredDecoration(table)
  const result: TableCell[][] = rows.map(row => [...row.cells].map(cell => {
    const style = getComputedStyle(cell)
    const borders = ['top', 'right', 'bottom', 'left'].map(side => cellBorder(cell, side, table)) as TableCell['border']
    // Simple fills belong to the grid unless they would cover descendant paint.
    // Complex decoration keeps its existing independent browser-painted layer.
    const fill = layeredDecoration || rasterBox(style, true) ? { color: 'FFFFFF', transparency: 100 } : cssColor(style.backgroundColor)
    return { runs: collectRuns(cell, fonts), style: paragraph(cell, origin, fonts), fill, border: borders, valign: requiredCellAlignment(style.verticalAlign) }
  }))
  const rect = relativeRect(table.getBoundingClientRect(), origin)
  const domWidths = [...rows[0]!.cells].map(cell => cell.getBoundingClientRect().width)
  const content = domWidths.map((_, column) => rows.map((row, index) => {
    const measured = result[index]![column]!
    return { width: ownTextRect(row.cells[column]!).width + measured.style.padding[1] + measured.style.padding[3],
      reserve: Math.max(3, ...measured.runs.map(run => run.style.fontSize * .2)) + 2 }
  }))
  // Preserve the existing Office reserve, including harmless ancestor overflow.
  let columnWidths = domWidths.map((width, column) => Math.max(width, ...content[column]!.map(cell => cell.width + cell.reserve)))
  if (origin.width > 0 && (rect.x < -.5 || rect.x + rect.width > origin.width + .5)) throw new Error('Table DOM width exceeds slide bounds')
  const budget = origin.width - rect.x
  if (origin.width > 0 && columnWidths.reduce((sum, width) => sum + width, 0) > budget) {
    // Only the slide edge constrains reserves. Normalize collapsed border edges
    // to the DOM width, then borrow spare column space before reducing reserves.
    const gridWidth = domWidths.reduce((sum, width) => sum + width, 0)
    const widths = domWidths.map(width => width * Math.min(rect.width, budget) / gridWidth)
    const minimums = widths.map((width, i) => Math.min(width, Math.max(...content[i]!.map(cell => cell.width))))
    const reserves = minimums.map((width, i) => Math.max(...content[i]!.map(cell => cell.width + cell.reserve)) - width)
    const available = Math.max(0, budget - minimums.reduce((sum, width) => sum + width, 0))
    const reserveTotal = reserves.reduce((sum, width) => sum + width, 0)
    const scale = reserveTotal > 0 ? Math.min(1, available / reserveTotal) : 0
    const targets = minimums.map((width, i) => width + reserves[i]! * scale)
    const spare = widths.map((width, i) => Math.max(0, width - targets[i]!))
    const needed = widths.map((width, i) => Math.max(0, targets[i]! - width))
    const spareTotal = spare.reduce((sum, width) => sum + width, 0)
    const excess = Math.max(0, widths.reduce((sum, width) => sum + width, 0) + needed.reduce((sum, width) => sum + width, 0) - budget)
    columnWidths = widths.map((width, i) => width + needed[i]! - (spareTotal ? spare[i]! * excess / spareTotal : 0))
  }
  return { kind: 'table', rect: { ...rect, width: columnWidths.reduce((sum, width) => sum + width, 0) }, rows: result,
    columnWidths, rowHeights: rows.map(row => row.getBoundingClientRect().height) }
}

/** Map structural background edges to the same column boundaries used by addTable.
 * Collapsed borders can put the outer DOM edge half a pixel outside the cell grid. */
function tableBackgroundRect(node: Element, table: HTMLTableElement, part: Extract<Part, { kind: 'table' }>, origin: DOMRect): Rect {
  const rect = relativeRect(node.getBoundingClientRect(), origin)
  if (node === table) return { ...rect, x: part.rect.x, width: part.rect.width }
  const cells = [...table.rows[0]!.cells]
  const edges = [cells[0]!.getBoundingClientRect().left - origin.left, ...cells.map(cell => cell.getBoundingClientRect().right - origin.left)]
  const output = [part.rect.x]
  for (const width of part.columnWidths) output.push(output.at(-1)! + width)
  const map = (x: number): number => {
    const edge = edges.findIndex(value => Math.abs(value - x) <= .75)
    if (edge >= 0) return output[edge]!
    const next = edges.findIndex(value => value > x)
    const column = next < 0 ? part.columnWidths.length - 1 : Math.max(0, next - 1)
    return output[column]! + (x - edges[column]!) / (edges[column + 1]! - edges[column]!) * part.columnWidths[column]!
  }
  const x = map(rect.x)
  return { ...rect, x, width: map(rect.x + rect.width) - x }
}

/** A whole list shares one available width; nested items only change paragraph indentation. */
export function measureList(list: HTMLElement, origin: DOMRect, fonts: Map<string, string>): Extract<Part, { kind: 'list' }> {
  const paragraphs: Paragraph[] = []
  for (const li of list.querySelectorAll<HTMLElement>('li')) {
    // A descendant of display:none still computes to list-item, but has no box.
    if (!isPainted(li)) continue
    const blocks = [...li.querySelectorAll<HTMLElement>(':scope > p')]
    for (const [index, block] of (blocks.length ? blocks : [li]).entries()) {
      if (!isPainted(block)) continue
      const nested = !!block.querySelector('ul,ol')
      const p = paragraph(block, origin, fonts, nested ? ownTextRect(block) : block.getBoundingClientRect())
      if (nested) p.valign = 'middle' // Range bounds enclose glyphs rather than the CSS line box.
      else {
        const style = getComputedStyle(block)
        const [top, right, bottom, left] = p.padding.map((n, i) => n + px(style.getPropertyValue(`border-${['top', 'right', 'bottom', 'left'][i]}-width`)))
        p.rect = { x: p.rect.x + left!, y: p.rect.y + top!, width: p.rect.width - left! - right!, height: p.rect.height - top! - bottom! }
      }
      p.padding = [0, 0, 0, 0]
      if (!nested) measuredLineAlignment(block, p)
      if (index > 0) p.list = undefined
      if (p.runs.length) { validatePart({ kind: 'text', paragraph: p }); paragraphs.push(p) }
    }
  }
  // A single textbox cannot interleave a later item's background with earlier text.
  for (let i = 1; i < paragraphs.length; i++) if (paragraphs[i]!.rect.y < paragraphs[i - 1]!.rect.y + paragraphs[i - 1]!.rect.height - 1) throw new Error('Overlapping list item paint order')
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
  return { kind: 'list', rect, paragraphs, positioned: !list.querySelector('li ul,li ol') }
}

function pseudoText(section: HTMLElement, pseudo: string): HTMLElement | null {
  const style = getComputedStyle(section, pseudo)
  if (!isPainted(section) || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.contentVisibility === 'hidden') return null
  let content = style.content
  if (!content || ['none', 'normal', '""', "''"].includes(content)) return null
  content = content.replace(/attr\(([^)]+)\)/g, (_, attr: string) => JSON.stringify(section.getAttribute(attr) ?? ''))
  const pieces = [...content.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)]
  if (!pieces.length) return null
  const span = document.createElement('span')
  span.textContent = pieces.map(m => (m[1] ?? m[2] ?? '').replace(/\\(["'\\])/g, '$1')).join('')
  for (const key of style) span.style.setProperty(key, style.getPropertyValue(key))
  span.style.content = 'normal'
  span.dataset.pptxPseudo = 'true'
  section.append(span)
  return span
}

export async function measureSlide(svg: SVGSVGElement, notes: string[], fonts: Map<string, string>, fontCSS: string, report: ExportReport, slideIndex: number, backgrounds = new Map<string, Promise<string>>()): Promise<MeasuredSlide> {
  const origin = svg.getBoundingClientRect(), viewBox = svg.viewBox.baseVal
  if (Math.abs(origin.width - viewBox.width) > .1 || Math.abs(origin.height - viewBox.height) > .1) throw new Error('Export surface must be rendered at 1:1 scale')
  const parts: Part[] = []
  const sections = [...svg.querySelectorAll<HTMLElement>('foreignObject > section')].filter(el => isPainted(el))
  let background = 'FFFFFF'
  const rasterized = new WeakSet<Element>()
  const fallback = async (el: HTMLElement, reason: string) => {
    try {
      const failed = [el, ...el.querySelectorAll<HTMLElement>('[data-pptx-asset-error]')].find(node => node.dataset.pptxAssetError)
      if (failed) throw new Error(failed.dataset.pptxAssetError)
      const part: Part = { kind: 'image', rect: relativeRect(rasterBounds(el), origin), data: await rasterize(el, fontCSS, undefined, false, svg) }
      validatePart(part)
      parts.push(part)
      for (const node of [el, ...el.querySelectorAll('*')]) rasterized.add(node)
      report.rasterizedElements.push({ slide: slideIndex + 1, element: el.tagName.toLowerCase(), reason })
      return true
    } catch (error) { reportElementError(report, slideIndex + 1, el.tagName.toLowerCase(), `${reason}; rasterization failed: ${error instanceof Error ? error.message : String(error)}`); return false }
  }
  // Only section compositing effects require a whole-slide fallback.
  const sectionReason = sections.map(section => { try {
    for (const node of [section, ...section.querySelectorAll('*')]) {
      try { if (!isPainted(node)) continue } catch { continue }
      const s = getComputedStyle(node)
      for (const pseudo of ['::before', '::after']) {
        if (!isPainted(node, pseudo)) continue
        const paint = getComputedStyle(node, pseudo)
        if ((paint.zIndex && !['auto', '0'].includes(paint.zIndex) && (node !== section || (pseudo === '::before' ? Number(paint.zIndex) > 0 : Number(paint.zIndex) < 0))) || (paint.mixBlendMode && paint.mixBlendMode !== 'normal') || (paint.backdropFilter && paint.backdropFilter !== 'none')) return `CSS ${pseudo} stacking/compositing`
      }
      if ((node !== section && s.zIndex && !['auto', '0'].includes(s.zIndex)) || (s.mixBlendMode && s.mixBlendMode !== 'normal') || (s.backdropFilter && s.backdropFilter !== 'none')) return `CSS stacking/compositing: z-index=${s.zIndex}; mix-blend-mode=${s.mixBlendMode}; backdrop-filter=${s.backdropFilter}`
    }
    return complexReason(section) } catch (error) { return String(error) } }).find(Boolean)
  if (sectionReason) {
    if (await fallback(svg as unknown as HTMLElement, `Slide: ${sectionReason}`)) return { width: viewBox.width, height: viewBox.height, background, parts, notes }
  }
  for (const section of sections) {
    const start = parts.length
    try {
      if (section.dataset.pptxAssetError) throw new Error(section.dataset.pptxAssetError)
      const style = getComputedStyle(section)
      const color = cssColor(style.backgroundColor)
      const boxDecoration = px(style.borderRadius) > 0 || (style.boxShadow && style.boxShadow !== 'none') || ['top', 'right', 'bottom', 'left'].some(side => px(style.getPropertyValue(`border-${side}-width`)) > 0)
      const rasterBackground = section.dataset.marpitAdvancedBackground === 'background' || style.backgroundImage !== 'none' || boxDecoration
      if (color.transparency === 0 && !rasterBackground) background = color.color
      // Keep alpha as a native layer over the slide's white base. Raster backgrounds
      // already contain this color, so adding it there would apply the alpha twice.
      if (color.transparency > 0 && color.transparency < 100 && !rasterBackground) {
        parts.push({ kind: 'box', rect: relativeRect(section.getBoundingClientRect(), origin), fill: color })
      }
      if (rasterBackground) {
        // Only a leaf-free CSS background has a content-independent appearance.
        const cacheable = section.dataset.marpitAdvancedBackground !== 'background'
        const key = JSON.stringify([fontCSS, ...[...style].map(property => [property, style.getPropertyValue(property)])])
        if (!cacheable || !backgrounds.has(key)) {
          const image = rasterize(section, fontCSS, node => !(node instanceof Element) || !node.matches(`${BLOCKS},ul,ol,table`), true)
          if (cacheable) backgrounds.set(key, image)
          else parts.push({ kind: 'image', rect: relativeRect(section.getBoundingClientRect(), origin), data: await image })
        }
        if (cacheable) parts.push({ kind: 'image', rect: relativeRect(section.getBoundingClientRect(), origin), data: await backgrounds.get(key)! })
        if (style.backgroundImage.includes('gradient(') || boxDecoration) report.rasterizedElements.push({ slide: slideIndex + 1, element: 'section', reason: style.backgroundImage.includes('gradient(') ? 'CSS gradient background' : 'CSS section background decoration' })
      }
    } catch (error) {
      parts.splice(start)
      reportElementError(report, slideIndex + 1, 'section background', error)
    }
  }
  const approximationSeen = new WeakSet<Element>()
  const recordApproximations = (element: Element) => {
    for (const node of [element, ...element.querySelectorAll('*')]) {
      if (approximationSeen.has(node) || rasterized.has(node) || !isPainted(node)) continue
      approximationSeen.add(node)
      if (node.matches('li')) {
        const approximation = measureMarker(node, fonts, textScale(node)).approximation
        if (approximation) (report.approximatedElements ??= []).push({slide:slideIndex + 1,element:'li::marker',...approximation})
      }
      const styles = [[node.tagName.toLowerCase(), getComputedStyle(node)], ...(node.matches('li') ? [[`${node.tagName.toLowerCase()}::marker`, getComputedStyle(node, '::marker')]] : [])] as [string, CSSStyleDeclaration][]
      for (const [elementName, style] of styles) for (const approximation of styleApproximations(style)) {
        if (approximation.property.startsWith('border-') && separateBackground(node) && rasterBox(style, node.matches('thead,tbody,tfoot,tr,td,th,col,colgroup'))) continue
        ;(report.approximatedElements ??= []).push({ slide: slideIndex + 1, element: elementName, ...approximation })
      }
    }
  }
  const nativePseudoText = (node: Element, pseudo: string): Part | undefined => {
    const style = getComputedStyle(node, pseudo)
    if (!node.matches('section') || style.position !== 'absolute' || hasCompositeEffects(style) || /url\(|counter\(/.test(style.content)) return undefined
    const span = pseudoText(node as HTMLElement, pseudo)
    if (!span) return undefined
    try {
      span.style.background = 'none'; span.style.border = '0'; span.style.borderRadius = '0'; span.style.boxShadow = 'none'; span.style.textShadow = 'none'
      if (complexReason(span)) return undefined
      const p = paragraph(span, origin, fonts, ownTextRect(span))
      p.valign = 'middle'
      p.padding = [0, 0, 0, 0]; p.fill = undefined; p.wrap = false
      if (!p.runs.length) return undefined
      const part: Part = { kind: 'text', paragraph: p }
      validatePart(part)
      return part
    } catch { return undefined }
    finally { span.remove() }
  }
  const decorationSeen = new WeakMap<Element, Set<string>>()
  const decorations = async (element: Element, pseudo: string) => {
    // Blocks are collected as units, so include their inline descendants here.
    const nodes = element.matches(`${BLOCKS},ul,ol,table`) ? [element, ...element.querySelectorAll('*')] : [element]
    for (const node of nodes) {
      if (rasterized.has(node) || decorationSeen.get(node)?.has(pseudo)) continue
      if (!isPainted(node, pseudo) || !pseudoNeedsRaster(pseudoFacts(node, pseudo), node.matches('section'))) continue
      const seen = decorationSeen.get(node) ?? new Set<string>()
      seen.add(pseudo); decorationSeen.set(node, seen)
      try {
        if ((node as HTMLElement).dataset.pptxAssetError) throw new Error((node as HTMLElement).dataset.pptxAssetError)
        const text = nativePseudoText(node, pseudo)
        const image = await rasterizePseudo(node, pseudo, svg, fontCSS, !!text)
        if (image) {
          const part: Part = { kind: 'image', rect: relativeRect(image.rect, origin), data: image.data }
          validatePart(part); parts.push(part)
          report.rasterizedElements.push({ slide: slideIndex + 1, element: `${node.tagName.toLowerCase()}${pseudo}`, reason: 'CSS pseudo-element decoration' })
        }
        if (text) parts.push(text)
      } catch (error) { reportElementError(report, slideIndex + 1, `${node.tagName.toLowerCase()}${pseudo}`, error) }
    }
  }
  const visit = async (element: HTMLElement): Promise<void> => {
    const state = paintedState(element)
    if (state.subtreeHidden) return
    const failedAsset = element.dataset.pptxAssetError
    if (failedAsset) throw new Error(failedAsset)
    if (element.localName === 'svg') {
      try {
        const approximations: import('./styles').StyleApproximation[] = []
        parts.push(...measureSvg(element as unknown as SVGSVGElement, origin, fonts, approximations))
        for (const approximation of approximations) (report.approximatedElements ??= []).push({slide:slideIndex+1,element:'svg',...approximation})
      }
      catch (error) { await fallback(element, error instanceof Error ? error.message : String(error)) }
      return
    }
    if (!state.painted) {
      if (element.matches(`${BLOCKS},ul,ol,table`) && [...element.querySelectorAll('*')].some(el => isPainted(el))) {
        await fallback(element, 'Visible descendants of an unpainted container')
        return
      }
      for (const child of element.children) await walk(child as HTMLElement)
      return
    }
    const ownStyle = getComputedStyle(element)
    const ownReason = layoutPaintReason(ownStyle) ?? clipsContent(element)
    if (ownReason || hasEffects(ownStyle, separateBackground(element))) {
      await fallback(element, ownReason ?? 'CSS transform, filter, shadow or opacity'); return
    }
    if (element.matches('ul,ol')) {
      const reason = complexReason(element)
      if (reason) await fallback(element, reason)
      else {
        const list = measureList(element, origin, fonts)
        if (list.paragraphs.length) { parts.push(list) }
      }
      return
    }
    if (element.matches('table')) {
      const table = element as HTMLTableElement
      const reason = complexReason(element)
      if (reason) await fallback(element, reason)
      else { parts.push(measureTable(table, origin, fonts)) }
      return
    }
    if (element.matches('img')) {
      parts.push({ kind: 'image', rect: relativeRect(rasterBounds(element), origin), data: await rasterize(element, fontCSS) })
      if (element.dataset.pptxRasterReason) report.rasterizedElements.push({ slide: slideIndex + 1, element: 'img', reason: element.dataset.pptxRasterReason })
      return
    }
    // Direct wrapper text around block children or spaced inline fragments must
    // keep its own measured box. Flattening display:block strong loses newlines.
    const fragmentChild = (el: Element) => !['inline', 'contents'].includes(getComputedStyle(el).display) || ['left', 'right'].some(side => Number.parseFloat(getComputedStyle(el).getPropertyValue(`margin-${side}`)) !== 0)
    const fragmentBoundary = (el: Element) => el.tagName !== 'BR' && (fragmentChild(el) || el.matches('img,svg,mjx-container') || !!el.querySelector('img,svg,mjx-container'))
    if (element.matches('div') && [...element.children].some(fragmentBoundary)) {
      let nodes: Node[] = []
      const flush = () => {
        if (!nodes.length) return
        // Audit only the descendants collected into this paragraph. Block/asset
        // boundaries are measured independently, so their positioning is valid.
        const descendants = nodes.flatMap(node => node instanceof Element ? [node, ...node.querySelectorAll('*')] : [])
        const reason = nativeStyleReason(ownStyle, 'text', true) ?? textPseudoReason(element) ?? complexReason(element, descendants)
        if (reason) throw new Error(reason)
        const runs = collectRuns(element, fonts, false, nodes)
        if (runs.some(run => run.text.trim())) {
          const range = document.createRange(); range.setStartBefore(nodes[0]!); range.setEndAfter(nodes.at(-1)!)
          const p = paragraph(element, origin, fonts, range.getBoundingClientRect())
          p.valign = 'middle'
          p.runs = runs; p.padding = [0, 0, 0, 0]; p.fill = undefined
          parts.push({ kind: 'text', paragraph: p })
        }
        nodes = []
      }
      for (const node of element.childNodes) {
        if (node instanceof Element && fragmentBoundary(node)) { flush(); await walk(node as HTMLElement) }
        else nodes.push(node)
      }
      flush(); return
    }
    // A Markdown paragraph can consist solely of an inline SVG. Keep its diagram
    // boundary, rather than rejecting the enclosing text block as math.
    if (element.matches('p') && element.children.length === 1 && element.firstElementChild?.localName === 'svg' && ![...element.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) {
      await walk(element.firstElementChild as HTMLElement); return
    }
    if (element.matches(BLOCKS) || element.dataset.pptxPseudo === 'true' || (!element.querySelector(`${BLOCKS},ul,ol,table,figure,svg`) && [...element.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()))) {
      const reason = complexReason(element)
      if (reason) { await fallback(element, reason); return }
      const children = [...element.children] as HTMLElement[]
      if (element.matches('blockquote') || (element.matches('li') && children.some(c => c.matches('p')))) {
        for (const child of children) await walk(child)
        return
      }
      const scaled = Math.abs(textScale(element) - 1) > .001
      const generated = ['::before', '::after'].some(pseudo => pseudoNeedsRaster(pseudoFacts(element, pseudo)))
      const textRect = element.matches('li') || scaled || generated ? ownTextRect(element) : element.getBoundingClientRect()
      const p = paragraph(element, origin, fonts, textRect)
      if (scaled || generated || element.matches('li')) p.valign = 'middle'
      if (!scaled && !generated && !element.matches('li')) {
        const [top, right, bottom, left] = p.padding.map((n, i) => n + px(ownStyle.getPropertyValue(`border-${['top', 'right', 'bottom', 'left'][i]}-width`)))
        p.rect = { x: p.rect.x + left!, y: p.rect.y + top!, width: p.rect.width - left! - right!, height: p.rect.height - top! - bottom! }
        p.padding = [0, 0, 0, 0]
      }
      if (element.matches('h1,h2,h3,h4,h5,h6')) p.rect.y += px(ownStyle.fontSize) * .075
      if (ownStyle.fontWeight === '300' && p.lineHeight <= px(ownStyle.fontSize)) p.rect.y += px(ownStyle.fontSize) * .17
      if (scaled || generated || element.matches('li')) p.padding = [0, 0, 0, 0]
      else measuredLineAlignment(element, p)
      // Marp has already fitted a single line. Office's slightly wider glyphs
      // must not introduce another line after that fit was measured.
      if (scaled && p.rect.height < p.lineHeight * 1.5 && !p.runs.some(run => run.text.includes('\n'))) p.wrap = false
      if (p.runs.length) { parts.push({ kind: 'text', paragraph: p }) }
      for (const child of element.querySelectorAll<HTMLElement>(':scope > ul,:scope > ol,:scope > img')) await walk(child)
      // Images can be nested inside links or emphasis.
      for (const image of element.querySelectorAll<HTMLElement>('a > img,em > img,strong > img')) await walk(image)
      return
    }
    if (element.matches(MATH) || element.namespaceURI === 'http://www.w3.org/2000/svg') { await fallback(element, 'Math or SVG'); return }
    const wrapperReason = textPseudoReason(element)
    if (wrapperReason || [...element.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) { await fallback(element, wrapperReason ?? 'Mixed wrapper text layout'); return }
    for (const child of element.children) await walk(child as HTMLElement)
  }
  const walk = async (element: HTMLElement): Promise<void> => {
    const start = parts.length
    try {
      await visit(element)
      for (const part of parts.slice(start)) validatePart(part)
      // A fallback already includes all generated paint. Native parts need isolated layers.
      const rasterFallback = rasterized.has(element)
      if (!rasterFallback && parts.slice(start).some(part => ['text', 'table', 'list'].includes(part.kind))) recordApproximations(element)
      if (!rasterFallback && isPainted(element)) {
        const nativeEnd = parts.length
        const nativeTable = element.matches('table') ? parts.slice(start).find(part => part.kind === 'table') : undefined
        const layeredTable = nativeTable && tableHasLayeredDecoration(element as HTMLTableElement)
        const backgroundNodes = element.matches(`${BLOCKS},ul,ol,table`) ? [element, ...element.querySelectorAll('*')] : [element]
        // All cell/structural paint must precede inline paint, including decorations
        // that extend into a later cell in DOM order.
        if (layeredTable) {
          const structural = (node: Element) => node.matches('table,thead,tbody,tfoot,tr,td,th,col,colgroup')
          backgroundNodes.sort((a, b) => Number(!structural(a)) - Number(!structural(b)))
        }
        for (const node of backgroundNodes.filter(separateBackground)) {
          if (rasterized.has(node) || decorationSeen.get(node)?.has('background')) continue
          const seen = decorationSeen.get(node) ?? new Set<string>()
          seen.add('background'); decorationSeen.set(node, seen)
          try {
            if (!rasterBox(getComputedStyle(node), node.matches('thead,tbody,tfoot,tr,td,th,col,colgroup')) && getComputedStyle(node).display !== 'inline') {
              if (nativeTable && !layeredTable && node.matches('td,th')) continue // Already painted by a:tcPr.
              const rect = nativeTable && node.matches('table,thead,tbody,tfoot,tr,td,th,col,colgroup')
                ? tableBackgroundRect(node, element as HTMLTableElement, nativeTable, origin)
                : relativeRect(node.getBoundingClientRect(), origin)
              const box = nativeBox(node, rect)
              parts.push(...(node.matches('thead,tbody,tfoot,tr,td,th,col,colgroup') ? box.filter(p => p.kind === 'box') : box))
              continue
            }
            const image = await rasterizeBackground(node, svg, fontCSS)
            if (image) {
              const part: Part = { kind: 'image', rect: relativeRect(image.rect, origin), data: image.data }
              validatePart(part); parts.push(part)
              report.rasterizedElements.push({ slide: slideIndex + 1, element: `${node.tagName.toLowerCase()} background`, reason: 'CSS background decoration' })
            }
          } catch (error) { reportElementError(report, slideIndex + 1, `${node.tagName.toLowerCase()} background`, error) }
        }
        await decorations(element, '::before')
        const before = parts.splice(nativeEnd)
        parts.splice(start, 0, ...before)
        await decorations(element, '::after')
      }
    } catch (error) {
      parts.splice(start)
      await fallback(element, `Element conversion failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const section of sections) {
    if (section.dataset.marpitAdvancedBackground === 'background') continue
    await decorations(section, '::before')
    for (const child of [...section.children]) await walk(child as HTMLElement)
    await decorations(section, '::after')
    for (const pseudo of ['::before', '::after']) {
      if (pseudoNeedsRaster(pseudoFacts(section, pseudo), true)) continue
      const span = pseudoText(section, pseudo)
      if (span) {
        try { await walk(span) }
        finally { span.remove() }
      }
    }
  }
  return { width: viewBox.width, height: viewBox.height, background, parts, notes }
}
