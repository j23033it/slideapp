import type PptxGenJS from 'pptxgenjs'

// A single source of truth for eligibility and serialization. No default marker.
export const NUMBER_MARKERS: Readonly<Record<string, string>> = {
  decimal: 'arabicPeriod', 'lower-alpha': 'alphaLcPeriod', 'upper-alpha': 'alphaUcPeriod',
  'lower-roman': 'romanLcPeriod', 'upper-roman': 'romanUcPeriod',
}
export const BULLET_MARKERS: Readonly<Record<string, string>> = { circle: '25CB', square: '25AA', disc: '2022' }
export const supportedMarker = (value: string): boolean => value === 'none' || Object.hasOwn(NUMBER_MARKERS, value) || Object.hasOwn(BULLET_MARKERS, value)

export interface Rect { x: number; y: number; width: number; height: number }
export interface RunStyle {
  transparency?: number
  fontFace: string; fontSize: number; color: string; bold: boolean; italic: boolean
  underline: boolean; strike: boolean; letterSpacing: number; hyperlink?: string
  hyperlinkSlide?: number
  superscript?: boolean; subscript?: boolean
}
export interface TextRun { text: string; style: RunStyle }
export interface Paragraph {
  rect: Rect; runs: TextRun[]; align: 'left' | 'center' | 'right' | 'justify'
  lineHeight: number; spaceBefore: number; spaceAfter: number
  padding: [number, number, number, number]
  wrap?: boolean
  valign?: 'top' | 'middle'
  sizeTolerance?: [number, number]
  list?: { level: number; type: string; start: number; indent: number; marker?: { character?: string; fontFace: string; fontSize: number; color: string; transparency: number } }
  fill?: { color: string; transparency: number }
}
export interface TableCell {
  runs: TextRun[]; style: Paragraph; fill?: { color: string; transparency: number }
  valign?: 'top' | 'middle' | 'bottom'
  border: [PptxGenJS.BorderProps, PptxGenJS.BorderProps, PptxGenJS.BorderProps, PptxGenJS.BorderProps]
}
export type Part = { kind: 'text'; paragraph: Paragraph } |
  { kind: 'list'; rect: Rect; paragraphs: Paragraph[]; positioned?: boolean } |
  { kind: 'image'; rect: Rect; data: string } |
  { kind: 'line'; x: number; y: number; width: number; height: number; color: string; points: number; transparency?: number; dash?: boolean; flipH?: boolean; flipV?: boolean } |
  { kind: 'box'; rect: Rect; fill: { color: string; transparency: number }; radius?: number; line?: PptxGenJS.ShapeLineProps } |
  { kind: 'polygon'; rect: Rect; points: { x: number; y: number }[]; fill: { color: string; transparency: number } } |
  { kind: 'path'; rect: Rect; points: { x: number; y: number }[]; closed: boolean; line: PptxGenJS.ShapeLineProps; join: 'miter' | 'round' | 'bevel'; miterLimit: number } |
  { kind: 'table'; rect: Rect; rows: TableCell[][]; columnWidths: number[]; rowHeights: number[] }
export interface MeasuredSlide {
  width: number; height: number; background: string; parts: Part[]; notes: string[]
}
export interface ExportReport {
  slideCount: number
  rasterizedCount: number
  rasterizedElements: { slide: number; element: string; reason: string }[]
  approximatedElements?: { slide: number; element: string; property: string; value: string; replacement: string }[]
  substitutedFonts: { requested: string; replacement: string }[]
  warnings: string[]
  errors?: { slide: number; element: string; reason: string }[]
}

export function reportElementError(report: ExportReport, slide: number, element: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  ;(report.errors ??= []).push({ slide, element, reason })
  report.warnings.push(`Error on slide ${slide}, ${element}: ${reason}`)
}

/** Geometry uses CSS pixels (96 dpi); no DOM or font metrics are guessed here. */
export function toPosition(rect: Rect, scale = 1 / 96): PptxGenJS.PositionProps {
  for (const n of Object.values(rect)) if (!Number.isFinite(n)) throw new Error('Invalid measured geometry')
  if (rect.width <= 0 || rect.height <= 0) throw new Error('Empty measured geometry')
  return { x: rect.x * scale, y: rect.y * scale, w: rect.width * scale, h: rect.height * scale }
}
export function toRun(run: TextRun, pointsPerPixel = .75): PptxGenJS.TextProps {
  const s = run.style
  return { text: run.text, options: {
    fontFace: s.fontFace, fontSize: s.fontSize * pointsPerPixel, color: s.color, transparency: s.transparency,
    bold: s.bold, italic: s.italic, underline: s.underline ? { style: 'sng' } : undefined,
    strike: s.strike, charSpacing: s.letterSpacing * pointsPerPixel,
    hyperlink: s.hyperlinkSlide ? { slide: s.hyperlinkSlide } : s.hyperlink ? { url: s.hyperlink } : undefined,
    superscript: s.superscript, subscript: s.subscript,
  } }
}
export function toTextOptions(p: Paragraph, scale = 1 / 96): PptxGenJS.TextPropsOptions {
  toPosition(p.rect, scale)
  const pt = scale * 72
  const options: PptxGenJS.TextPropsOptions = {
    ...toPosition({ ...p.rect, width: p.rect.width + (p.sizeTolerance?.[0] ?? 3), height: p.rect.height + (p.sizeTolerance?.[1] ?? 2) }, scale),
    align: p.align, valign: p.valign ?? 'top', fit: 'none', wrap: p.wrap ?? true,
    margin: p.padding.map(n => n * pt) as [number, number, number, number],
    lineSpacing: p.lineHeight * pt,
    paraSpaceBefore: p.spaceBefore * pt, paraSpaceAfter: p.spaceAfter * pt,
    fill: p.fill?.transparency === 100 ? undefined : p.fill,
    fontFace: p.runs[0]?.style.fontFace, fontSize: p.runs[0] ? p.runs[0].style.fontSize * pt : undefined,
    lang: 'ja-JP',
  }
  if (p.list) {
    const list = p.list
    if (!supportedMarker(list.type)) throw new Error(`Unsupported CSS list-style-type: ${list.type}`)
    if (!Number.isInteger(list.level) || list.level < 0 || list.level > 8) throw new Error(`Unsupported list level: ${list.level}`)
    if (!Number.isInteger(list.start) || list.start < 1 || list.start > 32767) throw new Error(`Unsupported list start: ${list.start}`)
    if (list.type === 'none' && !list.marker?.character) return options
    options.indentLevel = list.level
    options.bullet = list.marker?.character ? { characterCode: list.marker.character.codePointAt(0)!.toString(16), indent: list.indent * pt } : Object.hasOwn(NUMBER_MARKERS, list.type)
      ? { type: 'number', style: NUMBER_MARKERS[list.type], numberStartAt: list.start, indent: list.indent * pt }
      : { characterCode: BULLET_MARKERS[list.type]!, indent: list.indent * pt }
    // The DOM rect starts at the text. Move the shape left to accommodate its marker.
    options.x = Number(options.x) - list.indent * scale
    options.w = Number(options.w) + list.indent * scale
  }
  return options
}

export function cssColor(value: string): { color: string; transparency: number } {
  if (value === 'transparent') return { color: 'FFFFFF', transparency: 100 }
  const hex = /^#([\da-f]{6})$/i.exec(value)
  if (hex) return { color: hex[1]!.toUpperCase(), transparency: 0 }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(value)
  if (!rgb) throw new Error(`Unsupported computed color: ${value}`)
  if (rgb.slice(1, 4).some(n => !Number.isFinite(Number(n)) || Number(n) > 255) || !Number.isFinite(Number(rgb[4] ?? 1)) || Number(rgb[4] ?? 1) > 1) throw new Error(`Unsupported computed color: ${value}`)
  return { color: rgb.slice(1, 4).map(n => Math.round(Number(n)).toString(16).padStart(2, '0')).join('').toUpperCase(), transparency: Math.round((1 - Number(rgb[4] ?? 1)) * 100) }
}

/** Run the serializer's contracts while the original DOM is still available for fallback. */
export function validatePart(part: Part): void {
  const paragraph = (p: Paragraph) => {
    toTextOptions(p)
    if (![p.lineHeight, p.spaceBefore, p.spaceAfter, ...p.padding].every(Number.isFinite) || p.lineHeight <= 0) throw new Error('Invalid measured paragraph style')
    for (const run of p.runs) if (!Number.isFinite(run.style.fontSize) || run.style.fontSize <= 0 || !Number.isFinite(run.style.letterSpacing)) throw new Error('Invalid measured run style')
  }
  if (part.kind === 'text') paragraph(part.paragraph)
  else if (part.kind === 'line') {
    if (![part.x, part.y, part.width, part.height, part.points].every(Number.isFinite)) throw new Error('Invalid measured line')
  } else {
    toPosition(part.rect)
    if (part.kind === 'list') part.paragraphs.forEach(paragraph)
    if (part.kind === 'box' && part.radius !== undefined && (!Number.isFinite(part.radius) || part.radius < 0)) throw new Error('Invalid measured radius')
    if (part.kind === 'polygon' && (part.points.length < 3 || part.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) throw new Error('Invalid measured polygon')
    if (part.kind === 'path' && (part.points.length < 2 || part.points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)) || !Number.isFinite(part.miterLimit) || part.miterLimit < 0 || part.miterLimit * 100000 > 2147483647)) throw new Error('Invalid measured path')
    if (part.kind === 'table') {
      if (!part.rows.length || !part.columnWidths.length || part.rows.some(row => row.length !== part.columnWidths.length) || part.rowHeights.length !== part.rows.length || [...part.columnWidths, ...part.rowHeights].some(n => !Number.isFinite(n) || n <= 0)) throw new Error('Invalid measured table geometry')
      part.rows.flat().forEach(cell => paragraph(cell.style))
    }
  }
}
