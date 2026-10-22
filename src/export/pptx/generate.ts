import PptxGenJS from 'pptxgenjs'
import JSZip from 'jszip'
import { toPosition, toRun, toTextOptions, type MeasuredSlide, type Paragraph, type Part } from './model'

function listRuns(paragraphs: Paragraph[]): PptxGenJS.TextProps[] {
  return paragraphs.flatMap((p, index) => p.runs.flatMap((run, runIndex) => run.text.split('\n').map((text, lineIndex, lines) => ({
    ...toRun({ ...run, text }),
    options: { ...toRun(run).options, ...toTextOptions(p),
      softBreakBefore: lineIndex > 0,
      breakLine: index < paragraphs.length - 1 && runIndex === p.runs.length - 1 && lineIndex === lines.length - 1,
    },
  }))))
}

// PptxGenJS multiplies bullet.indent by (lvl + 1) for both marL and hanging
// indentation. OOXML keeps those independent: use the measured text offset and
// marker gap instead. Only our named list shapes are adjusted, never Markdown.
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
        const attrs = ` lvl="${p.list?.level ?? 0}" marL="${Math.round((p.rect.x - list.rect.x) * 9525)}" indent="${p.list && p.list.type !== 'none' ? -Math.round(p.list.indent * 9525) : 0}"`
        return properties.replace(/ (?:lvl|marL|indent)="[^"]*"/g, '').replace('<a:pPr', `<a:pPr${attrs}`)
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
  pptx.theme = { headFontFace: 'Yu Gothic', bodyFontFace: 'Yu Gothic' }
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
      if (part.kind === 'text') slide.addText(part.paragraph.runs.map(r => toRun(r)), toTextOptions(part.paragraph))
      else if (part.kind === 'list') {
        const objectName = `SlideApp list ${lists.size + 1}`
        lists.set(objectName, part)
        slide.addText(listRuns(part.paragraphs), {
          ...toPosition({ ...part.rect, width: part.rect.width + 3, height: part.rect.height + 2 }),
          objectName, margin: 0, valign: 'top', fit: 'none', wrap: true,
        })
      }
      else if (part.kind === 'image') slide.addImage({ data: part.data, ...toPosition(part.rect) })
      else if (part.kind === 'line') slide.addShape(pptx.ShapeType.line, { x: part.x / 96, y: part.y / 96, w: part.width / 96, h: part.height / 96, line: { color: part.color, width: part.points } })
      else if (part.kind === 'box') slide.addShape(pptx.ShapeType.rect, { ...toPosition(part.rect), fill: part.fill, line: { transparency: 100 } })
      else {
        slide.addTable(part.rows.map(row => row.map(cell => ({
          text: cell.runs.map(r => toRun(r)),
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
  const needsZip = needsMediaPass || slideLists.some(lists => lists.size)
  const bytes = await pptx.write({ outputType: 'arraybuffer', compression: !needsZip }) as ArrayBuffer
  if (!needsZip) return new Uint8Array(bytes)
  const zip = await JSZip.loadAsync(bytes)
  for (const [index, lists] of slideLists.entries()) {
    if (!lists.size) continue
    const path = `ppt/slides/slide${index + 1}.xml`
    zip.file(path, correctListIndents(await zip.file(path)!.async('string'), lists))
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
