// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Marp } from '@marp-team/marp-core'
import JSZip from 'jszip'
import { straightPath, measureSvg } from './svg'
import { svgHtmlAllowlist } from './svgAllowlist'
import { boxRadius, nativeBox, rasterBox } from './paint'
import { collectRuns, measureSlide } from './measure'
import { generatePptx } from './generate'
import { type ExportReport, type MeasuredSlide } from './model'
import * as raster from './raster'

const fonts = new Map([['Arial', 'Arial']])
const origin = new DOMRect(0, 0, 1280, 720)
const report = (): ExportReport => ({ slideCount: 1, rasterizedCount: 0, rasterizedElements: [], substitutedFonts: [], warnings: [] })
beforeEach(() => {
  document.head.innerHTML = '<style>body{font:16px Arial;color:rgb(0,0,0);line-height:normal;text-align:left}*{letter-spacing:0px;background-color:transparent;background-image:none;padding:0;border:0 solid rgb(0,0,0);border-radius:0px;list-style-image:none;background-clip:border-box;outline-style:none;box-shadow:none;border-image-source:none}svg *{fill:rgb(255,255,255);stroke:none;stroke-width:1px;fill-opacity:1;stroke-opacity:1;stroke-dasharray:none;stroke-dashoffset:0px;marker-start:none;marker-mid:none;marker-end:none;opacity:1}</style>'
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20, 30, 200, 80))
})
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; document.head.innerHTML = '' })
function graphic(html: string): SVGSVGElement {
  const host = document.createElement('div'); host.innerHTML = html; document.body.append(host)
  const svg = host.querySelector('svg')!
  for (const el of svg.querySelectorAll('rect,text,path,g')) {
    Object.defineProperty(el, 'getScreenCTM', { value: () => ({ a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 }) })
    if (el.localName === 'rect') {
      for (const name of ['x', 'y', 'width', 'height', 'rx', 'ry']) Object.defineProperty(el, name, { value: { baseVal: { value: Number(el.getAttribute(name) ?? 0) } } })
      // happy-dom returns an empty getBBox(), even for a nonempty rectangle.
      // Supply the local geometry a browser reports; getScreenCTM scales it later.
      const rect = el as SVGRectElement
      vi.spyOn(rect, 'getBBox').mockImplementation(() => new DOMRect(rect.x.baseVal.value, rect.y.baseVal.value, rect.width.baseVal.value, rect.height.baseVal.value))
    }
  }
  return svg
}
describe('editable diagram parity', () => {
  it('tokenizes repeated absolute straight segments and exponents', () => {
    expect(straightPath('M1e1,20 30,40 H50 V10 L20 0')).toEqual([
      {from:{x:10,y:20},to:{x:30,y:40}}, {from:{x:30,y:40},to:{x:50,y:40}},
      {from:{x:50,y:40},to:{x:50,y:10}}, {from:{x:50,y:10},to:{x:20,y:0}},
    ])
  })
  it.each(['M0 0 C10 0 10 20 20 20', 'm0 0 l10 0', 'M0 0 L', 'M0 0 @ L3 4', 'H4'])('rejects unrepresentable or malformed paths: %s', d => expect(() => straightPath(d)).toThrow())
  it('scales round rectangles and keeps reverse line directions', async () => {
    const svg = graphic('<svg><g><rect x="20" y="30" width="100" height="40" rx="8" style="fill:rgb(240,240,240);stroke:rgb(68,68,68);stroke-width:2px"/><path d="M100 100 H20 V30" style="fill:none;stroke:rgb(68,68,68)"/></g></svg>')
    const parts = measureSvg(svg, origin, fonts)
    expect(parts[0]).toMatchObject({kind:'box',rect:{x:50,y:80,width:200,height:80},radius:16,line:{width:3}})
    expect(parts[1]).toMatchObject({kind:'line',x:50,y:220,width:160,height:0,flipH:true})
    expect(parts[2]).toMatchObject({kind:'line',x:50,y:80,width:0,height:140,flipV:true})
    const model: MeasuredSlide = {width:1280,height:720,background:'FFFFFF',parts,notes:[]}
    const zip = await JSZip.loadAsync(await generatePptx([model]))
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(xml).toContain('prst="roundRect"'); expect(xml).toContain('flipH="1"'); expect(xml).toContain('flipV="1"')
    expect(Object.keys(zip.files).filter(path => path.startsWith('ppt/media/') && !zip.files[path]!.dir)).toEqual([])
  })
  it('rolls back the entire unsupported SVG without losing neighboring text', async () => {
    const inner = graphic('<svg><rect width="100" height="40"/><circle cx="50" cy="20" r="10"/></svg>')
    const outer = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), foreign = document.createElementNS(outer.namespaceURI, 'foreignObject'), section = document.createElement('section')
    section.innerHTML = '<h1>Editable neighbor</h1>'; section.append(inner); foreign.append(section); outer.append(foreign); document.body.append(outer)
    Object.defineProperty(outer, 'viewBox', {value:{baseVal:{width:1280,height:720}}}); vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue(origin)
    vi.spyOn(raster, 'rasterize').mockResolvedValue('data:image/png;base64,AA==')
    const state = report(), slide = await measureSlide(outer, [], fonts, '', state, 0)
    expect(slide.parts.map(p => p.kind)).toEqual(['text', 'image'])
    expect(state.rasterizedElements).toEqual([{slide:1,element:'svg',reason:'Unsupported SVG element: circle'}])
  })
  it('rejects CSS rectangle geometry that differs from SVG attributes', () => {
    const svg = graphic('<svg><rect x="20" y="30" width="100" height="40" style="width:120px"/></svg>')
    vi.mocked(svg.querySelector('rect')!.getBBox).mockReturnValue(new DOMRect(20, 30, 120, 40))
    expect(() => measureSvg(svg, origin, fonts)).toThrow('Unsupported SVG CSS rectangle geometry')
  })
  it('reports the reference-compatible SVG dash preset approximation', () => {
    const svg = graphic('<svg><path d="M10 10 H100" style="fill:none;stroke:rgb(68,68,68);stroke-dasharray:6px 4px"/></svg>')
    const approximations: import('./styles').StyleApproximation[] = []
    expect(measureSvg(svg, origin, fonts, approximations)).toMatchObject([{ kind: 'line', dash: true }])
    expect(approximations).toEqual([{ property: 'stroke-dasharray', value: '6px 4px', replacement: 'PowerPoint dash preset (reference-compatible 6 4 pattern)' }])
  })
  it('reports tiny SVG text-bearing overflow but rejects substantial clipping', () => {
    const svg = graphic('<svg style="overflow-x:hidden;overflow-y:hidden"><text style="white-space:normal;text-transform:none">Edge</text></svg>'), text = svg.querySelector('text')!
    Object.defineProperty(svg, 'getBoundingClientRect', {value:vi.fn(()=>new DOMRect(0,0,200,100))})
    Object.defineProperty(text, 'getBoundingClientRect', {value:vi.fn(()=>new DOMRect(-2,10,30,20))})
    Object.defineProperty(text, 'getBBox', {value:()=>new DOMRect(0,0,30,20)})
    for (const name of ['x','y']) Object.defineProperty(text, name, {value:{baseVal:{numberOfItems:1}}})
    const approximations: import('./styles').StyleApproximation[] = []
    expect(measureSvg(svg, origin, fonts, approximations)[0]?.kind).toBe('text')
    expect(approximations).toContainEqual(expect.objectContaining({property:'overflow',replacement:expect.stringContaining('at most 3')}))
    vi.mocked(text.getBoundingClientRect).mockReturnValue(new DOMRect(-4,10,30,20))
    expect(() => measureSvg(svg, origin, fonts)).toThrow('clips content')
  })
  it('uses uniform circular CSS corners and falls back for asymmetric/elliptical ones', () => {
    const el = document.createElement('div'); el.style.cssText = 'background-color:rgb(240,240,240);border:2px solid rgb(68,68,68);border-radius:12px'; document.body.append(el)
    expect(boxRadius(getComputedStyle(el))).toBe(12); expect(rasterBox(getComputedStyle(el))).toBe(false)
    expect(nativeBox(el, {x:0,y:0,width:200,height:80})).toEqual([{kind:'box',rect:{x:1,y:1,width:198,height:78},radius:11,fill:{color:'F0F0F0',transparency:0},line:{color:'444444',transparency:0,width:1.5}}])
    // happy-dom does not parse elliptical radius syntax; supply computed values.
    const style = getComputedStyle(el), read = style.getPropertyValue.bind(style)
    style.getPropertyValue = property => property === 'border-top-left-radius' ? '8px 12px' : read(property)
    expect(rasterBox(style)).toBe(true)
    style.getPropertyValue = property => property === 'border-top-left-radius' ? '8px' : read(property)
    expect(rasterBox(style)).toBe(true)
  })
  it('preserves consecutive/trailing BRs, trims collapsed spaces after BR and deduplicates paragraph properties', async () => {
    const el = document.createElement('p'); el.innerHTML = ' One <br> Two<br><br>'; document.body.append(el)
    const runs = collectRuns(el, fonts)
    expect(runs.map(r => r.text).join('')).toBe('One\nTwo\n\n')
    const bytes = await generatePptx([{width:1280,height:720,background:'FFFFFF',notes:[],parts:[{kind:'text',paragraph:{rect:{x:0,y:0,width:300,height:100},runs,align:'left',lineHeight:24,spaceBefore:0,spaceAfter:0,padding:[0,0,0,0]}}]}])
    const xml = await (await JSZip.loadAsync(bytes)).file('ppt/slides/slide1.xml')!.async('string')
    expect(xml.match(/<a:pPr\b/g)).toHaveLength(1); expect(xml.match(/<a:br\/>/g)).toHaveLength(3)
    expect(xml).toContain('<a:ln><a:noFill/></a:ln>')
  })
  it('allows diagram primitives without admitting arbitrary HTML or SVG script/event/URL hooks', () => {
    const marp = new Marp({script:false,html:svgHtmlAllowlist})
    const html = marp.render('<svg viewBox="0 0 200 100" onload="alert(1)"><rect width="20" height="10" onclick="alert(1)"/><script>alert(1)</script><use href="https://example.com/x.svg#x"/></svg>').html
    expect(html).toContain('<rect'); expect(html).not.toContain('onload='); expect(html).not.toContain('onclick='); expect(html).not.toContain('<script>'); expect(html).not.toContain('<use ')
  })
})
