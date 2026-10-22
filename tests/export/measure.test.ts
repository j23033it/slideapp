// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { collectRuns, relativeRect, measureList, measureSlide, measureTable, tableShapeReason } from '../../src/export/pptx/measure'
import type { ExportReport } from '../../src/export/pptx/model'
import { inlineImages } from '../../src/export/pptx/raster'
import { generatePptx } from '../../src/export/pptx/generate'
import * as raster from '../../src/export/pptx/raster'
import { isPainted, paintedState } from '../../src/export/pptx/visibility'

// happy-dom has no layout or UA defaults. Supply only browser defaults/boxes;
// individual tests override geometry to exercise nonpainted and malformed cases.
beforeEach(() => {
  const style = document.createElement('style')
  style.dataset.exportTestDefaults = 'true'
  style.textContent = `body {font-family:Arial;font-size:16px;line-height:normal;color:rgb(0,0,0);letter-spacing:0px;text-align:left;visibility:visible;list-style-type:disc} * {letter-spacing:0px;background-color:transparent;background-image:none;padding:0;border:0 solid rgb(0,0,0);border-radius:0px;list-style-image:none} td,th {vertical-align:top}`
  document.head.append(style)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 40))
})
afterEach(() => { vi.restoreAllMocks(); document.querySelector('[data-export-test-defaults]')?.remove() })
const setRect = (el: Element, rect: DOMRect) => Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => rect })
const fonts = () => new Map([['Arial', 'Arial'], ['Consolas', 'Consolas']])
const report = (): ExportReport => ({ slideCount: 2, rasterizedCount: 0, rasterizedElements: [], substitutedFonts: [], warnings: [] })
function surface(html: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const foreign = document.createElementNS(svg.namespaceURI, 'foreignObject')
  const section = document.createElement('section')
  section.innerHTML = html
  foreign.append(section); svg.append(foreign)
  Object.defineProperty(svg, 'viewBox', { value: { baseVal: { width: 1280, height: 720 } } })
  setRect(svg, new DOMRect(0, 0, 1280, 720))
  document.body.append(svg)
  return svg
}
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='

describe('export DOM text collection', () => {
  it.each(['display:none', 'content-visibility:hidden', 'visibility:collapse', 'visibility:hidden', 'opacity:0'])('uses the common painted check for every descendant of %s', css => {
    const host = document.createElement('div')
    host.style.cssText = css
    host.innerHTML = '<p>HIDDEN_PARAGRAPH</p><ul><li>HIDDEN_ITEM</li></ul><table><tbody><tr><td>HIDDEN_CELL</td></tr></tbody></table><img><span>HIDDEN_DECORATION</span>'
    document.body.append(host)
    try {
      for (const el of host.querySelectorAll('*')) {
        expect(isPainted(el), el.tagName).toBe(false)
        expect(collectRuns(el, fonts())).toEqual([])
      }
    } finally { host.remove() }
  })
  it('follows hidden shadow hosts and excludes zero-sized boxes without pruning visible overflow', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const child = document.createElement('p')
    host.attachShadow({ mode: 'open' }).append(child)
    try {
      host.hidden = true
      expect(paintedState(child)).toEqual({ subtreeHidden: true, painted: false })
      host.hidden = false
      setRect(child, new DOMRect(0, 0, 0, 40))
      expect(paintedState(child)).toEqual({ subtreeHidden: false, painted: false })
    } finally { host.remove() }
  })
  it.each(['row', 'cell', 'column', 'merged', 'ragged'])('rasterizes a %s table grid rather than passing empty native cells to generation', async mode => {
    const svg = surface('<table style="font-variant-numeric:normal"><tbody><tr><td>First</td><td>Second</td></tr><tr><td>Third</td><td>Fourth</td></tr></tbody></table><p>Unaffected</p>')
    const table = svg.querySelector('table')!
    if (mode === 'row') table.rows[0]!.style.display = 'none'
    if (mode === 'cell') table.rows[0]!.cells[0]!.style.visibility = 'collapse'
    if (mode === 'column') { const col = document.createElement('col'); col.style.visibility = 'collapse'; table.prepend(col) }
    if (mode === 'merged') table.rows[0]!.cells[0]!.colSpan = 2
    if (mode === 'ragged') table.rows[1]!.deleteCell(1)
    const state = report()
    vi.spyOn(raster, 'rasterize').mockResolvedValue(png)
    try {
      expect(tableShapeReason(table)).toBeTruthy()
      const slide = await measureSlide(svg, [], fonts(), '', state, 0)
      expect(slide.parts.some(p => p.kind === 'table')).toBe(false)
      expect(slide.parts.some(p => p.kind === 'image')).toBe(true)
      expect(state.rasterizedElements.some(entry => entry.element === 'table')).toBe(true)
      expect(state.errors).toBeUndefined()
      expect(await generatePptx([slide])).toBeInstanceOf(Uint8Array)
    } finally { svg.remove() }
  })
  it('reports an unsupported Greek marker and preserves it as an image', async () => {
    const svg = surface('<ol style="list-style-type:lower-greek"><li>Alpha</li><li>Beta</li></ol><p>Unaffected</p>')
    const state = report()
    vi.spyOn(raster, 'rasterize').mockResolvedValue(png)
    try {
      const slide = await measureSlide(svg, [], fonts(), '', state, 0)
      expect(state.rasterizedElements).toContainEqual({slide:1,element:'ol',reason:'Unsupported CSS list-style-type: lower-greek'})
      expect(slide.parts.some(p => p.kind === 'list')).toBe(false)
      expect(JSON.stringify(slide)).toContain('Unaffected')
    } finally { svg.remove() }
  })
  it('keeps approximated links and tables native and records their values', async () => {
    const svg = surface('<p><a href="https://example.com/" style="text-underline-offset:3px">Link</a></p><table style="font-variant-numeric:tabular-nums"><tbody><tr><td style="border:1px solid rgba(0,0,0,.5)">42</td></tr></tbody></table>')
    const state = report()
    try {
      const slide = await measureSlide(svg, [], fonts(), '', state, 0)
      expect(slide.parts.map(p => p.kind)).toEqual(['text', 'table'])
      expect(state.rasterizedElements).toEqual([])
      expect(state.approximatedElements).toContainEqual({ slide: 1, element: 'a', property: 'text-underline-offset', value: '3px', replacement: expect.any(String) })
      expect(state.approximatedElements).toContainEqual(expect.objectContaining({ element: 'table', property: 'font-variant-numeric', value: 'tabular-nums' }))
      const table = slide.parts.find(p => p.kind === 'table')!
      expect(table.rows[0]![0]!.border[0].color).toBe('808080')
    } finally { svg.remove() }
  })
  it('isolates a block background from its editable native text', async () => {
    const svg = surface('<p style="background-image:linear-gradient(red,blue);border-radius:4px;border:2px dashed rgb(0,0,0)">Editable decorated paragraph</p>')
    const state = report()
    vi.spyOn(raster, 'rasterizeBackground').mockResolvedValue({data:png,rect:new DOMRect(0,0,100,40)})
    try {
      const slide = await measureSlide(svg, [], fonts(), '', state, 0)
      expect(slide.parts.map(p => p.kind)).toEqual(['image','text'])
      expect(state.rasterizedElements).toEqual([{slide:1,element:'p background',reason:'CSS background decoration'}])
      const text = slide.parts.find(p => p.kind === 'text')!
      expect(text.paragraph.fill).toBeUndefined()
      expect(text.paragraph.runs[0]!.text).toBe('Editable decorated paragraph')
    } finally { svg.remove() }
  })
  it('keeps native content when its isolated decoration cannot be painted', async () => {
    const svg = surface('<p style="background-image:linear-gradient(red,blue)">Editable despite failed decoration</p>')
    const state = report()
    vi.spyOn(raster, 'rasterizeBackground').mockRejectedValue(new Error('Decoration canvas failure'))
    try {
      const slide = await measureSlide(svg, [], fonts(), '', state, 0)
      expect(slide.parts.map(p => p.kind)).toEqual(['text'])
      expect(state.errors).toEqual([{slide:1,element:'p background',reason:'Decoration canvas failure'}])
      expect(state.rasterizedElements).toEqual([])
    } finally { svg.remove() }
  })
  it('resolves a collapsed translucent row border into editable cell borders', async () => {
    const svg = surface('<table style="border-collapse:collapse"><tbody><tr style="border-top:2px solid rgba(0,0,0,.5)"><td>42</td></tr></tbody></table>')
    const state = report()
    try {
      const slide = await measureSlide(svg, [], fonts(), '', state, 0)
      const table = slide.parts.find(p => p.kind === 'table')!
      expect(table.rows[0]![0]!.border[0]).toEqual({type:'solid',color:'808080',pt:1.5})
      expect(state.rasterizedElements).toEqual([])
      expect(state.approximatedElements).toContainEqual(expect.objectContaining({element:'tr',property:'border-top-color'}))
    } finally { svg.remove() }
  })
  it('isolates a generated decoration without rasterizing the heading or slide', async () => {
    const svg = surface('<h1>Editable heading</h1><p>Editable body</p>')
    const heading = svg.querySelector('h1')!, original = getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      if (element === heading && pseudo === '::before') {
        const style = document.createElement('span').style
        style.cssText = 'content:"";display:block;visibility:visible;background-color:rgb(255,0,0);background-image:none;width:200px;height:40px;border:0px solid black'
        return style
      }
      return original(element)
    })
    const paint = vi.spyOn(raster, 'rasterizePseudo').mockResolvedValue({data:png,rect:new DOMRect(20,20,200,40)})
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([new DOMRect(20,60,200,40)] as unknown as DOMRectList)
    const state = report()
    try {
      const slide = await measureSlide(svg, [], fonts(), '', state, 0)
      expect(state.errors).toBeUndefined()
      expect(state.rasterizedElements).toEqual([{slide:1,element:'h1::before',reason:'CSS pseudo-element decoration'}])
      expect(paint).toHaveBeenCalledOnce()
      expect(slide.parts.map(p => p.kind)).toEqual(['image','text','text'])
      expect(state.rasterizedElements).toEqual([{slide:1,element:'h1::before',reason:'CSS pseudo-element decoration'}])
      expect(JSON.stringify(slide)).toContain('Editable heading')
      expect(JSON.stringify(slide)).toContain('Editable body')
    } finally { svg.remove() }
  })
  it('settles intrinsic image geometry before deciding that its box is empty', async () => {
    const host = document.createElement('div'), image = document.createElement('img')
    image.src = 'https://example.test/image.png'
    host.append(image); document.body.append(host)
    let decoded = false
    Object.defineProperty(image, 'getBoundingClientRect', { value: () => decoded ? new DOMRect(0,0,100,40) : new DOMRect() })
    Object.defineProperty(image, 'decode', { value: async () => { decoded = true } })
    const resolver = vi.fn(async () => png)
    try { await inlineImages(host, resolver); expect(resolver).toHaveBeenCalledOnce(); expect(image.src).toBe(png) }
    finally { host.remove() }
  })
  it('keeps a visible descendant whose paragraph has visibility:hidden', async () => {
    const svg = surface('<p style="visibility:hidden">HIDDEN<span style="visibility:visible">Painted child</span></p><p>Unaffected</p>')
    const state = report()
    vi.spyOn(raster, 'rasterize').mockResolvedValue(png)
    try {
      const slide = await measureSlide(svg, [], fonts(), '', state, 0)
      expect(slide.parts[0]?.kind).toBe('image')
      expect(state.rasterizedElements[0]?.reason).toContain('Visible descendants')
      expect(JSON.stringify(slide)).toContain('Unaffected')
    } finally { svg.remove() }
  })
  it('rolls back borders already added when text style resolution fails', async () => {
    const svg = surface('<p style="font-family:Unresolved;border-left:2px solid rgb(0,0,0)">Fallback</p><p>Unaffected</p>')
    vi.spyOn(raster, 'rasterize').mockResolvedValue(png)
    const state = report()
    try {
      const slide = await measureSlide(svg, [], fonts(), '', state, 0)
      expect(slide.parts.some(p => p.kind === 'line')).toBe(false)
      expect(state.rasterizedElements[0]?.reason).toContain('Unresolved font family')
      expect(JSON.stringify(slide)).toContain('Unaffected')
    } finally { svg.remove() }
  })
  it('continues native content after a background image fails', async () => {
    const svg = surface('<p>Unaffected content</p>')
    svg.querySelector('section')!.style.backgroundImage = 'linear-gradient(red,blue)'
    vi.spyOn(raster, 'rasterize').mockRejectedValue(new Error('Background canvas failure'))
    const state = report()
    try {
      const slide = await measureSlide(svg, [], fonts(), '', state, 0)
      expect(state.errors?.[0]).toMatchObject({slide:1,element:'section background'})
      expect(JSON.stringify(slide)).toContain('Unaffected content')
    } finally { svg.remove() }
  })
  it.each([false, true])('isolates unexpected measured geometry (raster also fails: %s) and exports the next slide', async rasterFails => {
    const svg = surface('<p style="border-left:2px solid rgb(0,0,0)">Broken measurement</p><p>Unaffected</p>')
    const next = surface('<p>Next slide</p>')
    const state = report()
    setRect(svg.querySelector('p')!, new DOMRect(NaN, 0, 100, 40))
    vi.spyOn(raster, 'rasterBounds').mockReturnValue(new DOMRect(0, 0, 100, 40))
    const rasterSpy = vi.spyOn(raster, 'rasterize')
    if (rasterFails) rasterSpy.mockRejectedValue(new Error('Canvas unavailable'))
    else rasterSpy.mockResolvedValue(png)
    try {
      const slides = [await measureSlide(svg, [], fonts(), '', state, 0), await measureSlide(next, [], fonts(), '', state, 1)]
      expect(JSON.stringify(slides)).toContain('Unaffected')
      expect(JSON.stringify(slides)).toContain('Next slide')
      expect(slides[0]!.parts.some(part => part.kind === 'line')).toBe(false) // Roll back partial native shapes.
      if (rasterFails) {
        expect(state.errors?.[0]).toMatchObject({slide:1,element:'p'})
        expect(state.warnings.join(' ')).toContain('Canvas unavailable')
      } else {
        expect(state.rasterizedElements[0]?.reason).toContain('Invalid measured')
        expect(slides[0]!.parts[0]?.kind).toBe('image')
      }
      const zip = await JSZip.loadAsync(await generatePptx(slides))
      expect(await zip.file('ppt/slides/slide2.xml')!.async('string')).toContain('Next slide')
    } finally { svg.remove(); next.remove() }
  })
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
      expect(collectRuns(host.querySelector('pre')!, fonts()).map(run => run.text).join('')).toBe('  x\n    y')
      const runs = collectRuns(host.querySelector('p')!, fonts())
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
      const runs = collectRuns(host, fonts())
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
    try { expect(collectRuns(host.querySelector('p')!, fonts())[0]!.style.hyperlinkSlide).toBe(2) }
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
      setRect(li, rect)
      return rect
    })
    setRect(list, new DOMRect(78, 238, 1123, 185))
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      const li = this.startContainer.parentElement!.closest('li')!
      return [positions[[...list.querySelectorAll('li')].indexOf(li)]!] as unknown as DOMRectList
    })
    try {
      const measured = measureList(list, new DOMRect(), fonts())
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
    setRect(list, new DOMRect(78, 200, 1123, 44))
    for (const el of list.querySelectorAll('li,p')) {
      const text = el.textContent!
      const hidden = text.includes('HIDDEN_')
      const emptyParagraph = el.tagName === 'P' && text === 'EMPTY_TEXT_RECT'
      setRect(el, new DOMRect(136, 200,
        hidden || emptyParagraph || text === 'ZERO_WIDTH' ? 0 : 200, hidden || text === 'ZERO_HEIGHT' ? 0 : 44))
    }
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      const text = this.startContainer.textContent!
      return [text === 'EMPTY_TEXT_RECT' ? new DOMRect(136, 200, 0, 44) :
        text.includes('HIDDEN_') ? new DOMRect() : new DOMRect(136, 200, 200, 44)] as unknown as DOMRectList
    })
    try {
      const measured = measureList(list, new DOMRect(), fonts())
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
    setRect(svg, rect)
    setRect(svg.querySelector('section')!, rect)
    const report: ExportReport = { slideCount: 1, rasterizedCount: 0, rasterizedElements: [], substitutedFonts: [], warnings: [] }
    try {
      const measured = await measureSlide(svg, [], fonts(), '', report, 0)
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
    setRect(table, new DOMRect(78, 200, 59, 112))
    for (const [i, row] of [...table.rows].entries()) {
      const rect = new DOMRect(78, 200 + i * 56, 59, 56)
      setRect(row, rect)
      setRect(row.cells[0]!, rect)
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
