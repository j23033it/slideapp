import { cssColor, supportedMarker } from './model'

export function pixels(value: string): number {
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)px$/.test(value)) throw new Error(`Unsupported computed length: ${value}`)
  return Number.parseFloat(value)
}


export interface StyleApproximation { property: string; value: string; replacement: string }
type ApproximationRule = { property: string; accepts: (value: string, style: CSSStyleDeclaration) => boolean; replacement: string }
const length = (value: string) => /^-?(?:\d+(?:\.\d+)?|\.\d+)px$/.test(value) ? Number.parseFloat(value) : NaN
const small = (value: string, style: CSSStyleDeclaration, em: number, cap: number) => Math.abs(length(value)) <= Math.min(cap, length(style.fontSize) * em)
/** The only lossy native mappings. Bounds prevent large visual differences from being ignored. */
export const APPROXIMATION_RULES: readonly ApproximationRule[] = [
  { property: 'text-underline-offset', accepts: (v, s) => v !== 'auto' && small(v, s, .3, 10), replacement: 'PowerPoint underline position' },
  { property: 'text-decoration-thickness', accepts: (v, s) => v === 'from-font' || (length(v) > 0 && small(v, s, .15, 4)), replacement: 'PowerPoint underline thickness' },
  { property: 'font-variant-numeric', accepts: v => v !== 'normal' && v.split(/\s+/).every(n => ['tabular-nums', 'proportional-nums', 'lining-nums'].includes(n)), replacement: 'Default numeric glyph metrics' },
  { property: 'font-feature-settings', accepts: v => v !== 'normal' && v.split(/,\s*/).every(n => /^"(?:kern|liga|clig|calt|tnum|pnum)"(?: (?:0|1|on|off))?$/.test(n)), replacement: 'PowerPoint default font features' },
  { property: 'font-kerning', accepts: v => ['normal', 'none'].includes(v), replacement: 'PowerPoint default kerning' },
  { property: 'text-rendering', accepts: v => ['optimizeSpeed', 'optimizeLegibility', 'geometricPrecision'].includes(v), replacement: 'PowerPoint text rendering' },
  { property: '-webkit-font-smoothing', accepts: v => ['antialiased', 'subpixel-antialiased', 'none'].includes(v), replacement: 'PowerPoint text antialiasing' },
  { property: 'letter-spacing', accepts: (v, s) => length(v) !== 0 && small(v, s, .05, 1), replacement: '0px' },
  ...['top', 'right', 'bottom', 'left'].map(side => ({ property: `border-${side}-color`, accepts: (v: string, s: CSSStyleDeclaration) => {
    if (!(length(s.getPropertyValue(`border-${side}-width`)) > 0) || ['none', 'hidden'].includes(s.getPropertyValue(`border-${side}-style`))) return false
    try { const alpha = cssColor(v).transparency; return alpha > 0 && alpha < 100 } catch { return false }
  }, replacement: 'Opaque RGB composited over ancestor solid backgrounds' })),
]
export function styleApproximations(style: CSSStyleDeclaration): StyleApproximation[] {
  return APPROXIMATION_RULES.filter(rule => { const value = style.getPropertyValue(rule.property); return !!value && rule.accepts(value, style) })
    .map(rule => ({ property: rule.property, value: style.getPropertyValue(rule.property), replacement: rule.replacement }))
}
export function nativeLetterSpacing(style: CSSStyleDeclaration): number {
  return style.letterSpacing === 'normal' || styleApproximations(style).some(a => a.property === 'letter-spacing') ? 0 : pixels(style.letterSpacing)
}
export function compositeColor(foreground: ReturnType<typeof cssColor>, background: string): string {
  const alpha = 1 - foreground.transparency / 100
  return [0, 2, 4].map(i => Math.round(Number.parseInt(foreground.color.slice(i, i + 2), 16) * alpha + Number.parseInt(background.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('').toUpperCase()
}
/** Used only for approximated border alpha; native text/fills keep their real alpha. */
export function borderColor(element: Element, value: string): string {
  const backgrounds: ReturnType<typeof cssColor>[] = []
  for (let node: Element | null = element; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (color) backgrounds.unshift(cssColor(color))
  }
  return compositeColor(cssColor(value), backgrounds.reduce((base, color) => compositeColor(color, base), 'FFFFFF'))
}

const VALUES: Record<string, readonly string[]> = {
  'text-align': ['left', 'center', 'right', 'justify', 'start', 'end'],
  'font-weight': ['normal', 'bold', '400', '600', '700'], 'font-style': ['normal', 'italic'],
  'font-stretch': ['normal', '100%'], 'font-variant-caps': ['normal'],
  'font-variant-numeric': ['normal'], 'font-variant-position': ['normal'],
  'writing-mode': ['horizontal-tb'], direction: ['ltr'], 'unicode-bidi': ['normal', 'isolate'],
  'white-space': ['normal', 'pre', 'pre-wrap'], 'text-transform': ['none'],
  'text-decoration-style': ['solid'], 'text-decoration-thickness': ['auto'],
  'font-feature-settings': ['normal'], 'font-kerning': ['auto'], 'text-rendering': ['auto'],
  '-webkit-font-smoothing': ['auto'],
  'text-underline-offset': ['auto'], 'text-indent': ['0px'], 'word-spacing': ['normal', '0px'],
  'text-orientation': ['mixed'], 'text-emphasis-style': ['none'],
}

/** Computed values only. Empty means that the engine does not expose the property. */
export function nativeStyleReason(style: CSSStyleDeclaration, context: 'text' | 'cell' | 'list' | 'section' | 'structural' = 'text', separateBackground = false): string | undefined {
  const unsupported = (property: string, value: string) => `Unsupported CSS ${property}: ${value}`
  if (context === 'section') {
    try { cssColor(style.backgroundColor) } catch { return unsupported('background-color', style.backgroundColor) }
    if (style.textDecorationLine && style.textDecorationLine !== 'none') return unsupported('section text-decoration-line', style.textDecorationLine)
    return undefined
  }
  const approximated = new Set(styleApproximations(style).map(a => a.property))
  for (const [property, allowed] of Object.entries(VALUES)) {
    const value = style.getPropertyValue(property)
    if (value && !allowed.includes(value) && !approximated.has(property)) return unsupported(property, value)
  }
  const vertical = style.verticalAlign
  const alignments = context === 'cell' ? ['top', 'middle', 'bottom'] : ['baseline', 'super', 'sub']
  if (context !== 'structural' && vertical && !alignments.includes(vertical)) return unsupported('vertical-align', vertical)
  const decoration = style.textDecorationLine
  if (decoration && decoration !== 'none' && !decoration.split(/\s+/).every(value => ['underline', 'line-through'].includes(value))) return unsupported('text-decoration-line', decoration)
  if (decoration && decoration !== 'none' && style.textDecorationColor && style.textDecorationColor !== style.color) return unsupported('text-decoration-color', style.textDecorationColor)
  for (const property of ['letter-spacing', 'font-size', 'line-height']) {
    const value = style.getPropertyValue(property)
    if (!value || approximated.has(property) || (property !== 'font-size' && value === 'normal')) continue
    try { if (pixels(value) < (property === 'letter-spacing' ? 0 : Number.MIN_VALUE)) return unsupported(property, value) }
    catch { return unsupported(property, value) }
  }
  for (const property of ['color', 'background-color']) {
    if (separateBackground && property === 'background-color') continue
    const value = style.getPropertyValue(property)
    if (value) try { cssColor(value) } catch { return unsupported(property, value) }
  }
  for (const side of separateBackground ? [] : ['top', 'right', 'bottom', 'left']) {
    const width = style.getPropertyValue(`border-${side}-width`)
    if (!width || pixels(width) === 0) continue
    const type = style.getPropertyValue(`border-${side}-style`)
    if (!['none', 'hidden', 'solid'].includes(type)) return unsupported(`border-${side}-style`, type)
    const color = style.getPropertyValue(`border-${side}-color`)
    try { if (cssColor(color).transparency % 100 !== 0 && !approximated.has(`border-${side}-color`)) return unsupported(`border-${side}-color`, color) }
    catch { return unsupported(`border-${side}-color`, color) }
  }
  if (context === 'list') {
    if (!supportedMarker(style.listStyleType)) return unsupported('list-style-type', style.listStyleType)
    if (style.listStylePosition && style.listStylePosition !== 'outside') return unsupported('list-style-position', style.listStylePosition)
  }
  return undefined
}
