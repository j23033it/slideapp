import { describe, expect, it } from 'vitest'
import { cellAlignment, pseudoNeedsRaster, rasterReason, type ElementFacts, type PseudoFacts } from '../../src/export/pptx/classify'
import { effectInsets } from '../../src/export/pptx/raster'

describe('native eligibility is a pure decision', () => {
  it.each<[ElementFacts, string | undefined]>([
    [{ kind: 'text' }, undefined],
    [{ kind: 'text', image: true }, 'Inline image layout'],
    [{ kind: 'table', image: true }, 'Image in table cell'],
    [{ kind: 'list', complexList: true }, 'Complex list content'],
    [{ kind: 'text', inlineDecoration: true }, 'Inline CSS decoration'],
    [{ kind: 'text', hiddenLayout: true }, 'Hidden inline layout'],
    [{ kind: 'text', textTransform: true }, 'CSS text-transform'],
    [{ kind: 'text', pseudo: true }, 'CSS pseudo-element decoration'],
    [{ kind: 'section', pseudo: true }, 'CSS pseudo-element decoration'],
    [{ kind: 'section', effects: true }, 'CSS transform, filter, shadow or opacity'],
    [{ kind: 'table', mergedCells: true }, 'Merged table cells'],
    [{ kind: 'table', unsupportedCellAlignment: true }, 'Unsupported table vertical alignment'],
  ])('%j → %s', (facts, reason) => expect(rasterReason(facts)).toBe(reason))

  const pseudo: PseudoFacts = { content: '""', display: 'block', visibility: 'visible', background: false, border: false, effects: false, sized: true }
  it('detects an empty generated box on both blocks and sections', () => {
    expect(pseudoNeedsRaster(pseudo)).toBe(true)
    expect(pseudoNeedsRaster(pseudo, true)).toBe(true)
    expect(pseudoNeedsRaster({ ...pseudo, background: true }, true)).toBe(true)
    expect(pseudoNeedsRaster({ ...pseudo, content: 'none' }, true)).toBe(false)
    expect(pseudoNeedsRaster({ ...pseudo, display: 'none' }, true)).toBe(false)
    expect(pseudoNeedsRaster({ ...pseudo, content: '"3"' }, true)).toBe(false)
    expect(pseudoNeedsRaster({ ...pseudo, content: 'url("asset.png")' }, true)).toBe(true)
  })
  it.each(['top', 'middle', 'bottom'] as const)('retains cell alignment %s', value => expect(cellAlignment(value)).toBe(value))
  it('rejects unsupported baseline cell alignment', () => expect(cellAlignment('baseline')).toBeUndefined())
})

describe('raster effect bounds', () => {
  it('includes a hard shadow outside the border box', () => {
    expect(effectInsets('rgb(255, 0, 0) 20px 0px 0px 0px', 'none', 'none')).toEqual({ top: 2, right: 22, bottom: 2, left: 0 })
  })
  it('includes blurred shadows and composed filter overflow on every side', () => {
    const bounds = effectInsets('-10px 12px 6px 2px rgba(0, 0, 0, .5)', 'none', 'blur(4px) drop-shadow(rgb(0, 0, 0) 30px 0px 3px)')
    expect(bounds.left).toBeGreaterThanOrEqual(10 + 18 + 2 + 12)
    expect(bounds.right).toBeGreaterThanOrEqual(30 + 9 + 12)
    expect(bounds.bottom).toBeGreaterThanOrEqual(12 + 18 + 2 + 12)
    expect(effectInsets('none', 'none', 'none')).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })
})
