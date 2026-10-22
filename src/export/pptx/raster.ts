import { toSvg } from 'html-to-image'
import { isPainted, paintedState } from './visibility'

export async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image()
  image.crossOrigin = 'anonymous'
  image.src = url
  await image.decode()
  return image
}

/** Uses img-src (including Tauri's asset protocol), rather than fetch/connect-src. */
export async function imageDataUrl(url: string): Promise<string> {
  if (url.startsWith('data:')) return url
  const image = await loadImage(url)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is unavailable')
  context.drawImage(image, 0, 0)
  return canvas.toDataURL('image/png') // Throws on a tainted canvas. Never return an empty image.
}

/** Resolve every image before html-to-image (which otherwise silently ignores failed fetches). */
export async function inlineImages(root: ParentNode, resolveImage = imageDataUrl, onError?: (element: HTMLElement, error: unknown) => void): Promise<void> {
  const cache = new Map<string, Promise<string>>()
  const data = (url: string) => {
    if (!cache.has(url)) cache.set(url, resolveImage(url))
    return cache.get(url)!
  }
  let serial = 0
  const rules: string[] = []
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    try {
      if (paintedState(el).subtreeHidden) continue
      if (el instanceof HTMLImageElement && !['hidden', 'collapse'].includes(getComputedStyle(el).visibility)) {
        // Intrinsic image dimensions may still be zero before decode. Settle them
        // before applying the same painted-box predicate as every other collector.
        try { await el.decode() } catch (cause) {
          const style = getComputedStyle(el)
          if (isPainted(el) || Number.parseFloat(style.width) > 0 || Number.parseFloat(style.height) > 0 || Number.parseFloat(el.style.width) > 0 || Number.parseFloat(el.style.height) > 0) throw new Error(`Image asset could not be embedded: img ${el.getAttribute('src')}`, { cause })
        }
        if (!isPainted(el)) continue
        if (/\.svg(?:[?#]|$)|^data:image\/svg\+xml/i.test(el.currentSrc || el.src)) el.dataset.pptxRasterReason = 'SVG image'
        el.src = await data(el.currentSrc || el.src)
        el.removeAttribute('srcset')
        await el.decode()
      }
      for (const pseudo of ['', '::before', '::after', '::marker', '::first-letter', '::first-line']) {
        const style = getComputedStyle(el, pseudo || null)
        if (!isPainted(el, pseudo || undefined)) continue
        const declarations: string[] = []
        for (const property of ['content', 'background-image', 'mask-image', '-webkit-mask-image', 'mask-border-source', '-webkit-mask-box-image-source', 'border-image-source', 'list-style-image']) {
          if (!pseudo && property === 'content') continue
          const value = style.getPropertyValue(property)
          let next = value
          try {
            for (const match of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) next = next.replace(match[0], `url("${await data(match[1]!)}")`)
          } catch (cause) { throw new Error(`Image asset could not be embedded: ${el.tagName.toLowerCase()}${pseudo} ${property}`, { cause }) }
          if (next === value) continue
          if (pseudo) declarations.push(`${property}:${next} !important`)
          else el.style.setProperty(property, next)
        }
        if (declarations.length) {
          const id = el.dataset.pptxAssetId ??= String(++serial)
          rules.push(`[data-pptx-asset-id="${id}"][data-pptx-asset-id="${id}"]${pseudo}{${declarations.join(';')}}`)
        }
      }
    } catch (error) {
      if (!onError) throw error
      onError(el, error)
    }
  }
  if (rules.length) {
    const sheet = document.createElement('style')
    sheet.textContent = rules.join('\n')
    root.appendChild(sheet)
  }
}

export interface Insets { top: number; right: number; bottom: number; left: number }
/** CSS shadows use a Gaussian blur; 3 radii reserve all visible pixels, plus AA. */
export function effectInsets(boxShadow: string, textShadow: string, filter: string): Insets {
  const result = { top: 0, right: 0, bottom: 0, left: 0 }
  const shadow = (value: string, drop = false) => {
    if (!value || value === 'none') return
    const withoutColors = value.replace(/(?:rgba?|hsla?|color)\([^)]*\)|#[\da-f]+/gi, '')
    for (const item of withoutColors.split(',')) {
      if (/\binset\b/.test(item)) continue
      const [x = 0, y = 0, blur = 0, spread = 0] = [...item.matchAll(/(-?[\d.]+)px/g)].map(match => Number(match[1]))
      const radius = Math.max(0, blur) * 3 + (drop ? 0 : spread) + 2
      result.left = Math.max(result.left, radius - x)
      result.right = Math.max(result.right, radius + x)
      result.top = Math.max(result.top, radius - y)
      result.bottom = Math.max(result.bottom, radius + y)
    }
  }
  shadow(boxShadow); shadow(textShadow)
  // Filter functions compose, so reserve their extents cumulatively.
  for (const match of filter.matchAll(/blur\(([\d.]+)px\)|drop-shadow\(((?:[^()]|\([^()]*\))*)\)/g)) {
    if (match[1]) {
      const blur = Number(match[1]) * 3 + 2
      for (const side of ['top', 'right', 'bottom', 'left'] as const) result[side] += blur
    } else {
      const drop = effectInsets(match[2]!, 'none', 'none')
      for (const side of ['top', 'right', 'bottom', 'left'] as const) result[side] += drop[side]
    }
  }
  return result
}

/** Absolute pixels including overflow; callers must use the same rect for PPTX placement. */
export function rasterBounds(element: HTMLElement): DOMRect {
  const rect = element.getBoundingClientRect()
  // Full-slide SVG intentionally clips to its viewport, as the preview does.
  if (element instanceof SVGSVGElement) return rect
  let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom
  for (const node of [element, ...element.querySelectorAll<HTMLElement>('*')]) {
    const style = getComputedStyle(node)
    if (!isPainted(node)) continue
    const bounds = node.getBoundingClientRect()
    const sides = effectInsets(style.boxShadow, style.textShadow, style.filter)
    left = Math.min(left, bounds.left - sides.left); top = Math.min(top, bounds.top - sides.top)
    right = Math.max(right, bounds.right + sides.right); bottom = Math.max(bottom, bounds.bottom + sides.bottom)

  }
  return new DOMRect(Math.floor(left), Math.floor(top), Math.ceil(right) - Math.floor(left), Math.ceil(bottom) - Math.floor(top))
}

/** html-to-image deep-clones SVG without resolving slots inside foreignObject. */
function materializeSvgSlots(element: HTMLElement): () => void {
  const restores: (() => void)[] = []
  const styledClone = (node: Node): Node => {
    const clone = node.cloneNode(false)
    if (node instanceof Element && clone instanceof Element && 'style' in clone) {
      const style = getComputedStyle(node)
      for (const property of style) (clone as HTMLElement).style.setProperty(property, style.getPropertyValue(property))
    }
    for (const child of node.childNodes) clone.appendChild(styledClone(child))
    return clone
  }
  const visit = (node: Node) => {
    if (node instanceof HTMLSlotElement && node.closest('svg')) {
      const clones = node.assignedNodes({ flatten: true }).map(styledClone)
      const marker = document.createComment('export-slot')
      node.replaceWith(marker, ...clones)
      restores.push(() => { for (const clone of clones) clone.parentNode?.removeChild(clone); marker.replaceWith(node) })
      return
    }
    if (node instanceof Element && node.shadowRoot) for (const child of [...node.shadowRoot.childNodes]) visit(child)
    for (const child of [...node.childNodes]) visit(child)
  }
  visit(element)
  return () => { for (const restore of restores.reverse()) restore() }
}

/** Preserve the slide's formatting/containing blocks while isolating one painted subtree.
 * html-to-image deep-clones SVG without styling foreignObject descendants. Snapshot
 * those styles, generated content and assigned shadow slots explicitly instead.
 */
async function paintInSlide(element: Element, slide: SVGSVGElement, fontCSS: string, pseudo?: string, hidePseudoText = false): Promise<{ canvas: HTMLCanvasElement; bounds: DOMRect }> {
  const ancestors = new Set<Element>()
  for (let parent: Element | null = element === slide ? null : element.parentElement; parent && parent !== slide; parent = parent.parentElement) ancestors.add(parent)
  if (element !== slide) ancestors.add(slide)
  const rules: string[] = []
  let serial = 0
  const clone = (node: Node, inShadow = false): Node => {
    if (!(node instanceof Element)) return node.cloneNode(true)
    const copy = node.shadowRoot || node instanceof HTMLSlotElement ? document.createElement('div') : node.cloneNode(false) as Element
    if ('style' in copy) {
      const style = (copy as HTMLElement).style
      if (inShadow || node.shadowRoot || node instanceof HTMLSlotElement) {
        const computed = getComputedStyle(node)
        for (const property of computed) style.setProperty(property, computed.getPropertyValue(property))
      }
      if (ancestors.has(node)) {
        style.backgroundColor = 'transparent'; style.backgroundImage = 'none'; style.borderColor = 'transparent'; style.boxShadow = 'none'
        copy.setAttribute('data-pptx-ancestor', '')
      } else if (node !== element && ancestors.has(node.parentElement!) && !ancestors.has(node)) style.opacity = '0'
      if (inShadow && !ancestors.has(node)) for (const pseudo of ['::before', '::after']) {
        const generated = getComputedStyle(node, pseudo)
        if (!generated.content || ['none', 'normal'].includes(generated.content)) continue
        const id = copy.getAttribute('data-pptx-snapshot') ?? String(++serial)
        copy.setAttribute('data-pptx-snapshot', id)
        rules.push(`[data-pptx-snapshot="${id}"]${pseudo}{${[...generated].map(property => `${property}:${generated.getPropertyValue(property)};`).join('')}}`)
      }
    }
    if (pseudo && 'style' in copy) {
      (copy as HTMLElement).style.setProperty('visibility', 'hidden', 'important')
      copy.setAttribute('data-pptx-pseudo-suppressed', '')
      if (node === element) {
        copy.setAttribute('data-pptx-pseudo-target', '')
        if (pseudo === 'background') {
          const style = (copy as HTMLElement).style
          style.setProperty('visibility', 'visible', 'important')
          for (const property of ['color', '-webkit-text-fill-color', 'text-decoration-color']) style.setProperty(property, 'transparent', 'important')
        }
      }
    }
    const children = node instanceof HTMLSlotElement ? node.assignedNodes({ flatten: true }) : [...(node.shadowRoot ?? node).childNodes]
    for (const child of children) copy.appendChild(clone(child, inShadow || !!node.shadowRoot))
    return copy
  }
  const snapshot = clone(slide) as SVGSVGElement
  snapshot.style.cssText += ';position:static;margin:0;left:auto;top:auto;'
  const origin = slide.getBoundingClientRect(), bounds = pseudo ? origin : rasterBounds(element as HTMLElement)
  const surface = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  surface.setAttribute('width', String(origin.width)); surface.setAttribute('height', String(origin.height))
  const foreign = document.createElementNS(surface.namespaceURI, 'foreignObject')
  foreign.setAttribute('width', '100%'); foreign.setAttribute('height', '100%')
  const wrapper = document.createElement('div'), marpit = document.createElement('div'), sheet = document.createElement('style')
  marpit.className = 'marpit'
  const root = slide.getRootNode() as Document | ShadowRoot
  if (pseudo) {
    const suppressed = '[data-pptx-pseudo-suppressed]'.repeat(4)
    rules.push(`${suppressed}::before,${suppressed}::after,${suppressed}::marker{visibility:hidden!important}`)
    if (pseudo === 'background') {
      const target = '[data-pptx-pseudo-target]'.repeat(5)
      rules.push(`${target}::first-letter,${target}::first-line{color:transparent!important;-webkit-text-fill-color:transparent!important;text-decoration-color:transparent!important;text-shadow:none!important}`)
    }
    if (pseudo !== 'background') {
      const computed = getComputedStyle(element, pseudo)
      const hiddenText = hidePseudoText ? 'color:transparent!important;-webkit-text-fill-color:transparent!important;text-decoration-color:transparent!important;' : ''
      rules.push(`${'[data-pptx-pseudo-target]'.repeat(5)}${pseudo}{${[...computed].map(property => `${property}:${computed.getPropertyValue(property)}!important;`).join('')}${hiddenText}}`)
    }
  }
  sheet.textContent = `${[...root.querySelectorAll('style')].map(style => style.textContent).join('\n')}\n${fontCSS}\n${rules.join('\n')}\n[data-pptx-ancestor]::before,[data-pptx-ancestor]::after{display:none!important}`
  marpit.append(snapshot); wrapper.append(sheet, marpit); foreign.append(wrapper); surface.append(foreign)
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(surface))}`)
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(bounds.width) * 2; canvas.height = Math.ceil(bounds.height) * 2
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas 2D is unavailable')
  context.drawImage(image, (origin.left - bounds.left) * 2, (origin.top - bounds.top) * 2, origin.width * 2, origin.height * 2)
  return { canvas, bounds }
}

async function rasterizeInSlide(element: Element, slide: SVGSVGElement, fontCSS: string): Promise<string> {
  return (await paintInSlide(element, slide, fontCSS)).canvas.toDataURL('image/png')
}

/** Keep real pseudo layout/counters/containing blocks, hide all other paint, then crop alpha. */
export async function rasterizePseudo(element: Element, pseudo: string, slide: SVGSVGElement, fontCSS: string, hideText = false): Promise<{ data: string; rect: DOMRect } | undefined> {
  return rasterizeLayer(element, pseudo, slide, fontCSS, hideText)
}

export async function rasterizeBackground(element: Element, slide: SVGSVGElement, fontCSS: string): Promise<{ data: string; rect: DOMRect } | undefined> {
  return rasterizeLayer(element, 'background', slide, fontCSS)
}

async function rasterizeLayer(element: Element, layer: string, slide: SVGSVGElement, fontCSS: string, hideText = false): Promise<{ data: string; rect: DOMRect } | undefined> {
  const { canvas, bounds } = await paintInSlide(element, slide, fontCSS, layer, hideText)
  const context = canvas.getContext('2d')!
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  let left = canvas.width, top = canvas.height, right = 0, bottom = 0
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    if (!pixels[(y * canvas.width + x) * 4 + 3]) continue
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1)
  }
  if (left >= right || top >= bottom) return undefined
  const crop = document.createElement('canvas')
  crop.width = right - left; crop.height = bottom - top
  crop.getContext('2d')!.drawImage(canvas, left, top, crop.width, crop.height, 0, 0, crop.width, crop.height)
  return { data: crop.toDataURL('image/png'), rect: new DOMRect(bounds.left + left / 2, bounds.top + top / 2, crop.width / 2, crop.height / 2) }
}

/** toSvg avoids html-to-image's requestAnimationFrame wait in a background window. */
export async function rasterize(element: HTMLElement, fontEmbedCSS: string, filter?: (node: HTMLElement) => boolean, backgroundOnly = false, slide?: SVGSVGElement): Promise<string> {
  if (slide || element instanceof SVGSVGElement) return rasterizeInSlide(element, slide ?? element as unknown as SVGSVGElement, fontEmbedCSS)
  const borderRect = element.getBoundingClientRect()
  const rect = backgroundOnly ? borderRect : rasterBounds(element)
  const width = Math.ceil(rect.width - .01), height = Math.ceil(rect.height - .01)
  if (width <= 0 || height <= 0) throw new Error('Cannot rasterize an empty element')
  const computed = getComputedStyle(element)
  const matrix = new DOMMatrix(computed.transform === 'none' ? undefined : computed.transform)
  const [originX = 0, originY = 0] = computed.transformOrigin.split(' ').map(Number.parseFloat)
  const localWidth = element.offsetWidth || rect.width, localHeight = element.offsetHeight || rect.height
  const corners = [[0, 0], [localWidth, 0], [0, localHeight], [localWidth, localHeight]].map(([x, y]) => new DOMPoint(x! - originX, y! - originY).matrixTransform(matrix))
  const left = borderRect.left - rect.left - Math.min(...corners.map(p => p.x + originX))
  const top = borderRect.top - rect.top - Math.min(...corners.map(p => p.y + originY))
  const restore = materializeSvgSlots(element)
  let svg: string
  try { svg = await toSvg(element, {
    width, height, fontEmbedCSS, filter,
    style: { margin: '0', position: 'absolute', left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto', width: computed.width, height: computed.height },
    onImageErrorHandler: () => { throw new Error('An image could not be embedded') },
  }) } finally { restore() }
  if (backgroundOnly) {
    const document = new DOMParser().parseFromString(decodeURIComponent(svg.slice(svg.indexOf(',') + 1)), 'image/svg+xml')
    const root = document.querySelector('foreignObject')?.firstElementChild
    for (const style of root?.querySelectorAll(':scope > style') ?? []) if (/:before|:after/.test(style.textContent ?? '')) style.remove()
    svg = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(document.documentElement))}`
  }
  const image = await loadImage(svg)
  const canvas = document.createElement('canvas')
  canvas.width = width * 2; canvas.height = height * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D is unavailable')
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/png')
}
