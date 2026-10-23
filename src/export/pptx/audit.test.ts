// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { measureSlide } from './measure'
import { generatePptx } from './generate'
import { markerCharacter } from './markers'
import { layoutPaintReason, textPseudoReason } from './cssAudit'
import { nativeStyleReason } from './styles'
import type { ExportReport } from './model'
import * as raster from './raster'

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const fonts = new Map([['Arial', 'Arial'], ['Georgia', 'Georgia']])
const report = (): ExportReport => ({slideCount:1,rasterizedCount:0,rasterizedElements:[],substitutedFonts:[],warnings:[]})
function surface(html: string) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const foreign = document.createElementNS(svg.namespaceURI, 'foreignObject')
  const section = document.createElement('section'); section.innerHTML = html
  foreign.append(section); svg.append(foreign); document.body.append(svg)
  Object.defineProperty(svg, 'viewBox', {value:{baseVal:{width:1280,height:720}}})
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,1280,720))
  return svg
}
beforeEach(() => {
  document.head.innerHTML = `<style>body{font-family:Arial;font-size:16px;font-weight:400;font-style:normal;line-height:normal;color:rgb(0,0,0);text-align:left;list-style-type:disc} *{letter-spacing:0px;background-color:transparent;background-image:none;padding:0;border:0px solid rgb(0,0,0);border-radius:0px;list-style-image:none}strong,span,code,a,em,s,mark{display:inline}li{display:list-item}td,th{vertical-align:top}</style>`
  vi.spyOn(Element.prototype,'getBoundingClientRect').mockReturnValue(new DOMRect(20,30,100,40))
  vi.spyOn(Range.prototype,'getClientRects').mockReturnValue([new DOMRect(20,30,100,40)] as unknown as DOMRectList)
  vi.spyOn(raster,'rasterize').mockResolvedValue(png)
  vi.spyOn(raster,'rasterizeBackground').mockResolvedValue({data:png,rect:new DOMRect(20,30,100,40)})
})
afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML=''; document.head.innerHTML='' })
describe('CSS audit routing', () => {
  it.each(['ul','ol','li','p','h1','blockquote','header','footer','figure'])('preserves a solid %s box beneath editable content', async tag => {
    const content = tag === 'li' ? '<ul><li style="background-color:rgb(34,34,34);color:rgb(255,255,255);border:2px solid rgb(255,0,0)">Editable</li></ul>' : `<${tag} style="background-color:rgb(34,34,34);color:rgb(255,255,255);border:2px solid rgb(255,0,0)">${['ul','ol'].includes(tag)?'<li>Editable</li>':'<p>Editable</p>'}</${tag}>`
    const svg=surface(content), r=report(), slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(r.errors).toBeUndefined()
    expect(r.rasterizedElements).toEqual([])
    const box=slide.parts.findIndex(p=>p.kind==='box' && p.fill.color==='222222')
    const text=slide.parts.findIndex(p=>p.kind==='text'||p.kind==='list')
    expect(box).toBeGreaterThanOrEqual(0); expect(box).toBeLessThan(text)
    expect(slide.parts.some(p=>p.kind==='line')).toBe(true)
    expect(JSON.stringify(slide)).toContain('Editable')
  })
  it.each(['margin-left:20px','display:inline-block;width:80px'])('preserves inline layout via fallback for %s', async css => {
    const svg=surface(`<p>Before <strong style="${css}">middle</strong> after</p>`),r=report()
    const slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(slide.parts.map(p=>p.kind)).toEqual(['image'])
    expect(r.rasterizedElements[0]?.reason).toContain('CSS inline')
  })
  it('does not compact separated table cells into an adjacent native grid', async () => {
    const svg=surface('<table style="border-collapse:separate;border-spacing:20px"><tr><td>A</td><td>B</td></tr></table>'),r=report()
    const slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(slide.parts.map(p=>p.kind)).toEqual(['image'])
    expect(r.rasterizedElements[0]?.reason).toContain('border-spacing')
  })
  it('does not omit column-group backgrounds beneath transparent native cells', async () => {
    const svg=surface('<table><colgroup style="background-color:rgb(34,34,34)"><col></colgroup><tbody><tr><td>Column</td></tr></tbody></table>'),r=report()
    const slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(slide.parts.some(p=>p.kind==='box'&&p.fill.color==='222222')).toBe(true)
    expect(slide.parts.some(p=>p.kind==='table')).toBe(true)
    expect(r.errors).toBeUndefined()
  })
  it('does not double-paint a nested translucent background', async () => {
    const svg=surface('<blockquote style="background-color:rgba(0,0,255,.5)"><p style="background-color:rgba(255,0,0,.5)">Nested fill</p></blockquote>'),r=report()
    const slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(slide.parts.filter(p=>p.kind==='box')).toHaveLength(2)
    expect(slide.parts.map(p=>p.kind)).toEqual(['box','box','text'])
  })
  it('keeps group backgrounds as layers and translucent cell fills on the editable table', async () => {
    const svg=surface('<table><thead style="background-color:rgb(34,34,34)"><tr><th>Heading</th></tr></thead><tbody style="background-color:rgb(240,240,240)"><tr><td style="background-color:rgba(255,0,0,.5)">Cell</td></tr></tbody></table>'),r=report()
    const slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(slide.parts.filter(p=>p.kind==='box')).toHaveLength(2)
    const table=slide.parts.find(p=>p.kind==='table')!
    expect(table.rows[0]![0]!.fill?.transparency).toBe(100)
    expect(table.rows[1]![0]!.fill).toEqual({color:'FF0000',transparency:50})
    expect(r.errors).toBeUndefined()
  })
  it.each(['border-radius:12px','box-shadow:3px 4px 5px black','background-image:linear-gradient(red,blue)'])('keeps complex table cell %s as a separate decoration', async css => {
    const svg=surface(`<table><tbody><tr><td style="background-color:rgb(34,34,34);${css}">Cell</td></tr></tbody></table>`),r=report()
    const slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(slide.parts.map(p=>p.kind)).toEqual(['image','table'])
    const table=slide.parts.find(p=>p.kind==='table')!
    expect(table.rows[0]![0]!.fill?.transparency).toBe(100)
    expect(r.rasterizedElements).toEqual([{slide:1,element:'td background',reason:'CSS background decoration'}])
    expect(r.errors).toBeUndefined()
  })
  it.each(['border-radius:0px 12px','outline:4px dashed red','box-shadow:3px 4px 5px black','background-image:linear-gradient(red,blue)'])('separates %s as decoration only', async css => {
    const svg=surface(`<ul style="background-color:rgb(34,34,34);${css}"><li>Editable</li></ul>`),r=report()
    const slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(slide.parts.map(p=>p.kind)).toEqual(['image','list'])
    expect(r.rasterizedElements).toEqual([{slide:1,element:'ul background',reason:'CSS background decoration'}])
  })
  it.each([['column-count','2'],['column-width','120px'],['text-overflow','ellipsis'],['-webkit-line-clamp','2'],['text-wrap-style','balance'],['word-break','break-all'],['hyphens','auto'],['rotate','15deg'],['scale','2'],['translate','4px'],['font-variation-settings','"wght" 500'],['-webkit-text-stroke-width','2px'],['-webkit-text-fill-color','red']])('routes unrepresented %s:%s to raster', async (property,value) => {
    const svg=surface('<p>Raster text</p><p>Unaffected</p>'),p=svg.querySelector('p')!,base=getComputedStyle
    vi.spyOn(window,'getComputedStyle').mockImplementation((node,pseudo)=>{
      const style=base(node,pseudo)
      if(node!==p||pseudo) return style
      const read=style.getPropertyValue.bind(style)
      return new Proxy(style,{get:(target,key)=>key==='getPropertyValue'?(name:string)=>name===property?value:read(name):Reflect.get(target,key)})
    })
    const r=report(),slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(layoutPaintReason(getComputedStyle(p))).toContain(property)
    expect(r.rasterizedElements.some(e=>e.reason.includes(property))).toBe(true)
    expect(JSON.stringify(slide)).toContain('Unaffected')
  })
  it.each(['::first-letter','::first-line'])('does not ignore styled %s', async pseudo => {
    const svg=surface('<p>Initial line</p>'),p=svg.querySelector('p')!,base=getComputedStyle
    vi.spyOn(window,'getComputedStyle').mockImplementation((node,which)=>{const s=base(node);if(node===p&&which===pseudo){const copy=document.createElement('span').style;copy.cssText=s.cssText;copy.fontSize='48px';return copy}return s})
    expect(textPseudoReason(p)).toContain(pseudo)
    const r=report();await measureSlide(svg,[],fonts,'',r,0)
    expect(r.rasterizedElements[0]?.reason).toContain(pseudo)
  })
  it('classifies irrelevant/default paint as not applicable', () => {
    const el=document.createElement('p');document.body.append(el)
    expect(layoutPaintReason(getComputedStyle(el))).toBeUndefined()
    expect(textPseudoReason(el)).toBeUndefined()
    expect(nativeStyleReason(getComputedStyle(el))).toBeUndefined()
  })
  it('reports a bounded native approximation', async () => {
    const svg=surface('<p style="letter-spacing:.5px">Approximation</p>'),r=report()
    const slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(slide.parts[0]?.kind).toBe('text')
    expect(r.approximatedElements).toContainEqual(expect.objectContaining({property:'letter-spacing',value:'0.5px'}))
  })
  it('captures non-DOM paint order as one composited slide', async () => {
    const svg=surface('<p style="position:absolute;z-index:2">Top</p><p>Back</p>'),r=report()
    const slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(slide.parts.map(p=>p.kind)).toEqual(['image'])
    expect(r.rasterizedElements[0]?.reason).toContain('stacking')
  })
})
describe('CSS marker fidelity', () => {
  it.each([['"✓ "','✓'],['"\\2713 "','✓'],["'X '",'X'],['""',undefined]])('decodes %s', (value, expected)=>expect(markerCharacter(value)).toBe(expected))
  it.each(['"OK "','counter(list-item)','url("x.png")','"😀"'])('rejects content that buChar cannot represent: %s', value=>expect(()=>markerCharacter(value)).toThrow('::marker content'))
  function markerStyle(svg: Element, content: string) {
    const li=svg.querySelector('li')!,base=getComputedStyle
    vi.spyOn(window,'getComputedStyle').mockImplementation((node,pseudo)=>{
      if(node===li&&pseudo==='::marker') {const s=document.createElement('span').style;s.cssText=`content:${content};font-family:Georgia;font-size:24px;color:rgba(0,128,0,.5);font-weight:400;font-style:normal;letter-spacing:0px`;return s}
      return base(node)
    })
  }
  it.each(['disc','none'])('serializes custom glyph, independent marker font, size and alpha with list-style-type:%s', async type => {
    const svg=surface(`<ul style="list-style-type:${type}"><li>Native check</li></ul>`);markerStyle(svg,'"✓ "')
    const r=report(),slide=await measureSlide(svg,[],fonts,'',r,0),list=slide.parts.find(p=>p.kind==='list')!
    expect(r.rasterizedElements).toEqual([])
    expect(list.paragraphs[0]?.list?.marker).toEqual({character:'✓',fontFace:'Georgia',fontSize:24,color:'008000',transparency:50})
    const zip=await JSZip.loadAsync(await generatePptx([slide])),xml=await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(xml).toContain('<a:buChar char="&#x2713;"/>');expect(xml).toContain('<a:buFont typeface="Georgia"/>')
    expect(xml).toContain('<a:buSzPts val="1800"/>');expect(xml).toContain('<a:alpha val="50000"/>')
    expect(xml).toContain('Native check');expect(xml).toMatch(/ indent="-[1-9][0-9]*"/)
  })
  it('rasterizes a multicharacter marker instead of substituting a disc', async () => {
    const svg=surface('<ul><li>Complex marker</li></ul>');markerStyle(svg,'"OK "')
    const r=report(),slide=await measureSlide(svg,[],fonts,'',r,0)
    expect(slide.parts.map(p=>p.kind)).toEqual(['image'])
    expect(r.rasterizedElements[0]?.reason).toContain('::marker content')
  })
})
