// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { collectRuns, relativeRect, measureList, measureSlide, measureTable } from '../../src/export/pptx/measure'
import type { ExportReport } from '../../src/export/pptx/model'
import { inlineImages } from '../../src/export/pptx/raster'
import { generatePptx } from '../../src/export/pptx/generate'

describe('export DOM text collection', () => {
  it('preserves inline formats and explicit line breaks, without repeating nested list text', () => {
    const host = document.createElement('div')
    host.style.color = 'rgb(0, 0, 0)'
    host.innerHTML = '<ul><li style="font-family: Arial">Parent <strong style="font-weight:700">bold</strong><br>line<ul><li>Nested</li></ul>\n</li></ul>'
    document.body.append(host)
    try {
      const li = host.querySelector('li')!
      const runs = collectRuns(li, new Map([['Arial', 'Arial']]), true)
      expect(runs.map(run => run.text).join('')).toBe('Parent bold\nline')
      expect(runs.find(run => run.text === 'bold')?.style.bold).toBe(true)
      expect(runs.map(run => run.text).join('')).not.toContain('Nested')
    } finally { host.remove() }
  })
  it('keeps multiline code whitespace and only exports supported link protocols', () => {
    const host = document.createElement('div')
    host.style.color = 'rgb(0, 0, 0)'
    host.innerHTML = '<pre style="white-space:pre;font-family:Consolas">  x\n    y</pre><p><a href="https://example.com/">safe</a><a href="javascript:alert(1)">unsafe</a></p>'
    document.body.append(host)
    try {
      expect(collectRuns(host.querySelector('pre')!, new Map()).map(run => run.text).join('')).toBe('  x\n    y')
      const runs = collectRuns(host.querySelector('p')!, new Map())
      expect(runs[0]!.style.hyperlink).toBe('https://example.com/')
      expect(runs[1]!.style.hyperlink).toBeUndefined()
    } finally { host.remove() }
  })
  it('excludes hidden text but keeps an explicitly visible descendant and text alpha', async () => {
    const host = document.createElement('p')
    host.style.cssText = 'color:rgb(0,0,0);visibility:visible'
    host.innerHTML = 'Before <strong style="display:none">HIDDEN</strong><em style="visibility:hidden">SECRET<span style="visibility:visible">visible</span></em><b style="color:rgba(255,0,0,.25)">faint</b><i style="color:transparent">invisible</i> end'
    document.body.append(host)
    try {
      const runs = collectRuns(host, new Map())
      expect(runs.map(run => run.text).join('')).toBe('Before visiblefaintinvisible end')
      expect(runs.find(run => run.text === 'faint')?.style.transparency).toBe(75)
      expect(runs.find(run => run.text === 'invisible')?.style.transparency).toBe(100)
      const p = { rect: { x: 0, y: 0, width: 400, height: 40 }, runs, align: 'left' as const, lineHeight: 40, spaceBefore: 0, spaceAfter: 0, padding: [0,0,0,0] as [number,number,number,number] }
      const bytes = await generatePptx([{ width: 1280, height: 720, background: 'FFFFFF', parts: [{ kind: 'text', paragraph: p }], notes: [] }])
      const xml = await (await JSZip.loadAsync(bytes)).file('ppt/slides/slide1.xml')!.async('string')
      expect(xml).toContain('<a:alpha val="25000"/>')
      expect(xml).toContain('<a:alpha val="0"/>')
      expect(xml).not.toMatch(/HIDDEN|SECRET/)
    } finally { host.remove() }
  })
  it('inlines pseudo content/background assets and fails with pseudo context', async () => {
    const host = document.createElement('div')
    host.innerHTML = '<h1>Title</h1>'
    document.body.append(host)
    const original = getComputedStyle
    const data = 'data:image/png;base64,AA=='
    const resolver = vi.fn(async () => data)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
      if (el.tagName === 'H1' && pseudo === '::before') {
        const style = document.createElement('span').style
        style.content = 'url("https://example.test/picture.png")'
        style.backgroundImage = 'url("https://example.test/picture.png")'
        return style
      }
      return original(el)
    })
    try {
      await inlineImages(host, resolver)
      expect(resolver).toHaveBeenCalledTimes(1)
      expect(host.querySelector('style')?.textContent).toContain(`content:url("${data}")`)
      expect(host.querySelector('style')?.textContent).toContain(`background-image:url("${data}")`)
      await expect(inlineImages(host, async () => { throw new Error('missing') })).rejects.toThrow('h1::before content')
    } finally { vi.restoreAllMocks(); host.remove() }
  })
  it('subtracts the actual slide origin, including a split-background text offset', () => {
    expect(relativeRect({ left: -99200, top: 140, width: 400, height: 70 }, { left: -100000, top: 0 })).toEqual({ x: 800, y: 140, width: 400, height: 70 })
  })
  it('maps heading anchors to internal PowerPoint slide hyperlinks', () => {
    const host = document.createElement('div')
    host.style.color = 'rgb(0, 0, 0)'
    host.innerHTML = '<svg data-marpit-svg><foreignObject><section><p><a href="#second">next</a></p></section></foreignObject></svg><svg data-marpit-svg><foreignObject><section><h1 id="second">Second</h1></section></foreignObject></svg>'
    document.body.append(host)
    try { expect(collectRuns(host.querySelector('p')!, new Map())[0]!.style.hyperlinkSlide).toBe(2) }
    finally { host.remove() }
  })
  it('measures one shared list width while preserving nested paragraphs and external gaps', () => {
    const host = document.createElement('div')
    host.innerHTML = '<ul style="color:rgb(0,0,0);font-size:29px;line-height:44px"><li>Parent<ul><li>Child<ul><li>Grandchild</li></ul></li></ul></li><li>Next</li></ul>'
    for (const el of host.querySelectorAll<HTMLElement>('*')) el.style.backgroundColor = 'rgba(0,0,0,0)'
    document.body.append(host)
    const list = host.firstElementChild as HTMLElement
    const positions = [...list.querySelectorAll('li')].map((li, i) => {
      const rect = new DOMRect(136 + (i < 3 ? i * 58 : 0), 240 + i * 44 + (i === 3 ? 7 : 0), 90, 39)
      vi.spyOn(li, 'getBoundingClientRect').mockReturnValue(rect)
      return rect
    })
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(78, 238, 1123, 185))
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      const li = this.startContainer.parentElement!.closest('li')!
      return [positions[[...list.querySelectorAll('li')].indexOf(li)]!] as unknown as DOMRectList
    })
    try {
      const measured = measureList(list, new DOMRect(), new Map())
      expect(measured.rect.width).toBe(1123)
      expect(measured.paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['Parent', 'Child', 'Grandchild', 'Next'])
      expect(measured.paragraphs.map(p => p.list?.level)).toEqual([0, 1, 2, 0])
      expect(measured.paragraphs.map(p => p.spaceAfter)).toEqual([0, 0, 7, 0])
    } finally { vi.restoreAllMocks(); host.remove() }
  })
  it('omits nested items beneath display:none ancestors and paragraphs with empty geometry', async () => {
    const host = document.createElement('div')
    host.innerHTML = '<ul style="color:rgb(0,0,0);font-size:29px;line-height:44px"><li style="display:none">HIDDEN_PARENT<ul><li>HIDDEN_CHILD</li></ul></li><li style="display:none">HIDDEN_LOOSE_PARENT<ul><li><p>HIDDEN_PARAGRAPH</p></li></ul></li><li>ZERO_WIDTH</li><li>ZERO_HEIGHT</li><li><p>EMPTY_TEXT_RECT</p></li><li>Visible</li></ul>'
    for (const el of host.querySelectorAll<HTMLElement>('*')) el.style.backgroundColor = 'rgba(0,0,0,0)'
    document.body.append(host)
    const list = host.firstElementChild as HTMLElement
    vi.spyOn(list, 'getBoundingClientRect').mockReturnValue(new DOMRect(78, 200, 1123, 44))
    for (const el of list.querySelectorAll('li,p')) {
      const text = el.textContent!
      const hidden = text.includes('HIDDEN_')
      const emptyParagraph = el.tagName === 'P' && text === 'EMPTY_TEXT_RECT'
      vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(136, 200,
        hidden || emptyParagraph || text === 'ZERO_WIDTH' ? 0 : 200, hidden || text === 'ZERO_HEIGHT' ? 0 : 44))
    }
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      const text = this.startContainer.textContent!
      return [text === 'EMPTY_TEXT_RECT' ? new DOMRect(136, 200, 0, 44) :
        text.includes('HIDDEN_') ? new DOMRect() : new DOMRect(136, 200, 200, 44)] as unknown as DOMRectList
    })
    try {
      const measured = measureList(list, new DOMRect(), new Map())
      expect(measured.paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['Visible'])
      const bytes = await generatePptx([{ width: 1280, height: 720, background: 'FFFFFF', notes: [], parts: [measured] }])
      const xml = await (await JSZip.loadAsync(bytes)).file('ppt/slides/slide1.xml')!.async('string')
      expect(xml).toContain('<a:t>Visible</a:t>')
      expect(xml).not.toMatch(/HIDDEN_|ZERO_|EMPTY_TEXT_RECT/)
    } finally { vi.restoreAllMocks(); host.remove() }
  })
  it.each([
    ['rgba(255,0,0,.5)', 50],
    ['rgba(255,0,0,.25)', 75],
  ])('preserves a translucent solid slide background (%s) in native OOXML', async (background, transparency) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.innerHTML = `<foreignObject><section xmlns="http://www.w3.org/1999/xhtml" style="background-color:${background};background-image:none"></section></foreignObject>`
    document.body.append(svg)
    const rect = new DOMRect(0, 0, 1280, 720)
    Object.defineProperty(svg, 'viewBox', { value: { baseVal: { width: 1280, height: 720 } } })
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(rect)
    vi.spyOn(svg.querySelector('section')!, 'getBoundingClientRect').mockReturnValue(rect)
    const report: ExportReport = { slideCount: 1, rasterizedCount: 0, rasterizedElements: [], substitutedFonts: [], warnings: [] }
    try {
      const measured = await measureSlide(svg, [], new Map(), '', report, 0)
      expect(measured.background).toBe('FFFFFF')
      expect(measured.parts).toEqual([{ kind: 'box', rect: { x: 0, y: 0, width: 1280, height: 720 }, fill: { color: 'FF0000', transparency } }])
      expect(report.rasterizedElements).toEqual([])
      const xml = await (await JSZip.loadAsync(await generatePptx([measured]))).file('ppt/slides/slide1.xml')!.async('string')
      expect(xml).toContain(`<a:srgbClr val="FF0000"><a:alpha val="${(100 - transparency) * 1000}"/></a:srgbClr>`)
    } finally { vi.restoreAllMocks(); svg.remove() }
  })
  it('reserves native table text width and serializes exact DOM padding and row heights', async () => {
    const host = document.createElement('div')
    host.innerHTML = '<table style="color:rgb(0,0,0);font:29px Arial;line-height:43.5px"><tbody><tr><td style="padding:0 13px 6px 4px">42</td></tr><tr><td style="padding:6px 13px;vertical-align:bottom">42</td></tr></tbody></table>'
    for (const el of host.querySelectorAll<HTMLElement>('*')) el.style.backgroundColor = 'rgba(0,0,0,0)'
    for (const el of host.querySelectorAll<HTMLElement>('td')) el.style.border = '1px solid rgb(0,0,0)'
    document.body.append(host)
    const table = host.firstElementChild as HTMLTableElement
    vi.spyOn(table, 'getBoundingClientRect').mockReturnValue(new DOMRect(78, 200, 59, 112))
    for (const [i, row] of [...table.rows].entries()) {
      const rect = new DOMRect(78, 200 + i * 56, 59, 56)
      vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect)
      vi.spyOn(row.cells[0]!, 'getBoundingClientRect').mockReturnValue(rect)
    }
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([new DOMRect(91, 206, 33, 39)] as unknown as DOMRectList)
    try {
      const measured = measureTable(table, new DOMRect(), new Map([['Arial', 'Arial']]))
      expect(measured.columnWidths[0]).toBeCloseTo(33 + 13 + 13 + 29 * .2 + 2)
      expect(measured.rect.width).toBe(measured.columnWidths[0])
      expect(measured.rowHeights).toEqual([56, 56])
      expect(measured.rows[1]![0]!.valign).toBe('bottom')
      const bytes = await generatePptx([{ width: 1280, height: 720, background: 'FFFFFF', notes: [], parts: [measured] }])
      const zip = await JSZip.loadAsync(bytes)
      const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
      const width = Number(/<a:gridCol w="(\d+)"/.exec(xml)![1])
      expect(width).toBe(Math.round(measured.columnWidths[0]! * 9525))
      expect(xml).toMatch(/<a:tcPr[^>]*anchor="b"/)
      expect(xml.match(/<a:tr h="533400">/g)).toHaveLength(2)
      expect(xml).toContain('marL="38100" marR="123825" marT="0" marB="57150"')
      expect(xml).toContain('marL="123825" marR="123825" marT="57150" marB="57150"')
    } finally { vi.restoreAllMocks(); host.remove() }
  })
})
