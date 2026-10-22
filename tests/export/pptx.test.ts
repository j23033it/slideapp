import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { cssColor, toPosition, toRun, toTextOptions, type MeasuredSlide, type Paragraph, type TextRun } from '../../src/export/pptx/model'
import { generatePptx } from '../../src/export/pptx/generate'
import { defaultPptxPath } from '../../src/export/pptx/index'

const run: TextRun = { text: '日本語 & editable', style: {
  fontFace: 'Yu Gothic', fontSize: 32, color: '164A8A', bold: true, italic: true,
  underline: true, strike: true, letterSpacing: 2, hyperlink: 'https://example.com/',
} }
const paragraph: Paragraph = {
  rect: { x: 96, y: 192, width: 480, height: 96 }, runs: [run], align: 'center',
  lineHeight: 48, spaceBefore: 0, spaceAfter: 12, padding: [0, 4, 2, 0],
}
const slide: MeasuredSlide = { width: 1280, height: 720, background: 'FFFFFF',
  parts: [{ kind: 'text', paragraph }], notes: ['Speaker notes 日本語', 'second note'] }

describe('measured DOM → PowerPoint options', () => {
  it('uses exact 96dpi geometry, with no scaling guessed from the viewport', () => {
    expect(toPosition(paragraph.rect)).toEqual({ x: 1, y: 2, w: 5, h: 1 })
    expect(() => toPosition({ ...paragraph.rect, width: 0 })).toThrow('Empty')
    expect(() => toPosition({ ...paragraph.rect, x: NaN })).toThrow('Invalid')
  })
  it('converts run typography and links at 72 points per inch', () => {
    expect(toRun(run)).toMatchObject({ text: run.text, options: {
      fontFace: 'Yu Gothic', fontSize: 24, color: '164A8A', bold: true, italic: true,
      underline: { style: 'sng' }, strike: true, charSpacing: 1.5, hyperlink: { url: 'https://example.com/' },
    } })
  })
  it('disables autofit, allows a small overflow reserve, and keeps paragraph spacing', () => {
    expect(toTextOptions(paragraph)).toMatchObject({ x: 1, y: 2, w: 483 / 96, h: 98 / 96,
      fit: 'none', lineSpacing: 36, align: 'center', paraSpaceAfter: 9, margin: [0, 3, 1.5, 0] })
    expect(toTextOptions({ ...paragraph, wrap: false }).wrap).toBe(false)
  })
  it('preserves ordered start values and list nesting without shifting text twice', () => {
    const options = toTextOptions({ ...paragraph, list: { level: 2, type: 'decimal', start: 3, indent: 24 } })
    expect(options).toMatchObject({ indentLevel: 2, bullet: { type: 'number', style: 'arabicPeriod', numberStartAt: 3, indent: 18 }, x: .75 })
    expect(toTextOptions({ ...paragraph, list: { level: 1, type: 'square', start: 1, indent: 24 } }).bullet).toMatchObject({ characterCode: '25AA' })
  })
  it('keeps the measured text position for positioned lists with only a custom ::marker', async () => {
    const marker = { character: '✓', fontFace: 'Yu Gothic', fontSize: 32, color: '164A8A', transparency: 0 }
    const item: Paragraph = { ...paragraph, rect: { x: 100, y: 240, width: 300, height: 40 }, padding: [0, 0, 0, 0],
      align: 'left', runs: [{ ...run, text: 'checked' }], list: { level: 0, type: 'none', start: 1, indent: 20, marker } }
    const bytes = await generatePptx([{ ...slide, parts: [{ kind: 'list', positioned: true,
      rect: { x: 100, y: 240, width: 300, height: 40 }, paragraphs: [item] }] }])
    const xml = await (await JSZip.loadAsync(bytes)).file('ppt/slides/slide1.xml')!.async('string')
    // The shape moves 20px left for the marker, so the text must start 20px inside it.
    expect(xml).toContain(`marL="${20 * 9525}"`)
    expect(xml).toContain(`indent="-${20 * 9525}"`)
  })
  it('converts transparent and computed rgba colors', () => {
    expect(cssColor('rgb(22, 74, 138)')).toEqual({ color: '164A8A', transparency: 0 })
    expect(cssColor('rgba(10, 20, 30, 0.25)')).toEqual({ color: '0A141E', transparency: 75 })
    expect(cssColor('transparent').transparency).toBe(100)
    expect(() => cssColor('invented')).toThrow('Unsupported')
  })
  it('derives the neighboring PPTX path without changing other dots or directory names', () => {
    expect(defaultPptxPath('C:\\a.md\\deck.v2.MD')).toBe('C:\\a.md\\deck.v2.pptx')
    expect(defaultPptxPath('deck.markdown')).toBe('deck.pptx')
    expect(defaultPptxPath('deck')).toBe('deck.pptx')
  })
})

describe('generated PPTX archive', () => {
  it('stores repeated PNG media once while retaining every slide relationship', async () => {
    const data = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    const imageSlide: MeasuredSlide = { ...slide, parts: [{ kind: 'image', data, rect: { x: 0, y: 0, width: 1280, height: 720 } }] }
    const zip = await JSZip.loadAsync(await generatePptx([imageSlide, imageSlide, imageSlide]))
    const media = Object.keys(zip.files).filter(path => /^ppt\/media\/.*\.png$/.test(path))
    expect(media).toHaveLength(1)
    for (let i = 1; i <= 3; i++) {
      const rel = await zip.file(`ppt/slides/_rels/slide${i}.xml.rels`)!.async('string')
      expect(rel).toContain(`Target="../${media[0]!.slice('ppt/'.length)}"`)
      expect(await zip.file(`ppt/slides/slide${i}.xml`)!.async('string')).toContain('<p:pic>')
    }
  })
  it('contains editable rich text, East Asian fonts, exact positions, links, size, and notes', async () => {
    const bytes = await generatePptx([slide, { ...slide, notes: ['page two'] }])
    const zip = await JSZip.loadAsync(bytes)
    expect(Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(2)
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(xml).toContain('<a:t>日本語 &amp; editable</a:t>')
    expect(xml).toContain('<a:ea typeface="Yu Gothic"')
    expect(xml).toContain('sz="2400"')
    expect(xml).toContain('b="1"')
    expect(xml).toContain('i="1"')
    expect(xml).toContain('<a:off x="914400" y="1828800"/>')
    expect(xml).toContain('<a:hlinkClick')
    expect(xml).not.toContain('<a:spAutoFit')
    expect(xml).not.toContain('<a:normAutofit')
    expect(await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('string')).toContain('https://example.com/')
    expect(await zip.file('ppt/notesSlides/notesSlide1.xml')!.async('string')).toContain('Speaker notes 日本語')
    expect(await zip.file('ppt/presentation.xml')!.async('string')).toContain('cx="12192000" cy="6858000"')
  })
  it('writes native table cells with measured row/column geometry and fill/borders', async () => {
    const border = { type: 'solid' as const, color: '164A8A', pt: 1 }
    const cell = { runs: [run], style: paragraph, fill: { color: 'EEEEFF', transparency: 0 }, border: [border, border, border, border] as [typeof border, typeof border, typeof border, typeof border] }
    const bytes = await generatePptx([{ ...slide, parts: [{ kind: 'table', rect: { x: 96, y: 96, width: 480, height: 100 }, rows: [[cell, cell]], columnWidths: [240, 240], rowHeights: [100] }] }])
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(xml).toContain('<a:tbl>')
    expect(xml).toContain('<a:gridCol w="2286000"/>')
    expect(xml).toContain('EEEEFF')
    expect(xml.match(/<a:tc>/g)).toHaveLength(2)
    expect(xml).toContain('<a:ea typeface="Yu Gothic"')
    expect(xml).toContain('<a:tr h="952500">')
    // A zero top padding must not make the remaining point-valued margins inches.
    expect(xml).toContain('marL="0" marR="38100" marT="0" marB="19050"')
  })
  it('keeps nested bullets in one wide shape with measured indents and ordered starts', async () => {
    const make = (text: string, level: number, x: number, y: number, type = 'disc', start = 1): Paragraph => ({
      ...paragraph, rect: { x, y, width: 90, height: 40 }, padding: [0, 0, 0, 0],
      align: 'left', spaceAfter: 7, runs: [{ ...run, text }], list: { level, type, start, indent: 24 },
    })
    const paragraphs = [make('親', 0, 136, 240), make('子', 1, 194, 288, 'circle'), make('孫', 2, 252, 336, 'square'), make('次の親', 0, 136, 384), make('開始3', 0, 136, 432, 'decimal', 3), make('番号4', 0, 136, 480, 'decimal', 4)]
    paragraphs[1]!.runs.push({ ...run, text: ' bold\ncontinued', style: { ...run.style, bold: false } })
    const bytes = await generatePptx([{ ...slide, parts: [{ kind: 'list', rect: { x: 78, y: 240, width: 1123, height: 290 }, paragraphs }] }])
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(xml.match(/<p:sp>/g)).toHaveLength(1)
    expect(xml).toContain('<a:ext cx="10725150" cy="2781300"/>')
    const ps = [...xml.matchAll(/<a:p>(.*?)<\/a:p>/gs)].map(m => m[1]!)
    expect(ps).toHaveLength(6)
    expect(ps.map(p => Number(/lvl="(\d+)"/.exec(p)![1]))).toEqual([0, 1, 2, 0, 0, 0])
    expect(ps.map(p => Number(/marL="(\d+)"/.exec(p)![1]))).toEqual([58, 116, 174, 58, 58, 58].map(px => px * 9525))
    for (const p of ps) {
      expect(p.match(/<a:pPr /g)).toHaveLength(1)
      expect(p).toContain('indent="-228600"')
    }
    expect(ps[1]).toContain('char="&#x25CB;"')
    expect(ps[2]).toContain('char="&#x25AA;"')
    expect(ps[4]).toContain('startAt="3"')
    expect(ps[5]).toContain('startAt="4"')
    expect(ps[1]).toContain('<a:br/>')
    expect(xml).not.toMatch(/<a:(?:spAutoFit|normAutofit)/)
  })
  it('writes ordered bullet starts and rejects mixed slide sizes', async () => {
    const bytes = await generatePptx([{ ...slide, parts: [{ kind: 'text', paragraph: { ...paragraph, list: { level: 2, type: 'decimal', start: 3, indent: 24 } } }] }])
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(xml).toContain('startAt="3"')
    expect(xml).toContain('lvl="2"')
    await expect(generatePptx([slide, { ...slide, width: 960 }])).rejects.toThrow('Mixed slide sizes')
    await expect(generatePptx([])).rejects.toThrow('No slides')
  })
})
