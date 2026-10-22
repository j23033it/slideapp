import { isPainted } from './visibility'

/** Shared paint/layout gates, including wrappers that are not native text collectors. */
const DEFAULTS: Record<string, readonly string[]> = {
  'column-count': ['auto', '1'], 'column-width': ['auto'],
  'text-overflow': ['clip'], '-webkit-line-clamp': ['none'], 'line-clamp': ['none'],
  'text-wrap-mode': ['wrap', 'nowrap'], 'text-wrap-style': ['auto'],
  'line-break': ['auto'], 'text-justify': ['auto'], 'word-break': ['normal'], 'overflow-wrap': ['normal', 'break-word'], 'hyphens': ['manual', 'none'],
  'font-variant-alternates': ['normal'], 'font-language-override': ['normal'], 'font-variant-ligatures': ['normal'], 'font-variant-east-asian': ['normal'],
  'font-variation-settings': ['normal'], 'font-size-adjust': ['none'],
  'text-combine-upright': ['none'], 'text-spacing-trim': ['normal'],
  '-webkit-text-security': ['none'], 'ruby-position': ['over'],
  'rotate': ['none'], 'scale': ['none'], 'translate': ['none'],
  'perspective': ['none'], 'transform-style': ['flat'],
}
export function layoutPaintReason(style: CSSStyleDeclaration): string | undefined {
  for (const [property, allowed] of Object.entries(DEFAULTS)) {
    const value = style.getPropertyValue(property)
    if (value && !allowed.includes(value)) return `Unsupported CSS ${property}: ${value}`
  }
  const stroke = style.getPropertyValue('-webkit-text-stroke-width')
  if (stroke && stroke !== '0px') return `Unsupported CSS -webkit-text-stroke-width: ${stroke}`
  const fill = style.getPropertyValue('-webkit-text-fill-color')
  if (fill && fill !== style.color) return `Unsupported CSS -webkit-text-fill-color: ${fill}`
  return undefined
}
export function clipsContent(element: Element): string | undefined {
  const style = getComputedStyle(element)
  for (const axis of ['x', 'y'] as const) {
    const overflow = style.getPropertyValue(`overflow-${axis}`)
    if (!overflow || overflow === 'visible') continue
    const box = element.getBoundingClientRect()
    const extent = axis === 'x' ? 'Width' : 'Height'
    if ((element as HTMLElement)[`scroll${extent}`] > (element as HTMLElement)[`client${extent}`] + 1 ||
      [...element.querySelectorAll('*')].some(child => {
        if (!isPainted(child)) return false
        const r = child.getBoundingClientRect()
        return axis === 'x' ? r.left < box.left - 1 || r.right > box.right + 1 : r.top < box.top - 1 || r.bottom > box.bottom + 1
      })) return `CSS overflow-${axis}: ${overflow} clips content`
  }
  const clip = style.getPropertyValue('clip')
  if (clip && clip !== 'auto') return `Unsupported CSS clip: ${clip}`
  return undefined
}
const TEXT_PAINT = ['color','font-family','font-size','font-weight','font-style','font-stretch','font-variant-caps',
  'font-variant-numeric','font-variant-ligatures','font-variant-east-asian','font-feature-settings','font-variation-settings',
  'letter-spacing','word-spacing','line-height','text-transform','text-decoration-line','text-decoration-color',
  'text-decoration-style','text-decoration-thickness','white-space','direction','writing-mode','text-orientation','text-shadow','-webkit-text-fill-color','-webkit-text-stroke-width']
/** These pseudos alter only part of a run/line, so a whole native run is insufficient. */
export function textPseudoReason(element: Element): string | undefined {
  if (!element.textContent?.trim()) return undefined
  const base = getComputedStyle(element)
  for (const pseudo of ['::first-letter', '::first-line']) {
    const style = getComputedStyle(element, pseudo)
    // Engines without pseudo CSSOM (e.g. DOM-only verification) return the base object.
    if (style === base) continue
    for (const property of TEXT_PAINT) {
      const value = style.getPropertyValue(property)
      if (property.startsWith('text-decoration-') && (!style.textDecorationLine || style.textDecorationLine === 'none')) continue
      if (value && value !== base.getPropertyValue(property)) return `CSS ${pseudo} ${property}: ${value}`
    }
    for (const property of ['background-image', 'box-shadow']) {
      const value = style.getPropertyValue(property)
      if (value && value !== 'none') return `CSS ${pseudo} ${property}: ${value}`
    }
    const background = style.backgroundColor
    if (background && !['transparent', 'rgba(0, 0, 0, 0)'].includes(background)) return `CSS ${pseudo} background-color: ${background}`
    for (const property of ['float', 'vertical-align']) {
      const value = style.getPropertyValue(property)
      if (value && !['none', 'baseline'].includes(value) && value !== base.getPropertyValue(property)) return `CSS ${pseudo} ${property}: ${value}`
    }
    for (const side of ['top', 'right', 'bottom', 'left']) {
      for (const name of ['margin', 'padding']) {
        const value = style.getPropertyValue(`${name}-${side}`)
        if (Number.parseFloat(value) !== 0 && value) return `CSS ${pseudo} ${name}-${side}: ${value}`
      }
      const value = style.getPropertyValue(`border-${side}-width`)
      if (Number.parseFloat(value) > 0) return `CSS ${pseudo} border-${side}-width: ${value}`
    }
  }
  return undefined
}
