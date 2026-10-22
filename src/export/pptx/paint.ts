import { cssColor, type Part, type Rect } from './model'
import { borderColor, pixels } from './styles'

export const BOX_ELEMENTS = 'h1,h2,h3,h4,h5,h6,marp-h1,marp-h2,marp-h3,marp-h4,marp-h5,marp-h6,p,ul,ol,li,table,thead,tbody,tfoot,tr,th,td,col,colgroup,blockquote,pre,marp-pre,header,footer,figure,figcaption,div'
export const SIDES = ['top', 'right', 'bottom', 'left'] as const
const active = (v: string) => !!v && !['none', 'initial'].includes(v)
/** Only equal circular pixel radii have a native roundRect mapping. */
export function boxRadius(style: CSSStyleDeclaration): number | undefined {
  const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'].map(corner => {
    const values = (style.getPropertyValue(`border-${corner}-radius`) || '0px').split(/\s+/)
    if (values.some(v => !/^\d+(?:\.\d+)?px$/.test(v))) return NaN
    const x = Number.parseFloat(values[0]!), y = Number.parseFloat(values[1] ?? values[0]!)
    return x === y ? x : NaN
  })
  return corners.every(r => r === corners[0]) ? corners[0] : undefined
}
function uniformBorder(style: CSSStyleDeclaration): boolean {
  return SIDES.every(side => ['width', 'style', 'color'].every(property => style.getPropertyValue(`border-${side}-${property}`) === style.getPropertyValue(`border-top-${property}`)))
}
function transparent(value: string): boolean { try { return !value || cssColor(value).transparency === 100 } catch { return false } }
export function hasBoxPaint(style: CSSStyleDeclaration): boolean {
  return !transparent(style.backgroundColor) || active(style.backgroundImage) ||
    active(style.boxShadow) || SIDES.some(side => Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0) ||
    (active(style.outlineStyle) && style.outlineStyle !== 'hidden' && Number.parseFloat(style.outlineWidth) > 0) || active(style.borderImageSource)
}
export function separateBox(element: Element): boolean {
  const style = getComputedStyle(element)
  if (element.matches('thead,tbody,tfoot,tr,th,td,col,colgroup') && transparent(style.backgroundColor) && !rasterBox(style, true)) return false
  return (element.matches(BOX_ELEMENTS) || element.matches('a,strong,em,s,mark,code,span')) && getComputedStyle(element).backgroundClip !== 'text' && hasBoxPaint(getComputedStyle(element))
}
/** Unequal/elliptical corners, clipping, images, outlines and shadows stay browser-painted. */
export function rasterBox(style: CSSStyleDeclaration, tableBorder = false): boolean {
  if (active(style.backgroundImage) || active(style.boxShadow) || active(style.borderImageSource) ||
      (active(style.outlineStyle) && style.outlineStyle !== 'hidden' && Number.parseFloat(style.outlineWidth) > 0)) return true
  const radius = boxRadius(style)
  if (radius === undefined || (radius > 0 && (tableBorder || !uniformBorder(style)))) return true
  if (style.backgroundClip && style.backgroundClip !== 'border-box') return true
  for (const side of SIDES) {
    if (!(Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0)) continue
    if (!['none', 'hidden', 'solid'].includes(style.getPropertyValue(`border-${side}-style`))) return true
    // Native lines cannot preserve alpha across arbitrary overlapping backgrounds.
    try { if (!tableBorder && cssColor(style.getPropertyValue(`border-${side}-color`)).transparency % 100 !== 0) return true } catch { return true }
  }
  try { cssColor(style.backgroundColor) } catch { return true }
  return false
}
export function nativeBox(element: Element, rect: Rect): Part[] {
  const style = getComputedStyle(element), parts: Part[] = []
  const fill = cssColor(style.backgroundColor)
  const radius = boxRadius(style)
  if (radius) {
    const width = pixels(style.borderTopWidth), color = cssColor(style.borderTopColor)
    const stroke = !['none', 'hidden'].includes(style.borderTopStyle) && width > 0 && color.transparency < 100
    const inset = stroke ? width / 2 : 0
    parts.push({ kind: 'box', rect: { x: rect.x + inset, y: rect.y + inset, width: rect.width - inset * 2, height: rect.height - inset * 2 }, fill,
      radius: Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2) - inset),
      line: stroke ? { color: color.color, transparency: color.transparency, width: width * .75 } : undefined })
    return parts
  }
  if (fill.transparency < 100) parts.push({ kind: 'box', rect, fill })
  for (const side of SIDES) {
    const thickness = pixels(style.getPropertyValue(`border-${side}-width`))
    const type = style.getPropertyValue(`border-${side}-style`), color = style.getPropertyValue(`border-${side}-color`)
    if (thickness <= 0 || ['none', 'hidden'].includes(type) || cssColor(color).transparency === 100) continue
    const vertical = side === 'left' || side === 'right'
    parts.push({ kind: 'line', x: rect.x + (side === 'right' ? rect.width - thickness / 2 : vertical ? thickness / 2 : 0),
      y: rect.y + (side === 'bottom' ? rect.height - thickness / 2 : vertical ? 0 : thickness / 2),
      width: vertical ? 0 : rect.width, height: vertical ? rect.height : 0, color: borderColor(element, color), points: thickness * .75 })
  }
  return parts
}
