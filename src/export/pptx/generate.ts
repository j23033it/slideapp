import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import { toPosition, toRun, toTextOptions, type MeasuredSlide, type Paragraph, type Part } from './model'

// Use DrawingML soft breaks for BRs and preserved newlines, including empty lines.
const textRuns = (runs: Paragraph['runs']) => runs.flatMap(run => run.text.split('\n').map((text, i) => ({ ...toRun({ ...run, text }), options: { ...toRun(run).options, softBreakBefore: i > 0 } })))

function listRuns(paragraphs: Paragraph[]): PptxGenJS.TextProps[] {
  return paragraphs.flatMap((p, index) => p.runs.flatMap((run, runIndex) => run.text.split('\n').map((text, lineIndex, lines) => ({
    ...toRun({ ...run, text }),
    options: { ...toTextOptions(p), ...toRun(run).options,
      softBreakBefore: lineIndex > 0,
      breakLine: index < paragraphs.length - 1 && runIndex === p.runs.length - 1 && lineIndex === lines.length - 1,
    },
  }))))
}

// PptxGenJS multiplies bullet.indent by (lvl + 1) for both marL and hanging
// indentation. OOXML keeps those independent: use the measured text offset and
// marker gap instead. Only our named list shapes are adjusted, never Markdown.
const xmlEscape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
function markerXml(p: Paragraph): string | undefined {
  const marker = p.list?.marker
  if (!marker) return undefined
  return `<a:buClr><a:srgbClr val="${marker.color}"><a:alpha val="${Math.round((100 - marker.transparency) * 1000)}"/></a:srgbClr></a:buClr><a:buSzPts val="${Math.round(marker.fontSize * 75)}"/><a:buFont typeface="${xmlEscape(marker.fontFace)}"/>`
}
function correctListIndents(xml: string, lists: Map<string, Extract<Part, { kind: 'list' }>>): string {
  let found = 0
  const corrected = xml.replace(/<p:sp>.*?<\/p:sp>/gs, shape => {
    const name = /<p:cNvPr\b[^>]*\bname="([^"]+)"/.exec(shape)?.[1]
    const list = name ? lists.get(name) : undefined
    if (!list) return shape
    found++
    let index = 0
    const result = shape.replace(/<a:p>.*?<\/a:p>/gs, paragraphXml => {
      const p = list.paragraphs[index++]
      if (!p) throw new Error('Unexpected PowerPoint list paragraph')
      let first = true
      return paragraphXml.replace(/<a:pPr\b[^>]*>.*?<\/a:pPr>/gs, properties => {
        // PptxGenJS emits pPr for each rich run; OOXML permits just one per paragraph.
        if (!first) return ''
        first = false
        const attrs = ` lvl="${p.list?.level ?? 0}" marL="${Math.round((p.rect.x - list.rect.x) * 9525)}" indent="${p.list && (p.list.type !== 'none' || p.list.marker?.character) ? -Math.round(p.list.indent * 9525) : 0}"`
        let result = properties.replace(/ (?:lvl|marL|indent)="[^"]*"/g, '').replace('<a:pPr', `<a:pPr${attrs}`)
        const marker = markerXml(p)
        if (marker) {
          result = result.replace(/<a:bu(?:Clr|SzPct|SzPts|Font|ClrTx|SzTx)\b[^>]*(?:\/>|>.*?<\/a:bu(?:Clr|SzPct|SzPts|Font|ClrTx|SzTx)>)/gs, '')
          result = result.replace(/(<a:bu(?:Char|AutoNum)\b)/, `${marker}$1`)
        }
        return result
      })
    })
    if (index !== list.paragraphs.length) throw new Error('Missing PowerPoint list paragraph')
    return result
  })
  if (found !== lists.size) throw new Error('Missing PowerPoint list shape')
  return corrected
}

/** Pure measured-model → OOXML generation, also usable in Node verification. */
export async function generatePptx(slides: MeasuredSlide[], title = 'Marp slides'): Promise<Uint8Array> {
  if (!slides.length) throw new Error('No slides to export')
  const pptx = new PptxGenJS()
  pptx.title = title
  pptx.author = 'SlideApp'
  pptx.subject = 'Editable Marp export'
  const firstText = slides.flatMap(slide => slide.parts).find(part => part.kind === 'text')
  const defaultFont = firstText?.kind === 'text' ? firstText.paragraph.runs[0]?.style.fontFace ?? 'Yu Gothic' : 'Yu Gothic'
  pptx.theme = { headFontFace: defaultFont, bodyFontFace: defaultFont }
  const slideLists: Map<string, Extract<Part, { kind: 'list' }>>[] = []
  slides.forEach((model, index) => {
    const name = `MARP_${index}`
    pptx.defineLayout({ name, width: model.width / 96, height: model.height / 96 })
    // OOXML presentations have one size. Reject mixed sizes instead of silently scaling.
    if (model.width !== slides[0]!.width || model.height !== slides[0]!.height) throw new Error('Mixed slide sizes are not supported by PowerPoint')
    if (index === 0) pptx.layout = name
    const slide = pptx.addSlide()
    const lists = new Map<string, Extract<Part, { kind: 'list' }>>()
    slideLists.push(lists)
    slide.background = { color: model.background }
    for (const part of model.parts) {
      if (part.kind === 'text') slide.addText(textRuns(part.paragraph.runs), toTextOptions(part.paragraph))
      else if (part.kind === 'list') {
        if (part.positioned) {
          for (const p of part.paragraphs) {
            const objectName = `SlideApp list ${lists.size + 1}`, indent = p.list && p.list.type !== 'none' ? p.list.indent : 0
            lists.set(objectName, { kind: 'list', rect: { ...p.rect, x: p.rect.x - indent, width: p.rect.width + indent }, paragraphs: [p] })
            slide.addText(listRuns([p]), { ...toTextOptions(p), objectName })
          }
          continue
        }
        const objectName = `SlideApp list ${lists.size + 1}`
        lists.set(objectName, part)
        slide.addText(listRuns(part.paragraphs), {
          ...toPosition({ ...part.rect, width: part.rect.width + (part.paragraphs[0]?.sizeTolerance?.[0] ?? 3), height: part.rect.height + (part.paragraphs[0]?.sizeTolerance?.[1] ?? 2) }),
          objectName, margin: 0, valign: part.paragraphs[0]?.valign ?? 'top', fit: 'none', wrap: true,
        })
      }
      else if (part.kind === 'image') slide.addImage({ data: part.data, ...toPosition(part.rect) })
      else if (part.kind === 'line') slide.addShape(pptx.ShapeType.line, { x: part.x / 96, y: part.y / 96, w: part.width / 96, h: part.height / 96, flipH: part.flipH, flipV: part.flipV, line: { color: part.color, width: part.points, transparency: part.transparency, dashType: part.dash ? 'dash' : undefined } })
      else if (part.kind === 'box') slide.addShape(part.radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, { ...toPosition(part.rect), rectRadius: (part.radius ?? 0) / 96, fill: part.fill, line: part.line ?? { transparency: 100 } })
      // 4.0.1 supports custGeom at runtime but omits it from the ShapeType enum.
      else if (part.kind === 'polygon') slide.addShape('custGeom' as PptxGenJS.ShapeType, { ...toPosition(part.rect), points: [...part.points.map(p => ({ x: (p.x - part.rect.x) / 96, y: (p.y - part.rect.y) / 96 })), { close: true }], fill: part.fill, line: { transparency: 100 } })
      else {
        slide.addTable(part.rows.map(row => row.map(cell => ({
          text: textRuns(cell.runs),
          options: { ...toTextOptions(cell.style),
            // Table margins use inches, unlike addText's point-valued margins.
            margin: cell.style.padding.map(px => px / 96) as [number, number, number, number],
            fontFace: cell.runs[0]?.style.fontFace, fontSize: cell.runs[0] ? cell.runs[0].style.fontSize * .75 : undefined,
            fill: cell.fill, border: cell.border, valign: cell.valign ?? 'top' },
        }))), {
          ...toPosition(part.rect), autoPage: false,
          colW: part.columnWidths.map(w => w / 96), rowH: part.rowHeights.map(h => h / 96),
          margin: 0, valign: 'top',
        })
      }
    }
    if (model.notes.length) slide.addNotes(model.notes.join('\n\n'))
  })
  const needsMediaPass = slides.reduce((count, slide) => count + slide.parts.filter(part => part.kind === 'image').length, 0) > 1
  const bytes = await pptx.write({ outputType: 'arraybuffer', compression: false }) as ArrayBuffer
  const zip = await JSZip.loadAsync(bytes)
  for (const [index, lists] of slideLists.entries()) {
    const path = `ppt/slides/slide${index + 1}.xml`
    let xml = correctListIndents(await zip.file(path)!.async('string'), lists)
    // PptxGenJS 4.0.1 repeats pPr for rich runs in every text/table paragraph.
    // DrawingML permits exactly one. Also make no-stroke independent of themes.
    xml = xml.replace(/<a:ln>\s*<\/a:ln>/g, '<a:ln><a:noFill/></a:ln>').replace(/<a:p>.*?<\/a:p>/gs, paragraph => {
      let seen = false
      return paragraph.replace(/<a:pPr\b[^>]*>.*?<\/a:pPr>/gs, properties => { if (seen) return ''; seen = true; return properties })
    })
    zip.file(path, xml)
  }
  if (needsMediaPass) {
    const canonical = new Map<string, string>(), replacements = new Map<string, string>()
    for (const path of Object.keys(zip.files).filter(path => /^ppt\/media\/.*\.png$/.test(path))) {
      const data = await zip.file(path)!.async('base64')
      const original = canonical.get(data)
      if (original) { replacements.set(path.slice('ppt/'.length), original.slice('ppt/'.length)); zip.remove(path) }
      else canonical.set(data, path)
    }
    if (replacements.size) for (const path of Object.keys(zip.files).filter(path => path.endsWith('.rels'))) {
      const xml = await zip.file(path)!.async('string')
      zip.file(path, xml.replace(/Target="\.\.\/(media\/[^"]+)"/g, (attribute, target: string) => replacements.has(target) ? `Target="../${replacements.get(target)}"` : attribute))
    }
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
