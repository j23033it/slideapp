import { cssColor, validatePart, type Paragraph, type Part } from './model'
import { isPainted, paintedState } from './visibility'
import { nativeStyleReason, nativeLetterSpacing, pixels, type StyleApproximation } from './styles'
import { clipsContent } from './cssAudit'

type Point = { x: number; y: number }
type Segment = { from: Point; to: Point }
/** Strict tokenizer: never drop an unknown character or guess a path command. */
export function straightPath(d: string): Segment[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/g) ?? []
  if (d.replace(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?|[\s,]/g, '')) throw new Error('Unsupported SVG path token')
  let index = 0, command = '', previous: Point | undefined
  const segments: Segment[] = []
  const number = () => {
    const value = Number(tokens[index++])
    if (!Number.isFinite(value)) throw new Error('Invalid SVG path coordinate')
    return value
  }
  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index]!)) command = tokens[index++]!
    if (!['M', 'L', 'H', 'V'].includes(command)) throw new Error(`Unsupported SVG path command: ${command}`)
    if (!previous && command !== 'M') throw new Error('SVG path must begin with M')
    const next = command === 'H' ? { x: number(), y: previous!.y } : command === 'V' ? { x: previous!.x, y: number() } : { x: number(), y: number() }
    if (command !== 'M') segments.push({ from: previous!, to: next })
    previous = next
    if (command === 'M') command = 'L'
  }
  if (!previous) throw new Error('Empty SVG path')
  return segments
}

const paint = (value: string) => value === 'none' ? { color: 'FFFFFF', transparency: 100 } : cssColor(value)
function effects(element: Element): void {
  const s = getComputedStyle(element)
  if (element.localName === 'svg' && (paint(s.backgroundColor).transparency < 100 || (s.backgroundImage && s.backgroundImage !== 'none') || ['top','right','bottom','left'].some(side => Number.parseFloat(s.getPropertyValue(`border-${side}-width`)) > 0))) throw new Error('Unsupported SVG CSS box decoration')
  for (const property of ['filter', 'clip-path', 'mask-image', 'mix-blend-mode', 'box-shadow', 'text-shadow', 'rotate', 'scale', 'translate']) {
    const value = s.getPropertyValue(property)
    if (value && !['none', 'normal'].includes(value)) throw new Error(`Unsupported SVG ${property}: ${value}`)
  }
  if (s.opacity && s.opacity !== '1') throw new Error(`Unsupported SVG opacity: ${s.opacity}`)
  for (const attribute of ['clip-path', 'mask', 'filter']) if (element.hasAttribute(attribute)) throw new Error(`Unsupported SVG ${attribute}`)
}

/** Atomic SVG collector. Any unsupported painted child rejects this diagram only. */
export function measureSvg(svg: SVGSVGElement, origin: DOMRect, fonts: Map<string, string>, approximations: StyleApproximation[] = []): Part[] {
  const clipping = clipsContent(svg)
  if (clipping) {
    const viewport = svg.getBoundingClientRect(), style = getComputedStyle(svg)
    const overflow = [...svg.querySelectorAll('rect,text,path,circle,ellipse,line,polygon,polyline,use,image,foreignObject')].filter(el => !el.closest('defs') && isPainted(el)).map(el => {
      const r = el.getBoundingClientRect()
      return {el,x:style.overflowX === 'visible' ? 0 : Math.max(0, viewport.left-r.left, r.right-viewport.right),y:style.overflowY === 'visible' ? 0 : Math.max(0, viewport.top-r.top, r.bottom-viewport.bottom)}
    }).filter(item => item.x > 1 || item.y > 1)
    // The reference keeps tiny glyph bearings outside the SVG viewport. Accept
    // only verified small text overflow; real geometry/large clips stay images.
    if (!overflow.length || overflow.some(item => item.el.localName !== 'text' || Math.max(item.x,item.y) > 3)) throw new Error(`SVG ${clipping}`)
    approximations.push({property:'overflow',value:`${style.overflowX} ${style.overflowY}`,replacement:'Native SVG text bearings outside the viewport by at most 3 CSS pixels (reference-compatible)'})
  }
  const parts: Part[] = []
  const matrixFor = (el: SVGGraphicsElement) => {
    const m = el.getScreenCTM()
    if (!m || ![m.a, m.b, m.c, m.d, m.e, m.f].every(Number.isFinite) || m.a <= 0 || m.d <= 0 || Math.abs(m.b) > .00001 || Math.abs(m.c) > .00001 || Math.abs(m.a - m.d) > .00001) throw new Error('Unsupported SVG rotation, skew or nonuniform scale')
    return m
  }
  const walk = (el: SVGElement): void => {
    if (paintedState(el).subtreeHidden) return
    if (['defs', 'title', 'desc'].includes(el.localName)) return
    effects(el)
    if (el.localName === 'g' || el === svg) { for (const child of el.children) walk(child as SVGElement); return }
    // Horizontal and vertical paths have zero-height/width boxes but still paint.
    if (['hidden', 'collapse'].includes(getComputedStyle(el).visibility)) return
    const s = getComputedStyle(el), m = matrixFor(el as SVGGraphicsElement), scale = m.a
    const point = (p: Point): Point => ({ x: p.x * m.a + m.e - origin.left, y: p.y * m.d + m.f - origin.top })
    const fill = paint(s.fill), stroke = paint(s.stroke)
    fill.transparency = 100 - (100 - fill.transparency) * Number(s.fillOpacity || 1)
    stroke.transparency = 100 - (100 - stroke.transparency) * Number(s.strokeOpacity || 1)
    const strokeWidth = pixels(s.strokeWidth) * scale
    if (s.vectorEffect && s.vectorEffect !== 'none') throw new Error(`Unsupported SVG vector-effect: ${s.vectorEffect}`)
    if (s.paintOrder && !['normal', 'fill stroke markers'].includes(s.paintOrder)) throw new Error(`Unsupported SVG paint-order: ${s.paintOrder}`)
    // Only the reference's 6/4 pattern has an explicit DrawingML dash mapping.
    const dash = !!s.strokeDasharray && s.strokeDasharray !== 'none'
    if (dash && (!/^6(?:px)?[, ]+4(?:px)?$/.test(s.strokeDasharray) || Number.parseFloat(s.strokeDashoffset) !== 0)) throw new Error(`Unsupported SVG stroke-dasharray: ${s.strokeDasharray}`)
    const line = stroke.transparency < 100 && strokeWidth > 0 ? { ...stroke, width: strokeWidth * .75, dashType: dash ? 'dash' as const : undefined } : undefined
    if (line && dash) approximations.push({ property: 'stroke-dasharray', value: s.strokeDasharray, replacement: 'PowerPoint dash preset (reference-compatible 6 4 pattern)' })
    if (el.localName === 'rect') {
      const rect = el as SVGRectElement
      const x = rect.x.baseVal.value, y = rect.y.baseVal.value, width = rect.width.baseVal.value, height = rect.height.baseVal.value
      const rx = rect.rx.baseVal.value, ry = rect.ry.baseVal.value
      if (typeof rect.getBBox === 'function') {
        const bounds = rect.getBBox()
        if ([bounds.x-x,bounds.y-y,bounds.width-width,bounds.height-height].some(value => Math.abs(value) > .01)) throw new Error('Unsupported SVG CSS rectangle geometry')
      }
      for (const [property,value] of [['rx',rx],['ry',ry]] as const) {
        const computed = s.getPropertyValue(property)
        if (computed && computed !== 'auto' && (!/^\d+(?:\.\d+)?px$/.test(computed) || Math.abs(pixels(computed)-value) > .01)) throw new Error(`Unsupported SVG CSS ${property}: ${computed}`)
      }
      // SVG's omitted ry inherits rx; browser DOM baseVal keeps it at zero.
      const radius = el.hasAttribute('ry') ? ry : rx
      if (el.hasAttribute('rx') && el.hasAttribute('ry') && rx !== ry) throw new Error('Unsupported SVG elliptical radius')
      if (width <= 0 || height <= 0) return
      parts.push({ kind: 'box', rect: { ...point({ x, y }), width: width * scale, height: height * scale }, fill,
        radius: Math.min(radius, width / 2, height / 2) * scale, line })
    } else if (el.localName === 'text') {
      if (el.children.length || ['rotate', 'textLength', 'lengthAdjust', 'dx', 'dy'].some(attr => el.hasAttribute(attr)) || (el as SVGTextElement).x.baseVal.numberOfItems > 1 || (el as SVGTextElement).y.baseVal.numberOfItems > 1) throw new Error('Unsupported SVG positioned text runs')
      if (line) throw new Error('Unsupported SVG text stroke')
      const unsupported = nativeStyleReason(s, 'text', true)
      if (unsupported) throw new Error(unsupported)
      if (!['normal', 'nowrap'].includes(s.whiteSpace) || (s.textTransform && s.textTransform !== 'none')) throw new Error('Unsupported SVG text whitespace/transform')
      const fontFace = fonts.get(s.fontFamily)
      if (!fontFace) throw new Error(`Unresolved SVG font: ${s.fontFamily}`)
      const bounds = (el as SVGTextElement).getBBox()
      if (!el.textContent?.trim() || !bounds.width || !bounds.height) return
      const paragraph: Paragraph = { rect: { ...point(bounds), width: bounds.width * scale, height: bounds.height * scale },
        runs: [{ text: el.textContent.replace(/[\t\r\n ]+/g, ' ').trim(), style: { fontFace, fontSize: pixels(s.fontSize) * scale, ...fill,
          bold: Number(s.fontWeight) >= 600, italic: s.fontStyle === 'italic', underline: s.textDecorationLine.includes('underline'), strike: s.textDecorationLine.includes('line-through'), letterSpacing: nativeLetterSpacing(s) * scale } }],
        align: 'left', valign: 'middle', sizeTolerance: [2, 0], wrap: false, lineHeight: bounds.height * scale, spaceBefore: 0, spaceAfter: 0, padding: [0, 0, 0, 0] }
      parts.push({ kind: 'text', paragraph })
    } else if (el.localName === 'path') {
      if (fill.transparency < 100) throw new Error('Unsupported SVG filled path')
      if (s.markerStart !== 'none' || s.markerMid !== 'none') throw new Error('Unsupported SVG start/mid marker')
      const segments = straightPath(el.getAttribute('d') ?? '').map(segment => ({ from: point(segment.from), to: point(segment.to) }))
      if (line) for (const { from, to } of segments) {
        if (from.x === to.x && from.y === to.y) continue
        parts.push({ kind: 'line', x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y),
          flipH: to.x < from.x, flipV: to.y < from.y, color: stroke.color, transparency: stroke.transparency, points: strokeWidth * .75, dash })
      }
      if (s.markerEnd && s.markerEnd !== 'none' && segments.length) {
        const urlText = /^url\(["']?([^"')]+)["']?\)$/.exec(s.markerEnd)?.[1]
        const target = urlText ? new URL(urlText, document.baseURI) : undefined, current = new URL(document.baseURI)
        if (!target || !target.hash) throw new Error('Unsupported SVG marker URL')
        target.hash = ''; current.hash = ''
        if (target.href !== current.href) throw new Error('Unsupported external SVG marker')
        const id = /#([^"')]+)["']?\)$/.exec(s.markerEnd)?.[1]
        const marker = [...(svg.getRootNode() as ParentNode).querySelectorAll('marker')].find(node => node.id === id) as SVGMarkerElement | undefined
        const path = marker?.firstElementChild
        if (!marker || marker.children.length !== 1 || path?.localName !== 'path' || !/^M\s*0[, ]0\s*L\s*10[, ]5\s*L\s*0[, ]10\s*z$/i.test(path.getAttribute('d') ?? '') || !['auto', 'auto-start-reverse'].includes(marker.getAttribute('orient') ?? '') || marker.getAttribute('viewBox') !== '0 0 10 10' || marker.hasAttribute('preserveAspectRatio') || (marker.hasAttribute('markerUnits') && !['strokeWidth','userSpaceOnUse'].includes(marker.getAttribute('markerUnits')!))) throw new Error('Unsupported SVG arrow marker')
        effects(marker); effects(path)
        if (getComputedStyle(path).stroke !== 'none' || getComputedStyle(path).opacity !== '1') throw new Error('Unsupported SVG marker stroke/opacity')
        const last = segments.at(-1)!, dx = last.to.x - last.from.x, dy = last.to.y - last.from.y
        if (!dx && !dy) throw new Error('SVG marker has no direction')
        const angle = Math.atan2(dy, dx), units = marker.getAttribute('markerUnits') === 'userSpaceOnUse' ? scale : strokeWidth
        const w = marker.markerWidth.baseVal.value * units, h = marker.markerHeight.baseVal.value * units, unit = Math.min(w, h) / 10
        const refX = marker.refX.baseVal.value, refY = marker.refY.baseVal.value
        const points = [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 10 }].map(p => ({ x: last.to.x + (p.x - refX) * unit * Math.cos(angle) - (p.y - refY) * unit * Math.sin(angle), y: last.to.y + (p.x - refX) * unit * Math.sin(angle) + (p.y - refY) * unit * Math.cos(angle) }))
        const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y))
        const color = paint(getComputedStyle(path).fill)
        color.transparency = 100 - (100 - color.transparency) * Number(getComputedStyle(path).fillOpacity || 1)
        parts.push({ kind: 'polygon', rect: { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y }, points, fill: color })
      }
    } else throw new Error(`Unsupported SVG element: ${el.localName}`)
  }
  walk(svg)
  parts.forEach(validatePart)
  return parts
}
