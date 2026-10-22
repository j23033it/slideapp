/** DOM-independent decisions. Measurements supply facts; unsupported content never disappears. */
export interface ElementFacts {
  kind: 'text' | 'list' | 'table' | 'section'
  math?: boolean
  emoji?: boolean
  effects?: boolean
  background?: boolean
  verticalText?: boolean
  rounded?: boolean
  customMarker?: boolean
  pseudo?: boolean
  inlineDecoration?: boolean
  hiddenLayout?: boolean
  textTransform?: boolean
  image?: boolean
  complexList?: boolean
  mergedCells?: boolean
  unsupportedCellAlignment?: boolean
}

export function rasterReason(facts: ElementFacts): string | undefined {
  if (facts.effects) return 'CSS transform, filter, shadow or opacity'
  if (facts.pseudo) return 'CSS pseudo-element decoration'
  if (facts.kind === 'section') return undefined
  if (facts.math) return 'Math or SVG'
  if (facts.emoji) return 'Emoji'
  if (facts.background) return 'CSS background decoration'
  if (facts.verticalText) return 'Vertical text'
  if (facts.rounded) return 'Rounded CSS decoration'
  if (facts.customMarker) return 'Custom or reversed list marker'
  if (facts.inlineDecoration) return 'Inline CSS decoration'
  if (facts.hiddenLayout) return 'Hidden inline layout'
  if (facts.textTransform) return 'CSS text-transform'
  if (facts.image) return facts.kind === 'table' ? 'Image in table cell' : 'Inline image layout'
  if (facts.complexList) return 'Complex list content'
  if (facts.mergedCells) return 'Merged table cells'
  if (facts.unsupportedCellAlignment) return 'Unsupported table vertical alignment'
  return undefined
}

export interface PseudoFacts {
  content: string; display: string; visibility: string
  background: boolean; border: boolean; effects: boolean; sized: boolean
}
export function pseudoIsGenerated(facts: PseudoFacts): boolean {
  return !!facts.content && !['none', 'normal'].includes(facts.content) && facts.display !== 'none' && facts.visibility !== 'hidden'
}
/** Empty generated boxes still paint. Plain section pagination remains native text. */
export function pseudoNeedsRaster(facts: PseudoFacts, section = false): boolean {
  if (!pseudoIsGenerated(facts)) return false
  return !section || facts.background || facts.border || facts.effects || (['""', "''"].includes(facts.content) && facts.sized) || /url\(|counter\(/.test(facts.content)
}

export function cellAlignment(value: string): 'top' | 'middle' | 'bottom' | undefined {
  return value === 'top' || value === 'middle' || value === 'bottom' ? value : undefined
}
