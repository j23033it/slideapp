import { cssColor, validatePart, type Paragraph, type Part } from './model'
import { isPainted, paintedState } from './visibility'
import { nativeStyleReason, nativeLetterSpacing, pixels, type StyleApproximation } from './styles'
import { clipsContent } from './cssAudit'

type Point = { x: number; y: number }
type Segment = { from: Point; to: Point }
type Subpath = { segments: Segment[]; closed: boolean }
/** Strict tokenizer: never drop an unknown character or guess a path command. */
function straightSubpaths(d: string): Subpath[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/g) ?? []
  if (d.replace(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?|[\s,]/g, '')) throw new Error('Unsupported SVG path token')
  let index = 0, command = '', previous: Point | undefined, start: Point | undefined
  const subpaths: Subpath[] = []
  const number = () => {
    const value = Number(tokens[index++])
    if (!Number.isFinite(value)) throw new Error('Invalid SVG path coordinate')
    return value
  }
  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index]!)) command = tokens[index++]!
    if (command === 'Z' || command === 'z') {
      if (!previous || !start || subpaths.at(-1)!.closed) throw new Error('SVG close path must follow an open subpath')
      const subpath = subpaths.at(-1)!
      subpath.segments.push({ from: previous, to: start })
      subpath.closed = true
      previous = start
      command = ''
      continue
    }
    if (!['M', 'L', 'H', 'V'].includes(command)) throw new Error(`Unsupported SVG path command: ${command}`)
    if (!previous && command !== 'M') throw new Error('SVG path must begin with M')
    if (subpaths.at(-1)?.closed && command !== 'M') throw new Error('Unsupported SVG continuation after close path')
    const next = command === 'H' ? { x: number(), y: previous!.y } : command === 'V' ? { x: previous!.x, y: number() } : { x: number(), y: number() }
    if (command === 'M') {
      start = next
      subpaths.push({ segments: [], closed: false })
    } else subpaths.at(-1)!.segments.push({ from: previous!, to: next })
    previous = next
    if (command === 'M') command = 'L'
  }
  if (!previous) throw new Error('Empty SVG path')
  return subpaths
}

export function straightPath(d: string): Segment[] {
  return straightSubpaths(d).flatMap(subpath => subpath.segments)
}

const paint = (value: string) => value === 'none' ? { color: 'FFFFFF', transparency: 100 } : cssColor(value)
function pathData(element: Element): string {
  const attribute = element.getAttribute('d') ?? ''
  const computed = getComputedStyle(element).getPropertyValue('d')
  if (computed) {
    const data = /^path\(["'](.*)["']\)$/.exec(computed)?.[1]
    const tokens = (value: string) => value.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/g)?.map(token => Number.isFinite(Number(token)) ? String(Number(token)) : token === 'z' ? 'Z' : token)
    if (data === undefined || JSON.stringify(tokens(data)) !== JSON.stringify(tokens(attribute))) throw new Error('Unsupported SVG CSS path geometry')
  }
  return attribute
}
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
  const viewport = svg.getBoundingClientRect(), viewportStyle = getComputedStyle(svg)
  // DOM geometry bounds omit stroke and markers. Test the paint we will emit as
  // well, including zero-height lines and the actual transformed arrow polygon.
  const checkPaintBounds = (x: number, y: number, width: number, height: number, outset = 0) => {
    if ((viewportStyle.overflowX && viewportStyle.overflowX !== 'visible' && (x - outset < viewport.left - origin.left - .01 || x + width + outset > viewport.right - origin.left + .01)) ||
      (viewportStyle.overflowY && viewportStyle.overflowY !== 'visible' && (y - outset < viewport.top - origin.top - .01 || y + height + outset > viewport.bottom - origin.top + .01))) throw new Error('SVG stroke/marker paint clips content')
  }
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
  const squareMiterBoxes = new Set<Part>()
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
      if ((!s.strokeLinejoin || s.strokeLinejoin === 'miter') && Number(s.strokeMiterlimit || 4) >= Math.SQRT2) squareMiterBoxes.add(parts.at(-1)!)
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
      const subpaths = straightSubpaths(pathData(el)).map(subpath => ({ ...subpath,
        segments: subpath.segments.map(segment => ({ from: point(segment.from), to: point(segment.to) })) }))
      // SVG paints one path's stroke once, including overlapping subpaths.
      // Separate Office shapes would apply alpha again at each overlap. Reject
      // this SVG atomically; separate path elements must still composite apart.
      if (line && stroke.transparency > 0 && subpaths.length > 1) throw new Error('Unsupported SVG translucent multi-subpath stroke: separate shapes would compound transparency')
      const join = s.strokeLinejoin || 'miter', miterLimit = Number(s.strokeMiterlimit || 4)
      if (line && ((s.strokeLinecap && s.strokeLinecap !== 'butt') || !['miter', 'round', 'bevel'].includes(join))) throw new Error(`Unsupported SVG stroke-linecap/linejoin: ${s.strokeLinecap} / ${s.strokeLinejoin}`)
      if (line) for (const subpath of subpaths) {
        const edges = subpath.segments.filter(({from,to}) => from.x !== to.x || from.y !== to.y)
        if (!edges.length) continue
        if (!subpath.closed && edges.length === 1) {
          const { from, to } = edges[0]!
          parts.push({ kind: 'line', x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y),
            flipH: to.x < from.x, flipV: to.y < from.y, color: stroke.color, transparency: stroke.transparency, points: strokeWidth * .75, dash })
          continue
        }
        // Keep a whole subpath together, so Office can join adjacent strokes and
        // close the last-to-first join. Flat degenerate bounds need a nonzero
        // coordinate frame; points themselves retain their exact positions.
        const points = [edges[0]!.from, ...edges.map(edge => edge.to)]
        if (subpath.closed) points.pop()
        const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y))
        parts.push({kind:'path', rect:{x,y,width:Math.max(1,Math.max(...points.map(p => p.x))-x),height:Math.max(1,Math.max(...points.map(p => p.y))-y)},
          points,closed:subpath.closed,line,join:join as 'miter' | 'round' | 'bevel',miterLimit})
        // Segment corners and actual miter tips bound the stroke. Expanding the
        // whole path by miterLimit would unnecessarily reject thin connectors.
        const half = strokeWidth / 2
        const normals = edges.map(({from,to}) => {
          const length = Math.hypot(to.x-from.x,to.y-from.y)
          return {x:-(to.y-from.y)/length,y:(to.x-from.x)/length}
        })
        const checkPoint = (p: Point) => checkPaintBounds(p.x,p.y,0,0)
        edges.forEach(({from,to}, i) => {
          const n = normals[i]!
          for (const p of [from,to]) for (const sign of [-1,1]) checkPoint({x:p.x+sign*half*n.x,y:p.y+sign*half*n.y})
        })
        for (let i = subpath.closed ? 0 : 1; i < edges.length; i++) {
          const a = normals[(i+edges.length-1)%edges.length]!, b = normals[i]!, vertex = edges[i]!.from
          if (join === 'round') checkPaintBounds(vertex.x,vertex.y,0,0,half)
          else if (join === 'miter') {
            const denominator = 1+a.x*b.x+a.y*b.y
            if (denominator > 0 && Math.sqrt(2/denominator) <= miterLimit) {
              for (const sign of [-1,1]) checkPoint({x:vertex.x+sign*half*(a.x+b.x)/denominator,y:vertex.y+sign*half*(a.y+b.y)/denominator})
            }
          }
        }
      }
      if (s.markerEnd && s.markerEnd !== 'none') {
        const urlText = /^url\(["']?([^"')]+)["']?\)$/.exec(s.markerEnd)?.[1]
        const target = urlText ? new URL(urlText, document.baseURI) : undefined, current = new URL(document.baseURI)
        if (!target || !target.hash) throw new Error('Unsupported SVG marker URL')
        target.hash = ''; current.hash = ''
        if (target.href !== current.href) throw new Error('Unsupported external SVG marker')
        const id = /#([^"')]+)["']?\)$/.exec(s.markerEnd)?.[1]
        const marker = [...(svg.getRootNode() as ParentNode).querySelectorAll('marker')].find(node => node.id === id) as SVGMarkerElement | undefined
        const path = marker?.firstElementChild
        if (!marker || marker.children.length !== 1 || path?.localName !== 'path' || !/^M\s*0[, ]0\s*L\s*10[, ]5\s*L\s*0[, ]10\s*z$/i.test(pathData(path)) || !['auto', 'auto-start-reverse'].includes(marker.getAttribute('orient') ?? '') || marker.getAttribute('viewBox') !== '0 0 10 10' || marker.hasAttribute('preserveAspectRatio') || (marker.hasAttribute('markerUnits') && !['strokeWidth','userSpaceOnUse'].includes(marker.getAttribute('markerUnits')!))) throw new Error('Unsupported SVG arrow marker')
        effects(marker); effects(path)
        for (const node of [marker, path]) {
          const style = getComputedStyle(node)
          if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || style.contentVisibility === 'hidden') throw new Error('Unsupported SVG hidden marker content')
          if (node.hasAttribute('transform') || (style.transform && style.transform !== 'none')) throw new Error('Unsupported SVG marker transform')
        }
        if (getComputedStyle(path).stroke !== 'none' || getComputedStyle(path).opacity !== '1') throw new Error('Unsupported SVG marker stroke/opacity')
        const units = marker.getAttribute('markerUnits') === 'userSpaceOnUse' ? scale : strokeWidth
        const w = marker.markerWidth.baseVal.value * units, h = marker.markerHeight.baseVal.value * units, unit = Math.min(w, h) / 10
        const refX = marker.refX.baseVal.value, refY = marker.refY.baseVal.value
        const color = paint(getComputedStyle(path).fill)
        color.transparency = 100 - (100 - color.transparency) * Number(getComputedStyle(path).fillOpacity || 1)
        // SVG marker-end belongs to the final vertex of the entire path, not
        // every subpath. Never borrow an endpoint/direction from an earlier M.
        const last = subpaths.at(-1)!.segments.at(-1)
        if (!last) throw new Error('SVG marker has no direction')
        const dx = last.to.x - last.from.x, dy = last.to.y - last.from.y
        if (!dx && !dy) throw new Error('SVG marker has no direction')
        const angle = Math.atan2(dy, dx)
        const points = [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 10 }].map(p => ({ x: last.to.x + (p.x - refX) * unit * Math.cos(angle) - (p.y - refY) * unit * Math.sin(angle), y: last.to.y + (p.x - refX) * unit * Math.sin(angle) + (p.y - refY) * unit * Math.cos(angle) }))
        const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y))
        parts.push({ kind: 'polygon', rect: { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y }, points, fill: color })
      }
    } else throw new Error(`Unsupported SVG element: ${el.localName}`)
  }
  walk(svg)
  const visibleParts = parts.flatMap((part): Part[] => {
    if (part.kind !== 'box' || !part.line) return [part]
    if (typeof part.line.width !== 'number' || typeof part.line.color !== 'string') throw new Error('Invalid SVG rectangle stroke')
    const { x, y, width, height } = part.rect, half = part.line.width / .75 / 2
    const left = viewportStyle.overflowX && viewportStyle.overflowX !== 'visible' ? viewport.left - origin.left : -Infinity
    const right = viewportStyle.overflowX && viewportStyle.overflowX !== 'visible' ? viewport.right - origin.left : Infinity
    const top = viewportStyle.overflowY && viewportStyle.overflowY !== 'visible' ? viewport.top - origin.top : -Infinity
    const bottom = viewportStyle.overflowY && viewportStyle.overflowY !== 'visible' ? viewport.bottom - origin.top : Infinity
    const clipped = Math.max(left - x + half, x + width + half - right, top - y + half, y + height + half - bottom)
    if (clipped <= .01) return [part]
    // Preserve the poster's boundary hairlines exactly instead of dropping the
    // clipped half of a centered stroke. Opaque square miter borders are a union
    // of four rectangles; intersect those with the viewport before serialization.
    if (clipped > 1 || !squareMiterBoxes.has(part) || part.radius || part.line.dashType || part.line.transparency || width < half * 2 || height < half * 2) throw new Error('SVG stroke/marker paint clips content')
    const clipBox = (x: number, y: number, width: number, height: number, fill: Extract<Part, {kind:'box'}>['fill']): Part[] => {
      const x1 = Math.max(left, x), y1 = Math.max(top, y), x2 = Math.min(right, x + width), y2 = Math.min(bottom, y + height)
      return x2 > x1 && y2 > y1 ? [{kind:'box',rect:{x:x1,y:y1,width:x2-x1,height:y2-y1},fill}] : []
    }
    const fill = {color:part.line.color,transparency:0}
    const border = (x: number, y: number, width: number, height: number, horizontal: boolean): Part[] => clipBox(x,y,width,height,fill).map(part => {
      if (part.kind !== 'box') throw new Error('Invalid SVG border strip')
      const r = part.rect
      return {kind:'line',x:r.x+(horizontal?0:r.width/2),y:r.y+(horizontal?r.height/2:0),width:horizontal?r.width:0,height:horizontal?0:r.height,
        color:fill.color,transparency:0,points:(horizontal?r.height:r.width)*.75}
    })
    return [
      ...clipBox(x,y,width,height,part.fill),
      ...border(x-half,y-half,width+2*half,2*half,true),
      ...border(x-half,y+height-half,width+2*half,2*half,true),
      ...border(x-half,y-half,2*half,height+2*half,false),
      ...border(x+width-half,y-half,2*half,height+2*half,false),
    ]
  })
  for (const part of visibleParts) {
    if (part.kind === 'box') checkPaintBounds(part.rect.x, part.rect.y, part.rect.width, part.rect.height, (part.line?.width ?? 0) / .75 / 2)
    else if (part.kind === 'line') {
      const length = Math.hypot(part.width, part.height), half = part.points / .75 / 2
      const dx = half * part.height / length, dy = half * part.width / length
      checkPaintBounds(part.x-dx, part.y-dy, part.width+2*dx, part.height+2*dy)
    }
    else if (part.kind === 'polygon') checkPaintBounds(part.rect.x, part.rect.y, part.rect.width, part.rect.height)
  }
  visibleParts.forEach(validatePart)
  return visibleParts
}
