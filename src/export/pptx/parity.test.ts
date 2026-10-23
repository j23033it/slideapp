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
  it.each([
    ['position:relative;left:40px', 'CSS inline/nested positioning'],
    ['position:absolute;left:40px', 'CSS inline/nested positioning'],
    ['position:fixed;top:40px', 'CSS inline/nested positioning'],
    ['float:right', 'CSS inline/nested positioning'],
    ['transform:translateX(40px)', 'CSS transform'],
    ['translate:40px', 'Unsupported CSS translate'],
    ['margin-top:20px', 'CSS inline margin layout'],
  ])('rasterizes mixed wrapper fragments with nested %s and reports the reason', async (css, reason) => {
    const outer = graphic(`<svg><foreignObject><section><div><p>Earlier block</p>before <span style="display:inline;margin:0"><span style="display:inline;margin:0;${css}">moved</span></span><p>Later block</p></div><p>Editable neighbor</p></section></foreignObject></svg>`)
    Object.defineProperty(outer, 'viewBox', {value:{baseVal:{width:1280,height:720}}})
    vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue(origin)
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20,30,200,20))
    // happy-dom exposes float through getPropertyValue, but lacks cssFloat.
    if (css === 'float:right') {
      const original = getComputedStyle
      vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
        const style = original(element, pseudo)
        return new Proxy(style, {get: (target, property) => {
          if (property === 'cssFloat') return target.getPropertyValue('float')
          const value = Reflect.get(target, property, target)
          return typeof value === 'function' ? value.bind(target) : value
        }})
      })
    }
    const paint = vi.spyOn(raster, 'rasterize').mockResolvedValue('data:image/png;base64,AA==')
    const state = report(), slide = await measureSlide(outer, [], fonts, '', state, 0)
    expect(slide.parts.map(p => p.kind)).toEqual(['image', 'text'])
    expect(slide.parts[1]).toMatchObject({paragraph:{runs:[{text:'Editable neighbor'}]}})
    expect(paint).toHaveBeenCalledOnce()
    expect(paint.mock.calls[0]![0]).toBe(outer.querySelector('div'))
    expect(state.rasterizedElements).toEqual([{slide:1,element:'div',reason:expect.stringContaining(reason)}])
    expect(state.errors).toBeUndefined()
  })
  it.each(['block', 'flex', 'grid'])('keeps ordinary %s wrapper fragments native and measures positioned block children independently', async display => {
    const outer = graphic(`<svg><foreignObject><section><div style="display:${display}">before <span style="display:inline;margin:0;font-weight:bold">emphasis</span><p style="position:relative;left:40px">Block</p>after <span style="display:inline;margin:0">tail</span></div></section></foreignObject></svg>`)
    Object.defineProperty(outer, 'viewBox', {value:{baseVal:{width:1280,height:720}}})
    vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue(origin)
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(20,30,200,20))
    const state = report(), slide = await measureSlide(outer, [], fonts, '', state, 0)
    expect(slide.parts.map(p => p.kind)).toEqual(['text', 'text', 'text'])
    expect(slide.parts.flatMap(p => p.kind === 'text' ? [p.paragraph.runs.map(r => r.text).join('')] : [])).toEqual(['before emphasis', 'Block', 'after tail'])
    expect(slide.parts[0]).toMatchObject({paragraph:{runs:[{text:'before '},{text:'emphasis',style:{bold:true}}]}})
    expect(state.rasterizedElements).toEqual([])
    expect(state.errors).toBeUndefined()
  })
  it.each([
    ['CSS d', '<path d="M10 10 H100" style="d:path(\'M10 10 V100\');fill:none;stroke:rgb(255,0,0)"/>', 'CSS path geometry'],
    ['hidden marker', '<defs><marker id="arrow" viewBox="0 0 10 10" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="display:none"/></marker></defs><path d="M10 10 H100" style="fill:none;stroke:rgb(255,0,0);marker-end:url(#arrow)"/>', 'hidden marker content'],
    ['attribute marker transform', '<defs><marker id="arrow" viewBox="0 0 10 10" orient="auto"><path d="M0,0 L10,5 L0,10 z" transform="scale(.3)"/></marker></defs><path d="M10 10 H100" style="fill:none;stroke:rgb(255,0,0);marker-end:url(#arrow)"/>', 'marker transform'],
    ['CSS marker transform', '<defs><marker id="arrow" viewBox="0 0 10 10" orient="auto"><path d="M0,0 L10,5 L0,10 z" style="transform:scale(.3)"/></marker></defs><path d="M10 10 H100" style="fill:none;stroke:rgb(255,0,0);marker-end:url(#arrow)"/>', 'marker transform'],
    ['round caps', '<path d="M10 10 H100 V50" style="fill:none;stroke:rgb(255,0,0);stroke-width:40px;stroke-linecap:round"/>', 'stroke-linecap/linejoin'],
    ['unsupported joins', '<path d="M10 10 H100 V50" style="fill:none;stroke:rgb(255,0,0);stroke-width:40px;stroke-linejoin:miter-clip"/>', 'stroke-linecap/linejoin'],
    ['start markers', '<path d="M10 10 H100 M40 20 V50" style="fill:none;stroke:rgb(255,0,0);marker-start:url(#arrow)"/>', 'start/mid marker'],
    ['mid markers', '<path d="M10 10 H100 V50 M40 20 V50" style="fill:none;stroke:rgb(255,0,0);marker-mid:url(#arrow)"/>', 'start/mid marker'],
  ])('atomically rasterizes %s and keeps neighboring text editable', async (_name, children, reason) => {
    const inner = graphic(`<svg>${children}</svg>`)
    const outer = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), foreign = document.createElementNS(outer.namespaceURI, 'foreignObject'), section = document.createElement('section')
    section.innerHTML = '<p>Editable neighbor</p>'; section.append(inner); foreign.append(section); outer.append(foreign); document.body.append(outer)
    Object.defineProperty(outer, 'viewBox', {value:{baseVal:{width:1280,height:720}}}); vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue(origin)
    vi.spyOn(raster, 'rasterize').mockResolvedValue('data:image/png;base64,AA==')
    const state = report(), slide = await measureSlide(outer, [], fonts, '', state, 0)
    expect(slide.parts.map(p => p.kind)).toEqual(['text', 'image'])
    expect(state.rasterizedElements).toEqual([{slide:1,element:'svg',reason:expect.stringContaining(reason)}])
    expect(state.errors).toBeUndefined()
  })
  it('accepts a computed path matching its attribute after CSS serialization', () => {
    const svg = graphic('<svg><path d="M10,10 H100" style="d:path(\'M 10 10 H 100\');fill:none;stroke:rgb(255,0,0)"/></svg>')
    expect(measureSvg(svg, origin, fonts)).toHaveLength(1)
  })
  it.each([
    ['overlapping closed subpaths', 'M100 100 H300 V300 H100 Z M200 100 H400 V300 H200 Z', 'stroke:rgb(255,0,0);stroke-opacity:.5'],
    ['mixed closed/open subpaths', 'M100 100 H300 V300 H100 Z M200 100 H400 V300', 'stroke:rgb(255,0,0);stroke-opacity:.5'],
    ['overlapping straight subpaths', 'M100 100 H300 M200 100 H400', 'stroke:rgb(255,0,0);stroke-opacity:.5'],
    ['stroke color alpha', 'M100 100 H300 V300 H100 Z M200 100 H400 V300 H200 Z', 'stroke:rgba(255,0,0,.5)'],
  ])('rasterizes %s atomically to preserve one path stroke compositing', async (_name, d, css) => {
    const inner = graphic(`<svg><rect width="20" height="20"/><path d="${d}" style="fill:none;stroke-width:24px;${css}"/></svg>`)
    const outer = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), foreign = document.createElementNS(outer.namespaceURI, 'foreignObject'), section = document.createElement('section')
    section.innerHTML = '<p>Editable neighbor</p>'; section.append(inner); foreign.append(section); outer.append(foreign); document.body.append(outer)
    Object.defineProperty(outer, 'viewBox', {value:{baseVal:{width:1280,height:720}}}); vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue(origin)
    const capture = vi.spyOn(raster, 'rasterize').mockResolvedValue('data:image/png;base64,AA==')
    const state = report(), slide = await measureSlide(outer, [], fonts, '', state, 0)
    expect(slide.parts.map(p => p.kind)).toEqual(['text', 'image'])
    expect(capture).toHaveBeenCalledOnce()
    expect(capture.mock.calls[0]![0]).toBe(inner)
    expect(state.rasterizedElements).toEqual([{slide:1,element:'svg',reason:expect.stringContaining('translucent multi-subpath stroke')}])
    expect(state.errors).toBeUndefined()
  })
  it.each([
    ['closed', 'M100 100 H300 V300 H100 Z', 'M200 100 H400 V300 H200 Z', 'path', 'custGeom'],
    ['straight', 'M100 100 H300', 'M200 100 H400', 'line', 'prstGeom'],
  ])('keeps separate translucent %s path elements native with independent alpha', async (_name, first, second, kind, geometry) => {
    const path = (d: string) => `<path d="${d}" style="fill:none;stroke:rgb(255,0,0);stroke-width:24px;stroke-opacity:.5"/>`
    const parts = measureSvg(graphic(`<svg>${path(first)}${path(second)}</svg>`), origin, fonts)
    expect(parts.map(p => p.kind)).toEqual([kind, kind])
    const zip = await JSZip.loadAsync(await generatePptx([{width:1280,height:720,background:'FFFFFF',parts,notes:[]}]))
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(xml.match(new RegExp(`<a:${geometry}\\b`, 'g'))).toHaveLength(2)
    expect(xml.match(/<a:alpha val="50000"\/>/g)).toHaveLength(2)
    expect(xml).not.toContain('<p:pic>')
  })
  it('detects clipping from a stroke even when its geometry fits the viewport', () => {
    const svg = graphic('<svg style="overflow-x:hidden;overflow-y:hidden"><rect x="0" y="0" width="300" height="200" style="fill:none;stroke:rgb(255,0,0);stroke-width:40px"/></svg>')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(10,20,600,400))
    expect(() => measureSvg(svg, origin, fonts)).toThrow('stroke/marker paint clips content')
    svg.querySelector('rect')!.style.stroke = 'none'
    expect(measureSvg(svg, origin, fonts)).toHaveLength(1)
  })
  it('retains exact visible border strips for a clipped opaque square hairline', () => {
    const svg = graphic('<svg style="overflow-x:hidden;overflow-y:hidden"><rect width="100" height="50" style="fill:rgb(255,255,255);stroke:rgb(68,68,68);stroke-width:1px"/></svg>')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(10,20,200,100))
    const parts = measureSvg(svg, origin, fonts)
    expect(parts).toHaveLength(5)
    expect(parts).toEqual([
      {kind:'box',rect:{x:10,y:20,width:200,height:100},fill:{color:'FFFFFF',transparency:0}},
      {kind:'line',x:10,y:20.5,width:200,height:0,color:'444444',transparency:0,points:.75},
      {kind:'line',x:10,y:119.5,width:200,height:0,color:'444444',transparency:0,points:.75},
      {kind:'line',x:10.5,y:20,width:0,height:100,color:'444444',transparency:0,points:.75},
      {kind:'line',x:209.5,y:20,width:0,height:100,color:'444444',transparency:0,points:.75},
    ])
    svg.querySelector('rect')!.style.strokeOpacity = '.5'
    expect(() => measureSvg(svg, origin, fonts)).toThrow('paint clips content')
  })
  it.each(['round','bevel'])('rejects clipped %s rectangle joins instead of treating them as miter strips', join => {
    const svg = graphic(`<svg style="overflow-x:hidden;overflow-y:hidden"><rect width="100" height="50" style="stroke:rgb(68,68,68);stroke-width:1px;stroke-linejoin:${join}"/></svg>`)
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(10,20,200,100))
    expect(() => measureSvg(svg, origin, fonts)).toThrow('paint clips content')
  })
  it('detects a clipped arrow even when its stroked line fits the viewport', () => {
    const svg = graphic('<svg style="overflow-x:hidden;overflow-y:hidden"><defs><marker id="arrow" viewBox="0 0 10 10" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs><path d="M20 40 H90" style="fill:none;stroke:rgb(255,0,0);stroke-width:3px;marker-end:url(#arrow)"/></svg>')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(10,20,200,160))
    const marker = svg.querySelector('marker')!
    marker.querySelector('path')!.style.setProperty('d', 'path("M 0 0 L 10 5 L 0 10 Z")')
    for (const [name,value] of [['markerWidth',20],['markerHeight',20],['refX',0],['refY',5]] as const) Object.defineProperty(marker, name, {value:{baseVal:{value}}})
    expect(() => measureSvg(svg, origin, fonts)).toThrow('stroke/marker paint clips content')
    svg.querySelector<SVGPathElement>(':scope > path')!.style.markerEnd = 'none'
    expect(measureSvg(svg, origin, fonts)).toHaveLength(1)
  })
  it('tokenizes repeated absolute straight segments and exponents', () => {
    expect(straightPath('M1e1,20 30,40 H50 V10 L20 0')).toEqual([
      {from:{x:10,y:20},to:{x:30,y:40}}, {from:{x:30,y:40},to:{x:50,y:40}},
      {from:{x:50,y:40},to:{x:50,y:10}}, {from:{x:50,y:10},to:{x:20,y:0}},
    ])
  })
  it.each(['Z', 'z'])('closes %s to its own subpath start without joining separate moves', close => {
    expect(straightPath(`M10 10 H40 V30 ${close} M70 20 H90`)).toEqual([
      {from:{x:10,y:10},to:{x:40,y:10}}, {from:{x:40,y:10},to:{x:40,y:30}},
      {from:{x:40,y:30},to:{x:10,y:10}}, {from:{x:70,y:20},to:{x:90,y:20}},
    ])
  })
  it.each(['M0 0 C10 0 10 20 20 20', 'm0 0 l10 0', 'M0 0 L', 'M0 0 @ L3 4', 'H4', 'Z', 'M0 0 L10 0 Z 20 20'])('rejects unrepresentable or malformed paths: %s', d => expect(() => straightPath(d)).toThrow())
  it('scales round rectangles and keeps reverse line directions', async () => {
    const svg = graphic('<svg><g><rect x="20" y="30" width="100" height="40" rx="8" style="fill:rgb(240,240,240);stroke:rgb(68,68,68);stroke-width:2px"/><path d="M100 100 H20 M20 100 V30" style="fill:none;stroke:rgb(68,68,68)"/></g></svg>')
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
  it.each([
    ['thin 1px', 'M10 10 H50 V80', 'stroke-width:1px', 'miter', 4, false],
    ['thin 2px', 'M10 10 H50 V80', 'stroke-width:2px', 'miter', 4, false],
    ['default miter', 'M40 40 H100 V90', 'stroke-width:20px', 'miter', 4, false],
    ['limited miter', 'M40 40 L100 40 L45 50', 'stroke-width:20px;stroke-miterlimit:1', 'miter', 1, false],
    ['round', 'M40 40 H100 V90', 'stroke-width:20px;stroke-linejoin:round', 'round', 4, false],
    ['bevel', 'M40 40 H100 V90', 'stroke-width:20px;stroke-linejoin:bevel', 'bevel', 4, false],
    ['closed', 'M40 40 H100 V90 Z', 'stroke-width:20px', 'miter', 4, true],
    ['thin closed', 'M40 40 H100 V90 Z', 'stroke-width:1px', 'miter', 4, true],
    ['collinear', 'M100 40 H70 H40', 'stroke-width:2px', 'miter', 4, false],
  ])('keeps %s paths editable with continuous geometry and explicit joins', async (_name, d, css, join, limit, closed) => {
    const inner = graphic(`<svg><rect x="10" y="10" width="20" height="20"/><path d="${d}" style="fill:none;stroke:rgb(255,0,0);${css}"/></svg>`)
    const outer = document.createElementNS('http://www.w3.org/2000/svg', 'svg'), foreign = document.createElementNS(outer.namespaceURI, 'foreignObject'), section = document.createElement('section')
    section.innerHTML = '<p>Editable neighbor</p>'; section.append(inner); foreign.append(section); outer.append(foreign); document.body.append(outer)
    Object.defineProperty(outer, 'viewBox', {value:{baseVal:{width:1280,height:720}}}); vi.spyOn(outer, 'getBoundingClientRect').mockReturnValue(origin)
    const capture = vi.spyOn(raster, 'rasterize').mockResolvedValue('data:image/png;base64,AA==')
    const state = report(), slide = await measureSlide(outer, [], fonts, '', state, 0)
    expect(slide.parts.map(p => p.kind)).toEqual(['text', 'box', 'path'])
    expect(slide.parts[2]).toMatchObject({join,miterLimit:limit,closed})
    expect(capture).not.toHaveBeenCalled()
    expect(state.rasterizedElements).toEqual([])
    expect(state.errors).toBeUndefined()
    const zip = await JSZip.loadAsync(await generatePptx([slide]))
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    const path = xml.match(/<p:sp>.*?SlideApp SVG path.*?<\/p:sp>/s)![0]
    expect(path.match(/<a:moveTo>/g)).toHaveLength(1)
    expect(path.match(/<a:lnTo>/g)).toHaveLength(2)
    expect(path.includes('<a:close />')).toBe(closed)
    expect(path).toContain('cap="flat"')
    expect(path).toContain(join === 'miter' ? `<a:miter lim="${Number(limit)*100000}"/>` : `<a:${join}/>`)
    expect(xml.match(/<a:(?:miter|round|bevel)\b/g)).toHaveLength(1)
    expect(Object.keys(zip.files).filter(path => path.startsWith('ppt/media/') && !zip.files[path]!.dir)).toEqual([])
  })
  it('keeps move boundaries between connected subpaths and preserves reverse coordinates', async () => {
    const parts = measureSvg(graphic('<svg><path d="M100 80 H20 V30 M150 100 V40 H180" style="fill:none;stroke:rgb(68,68,68)"/></svg>'), origin, fonts)
    expect(parts).toMatchObject([
      {kind:'path',points:[{x:210,y:180},{x:50,y:180},{x:50,y:80}]},
      {kind:'path',points:[{x:310,y:220},{x:310,y:100},{x:370,y:100}]},
    ])
    const zip = await JSZip.loadAsync(await generatePptx([{width:1280,height:720,background:'FFFFFF',parts,notes:[]}]))
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(xml.match(/<a:custGeom>/g)).toHaveLength(2)
    expect(xml.match(/<a:moveTo>/g)).toHaveLength(2)
    expect(xml.match(/<a:miter lim="400000"\/>/g)).toHaveLength(2)
  })
  it('checks actual miter paint at a clipped viewport without a blanket miter-limit margin', () => {
    const svg = graphic('<svg style="overflow-x:hidden;overflow-y:hidden"><path d="M10 10 H90 V60" style="fill:none;stroke:rgb(68,68,68);stroke-width:2px"/></svg>')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(10,20,200,160))
    expect(measureSvg(svg, origin, fonts)[0]?.kind).toBe('path')
    svg.querySelector('path')!.setAttribute('d', 'M10 10 H99 V60')
    svg.querySelector('path')!.setAttribute('style', 'fill:none;stroke:rgb(68,68,68);stroke-width:4px')
    expect(() => measureSvg(svg, origin, fonts)).toThrow('SVG stroke/marker paint clips content')
  })
  it('places exactly one end marker at the final vertex of the entire multi-subpath path', async () => {
    const svg = graphic('<svg><defs><marker id="arrow" viewBox="0 0 10 10" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs><path d="M10 10 H40 M70 20 V50" style="fill:none;stroke:rgb(68,68,68);marker-end:url(#arrow)"/></svg>')
    const marker = svg.querySelector('marker')!
    for (const [name,value] of [['markerWidth',10],['markerHeight',10],['refX',10],['refY',5]] as const) Object.defineProperty(marker, name, {value:{baseVal:{value}}})
    const parts = measureSvg(svg, origin, fonts)
    expect(parts.filter(p => p.kind === 'line')).toHaveLength(2)
    const arrows = parts.filter(p => p.kind === 'polygon')
    expect(arrows).toHaveLength(1)
    for (const [i, expected] of [{x:160,y:100},{x:150,y:120},{x:140,y:100}].entries()) {
      expect(arrows[0]!.points[i]!.x).toBeCloseTo(expected.x)
      expect(arrows[0]!.points[i]!.y).toBeCloseTo(expected.y)
    }
    const zip = await JSZip.loadAsync(await generatePptx([{width:1280,height:720,background:'FFFFFF',parts,notes:[]}]))
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(xml.match(/<a:custGeom>/g)).toHaveLength(1)
    expect(Object.keys(zip.files).filter(path => path.startsWith('ppt/media/') && !zip.files[path]!.dir)).toEqual([])
  })
  it('does not invent clipped end markers on earlier subpaths', () => {
    const svg = graphic('<svg style="overflow-x:hidden;overflow-y:hidden"><defs><marker id="arrow" viewBox="0 0 10 10" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs><path d="M10 20 H90 M20 60 H40" style="fill:none;stroke:rgb(68,68,68);marker-end:url(#arrow)"/></svg>')
    vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(10,20,200,160))
    const marker = svg.querySelector('marker')!
    for (const [name,value] of [['markerWidth',20],['markerHeight',20],['refX',0],['refY',5]] as const) Object.defineProperty(marker, name, {value:{baseVal:{value}}})
    expect(measureSvg(svg, origin, fonts).filter(part => part.kind === 'polygon')).toHaveLength(1)
  })
  it('rasterizes an end marker on a final move-only subpath instead of using the previous endpoint', () => {
    const svg = graphic('<svg><defs><marker id="arrow" viewBox="0 0 10 10" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs><path d="M10 10 H40 M70 20" style="fill:none;stroke:rgb(68,68,68);marker-end:url(#arrow)"/></svg>')
    const marker = svg.querySelector('marker')!
    for (const [name,value] of [['markerWidth',10],['markerHeight',10],['refX',10],['refY',5]] as const) Object.defineProperty(marker, name, {value:{baseVal:{value}}})
    expect(() => measureSvg(svg, origin, fonts)).toThrow('SVG marker has no direction')
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
  it('preserves miter limits and start/mid marker attributes for faithful raster fallback', () => {
    const marp = new Marp({script:false,html:svgHtmlAllowlist})
    const html = marp.render('<svg><path d="M10 10 H50 V40" fill="none" stroke="#444" stroke-miterlimit="1" marker-start="url(#arrow)" marker-mid="url(#arrow)"/></svg>').html
    expect(html).toContain('stroke-miterlimit="1"')
    expect(html).toContain('marker-start="url(#arrow)"')
    expect(html).toContain('marker-mid="url(#arrow)"')
  })
})
