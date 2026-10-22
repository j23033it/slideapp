// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { nativeStyleReason, pixels, styleApproximations, nativeLetterSpacing, borderColor } from '../../src/export/pptx/styles'
import { cssColor, toTextOptions, supportedMarker, type Paragraph } from '../../src/export/pptx/model'

describe('native style allowlists', () => {
  it.each([
    ['list-style-type', 'lower-greek'], ['list-style-type', 'decimal-leading-zero'],
    ['list-style-type', '"custom"'], ['list-style-position', 'inside'],
    ['text-align', 'match-parent'], ['vertical-align', 'text-top'],
    ['font-weight', '500'], ['font-style', 'oblique'], ['font-stretch', 'condensed'],
    ['text-decoration-line', 'overline'], ['text-decoration-style', 'wavy'],
    ['color', 'color(display-p3 1 0 0)'], ['background-color', 'lab(50 0 0)'],
    ['writing-mode', 'vertical-rl'], ['direction', 'rtl'], ['unicode-bidi', 'bidi-override'],
    ['letter-spacing', '-2px'], ['white-space', 'break-spaces'], ['white-space', 'pre-line'],
    ['word-spacing', '3px'], ['text-indent', '12px'], ['font-variant-caps', 'small-caps'],
    ['border-top-style', 'dashed'],
  ])('rejects %s:%s with its actual value', (property, value) => {
    const style = document.createElement('span').style
    if (property.startsWith('list-')) style.listStyleType = 'disc'
    style.setProperty(property, value)
    // These modern colors are valid in Chromium but not parsed by happy-dom.
    if (property === 'color' || property === 'background-color') {
      const read = style.getPropertyValue.bind(style)
      style.getPropertyValue = key => key === property ? value : read(key)
    }
    if (property === 'border-top-style') { style.borderTopWidth = '2px'; style.borderTopColor = 'rgb(0,0,0)' }
    expect(nativeStyleReason(style, property.startsWith('list-') ? 'list' : 'text')).toContain(`${property}: ${value}`)
  })
  it.each(['none', 'disc', 'circle', 'square', 'decimal', 'lower-alpha', 'upper-alpha', 'lower-roman', 'upper-roman'])('shares the supported marker map for %s', type => expect(supportedMarker(type)).toBe(true))
  it('never serializes an unknown marker as a default bullet', () => {
    const p: Paragraph = { rect: {x:0,y:0,width:200,height:40}, runs: [], align:'left', lineHeight:40, spaceBefore:0, spaceAfter:0, padding:[0,0,0,0], list:{level:0,type:'lower-greek',start:1,indent:20} }
    expect(() => toTextOptions(p)).toThrow('list-style-type: lower-greek')
    expect(() => toTextOptions({...p,list:{...p.list!,type:'disc',level:9}})).toThrow('list level')
    expect(() => toTextOptions({...p,list:{...p.list!,type:'decimal',start:0}})).toThrow('list start')
  })
  it.each(['auto', '2em', 'garbage', 'NaNpx'])('does not coerce %s into zero pixels', value => expect(() => pixels(value)).toThrow('length'))
  it.each(['rgb(999,0,0)', 'rgba(0,0,0,2)', 'color(display-p3 1 0 0)', 'rgb(1%,2%,3%)'])('does not coerce %s into RGB', value => expect(() => cssColor(value)).toThrow('color'))
})

describe('bounded native approximations', () => {
  const computed = (property: string, value: string) => {
    const style = document.createElement('span').style
    style.fontSize = '32px'
    style.borderTop = '1px solid rgb(0,0,0)'
    style.setProperty(property, value)
    const read = style.getPropertyValue.bind(style)
    style.getPropertyValue = key => key === property ? value : read(key)
    return style
  }
  it.each([
    ['text-underline-offset', '6.4px'], ['text-underline-offset', '-1px'],
    ['text-decoration-thickness', '2px'], ['text-decoration-thickness', 'from-font'],
    ['font-variant-numeric', 'tabular-nums'], ['font-variant-numeric', 'lining-nums proportional-nums'],
    ['font-feature-settings', '"kern" 0, "tnum"'], ['font-kerning', 'none'], ['font-kerning', 'normal'],
    ['text-rendering', 'optimizeLegibility'], ['text-rendering', 'geometricPrecision'],
    ['-webkit-font-smoothing', 'antialiased'], ['-webkit-font-smoothing', 'subpixel-antialiased'],
    ['letter-spacing', '-0.5px'], ['letter-spacing', '1px'],
    ['border-top-color', 'rgba(0,0,0,.3)'],
  ])('keeps %s:%s native and reports the applied approximation', (property, value) => {
    const style = computed(property, value)
    expect(nativeStyleReason(style)).toBeUndefined()
    expect(styleApproximations(style)).toContainEqual({property,value,replacement:expect.any(String)})
  })
  it.each([
    ['text-underline-offset', '40px'], ['text-decoration-thickness', '15px'],
    ['font-variant-numeric', 'diagonal-fractions'], ['font-variant-numeric', 'slashed-zero'],
    ['font-feature-settings', '"smcp" 1'], ['letter-spacing', '-2px'],
  ])('still rasterizes a substantial or content-changing %s:%s', (property, value) => {
    expect(nativeStyleReason(computed(property, value))).toContain(property)
    expect(styleApproximations(computed(property, value))).not.toContainEqual(expect.objectContaining({property}))
  })
  it('uses the same small spacing rule when serializing', () => {
    const style = computed('letter-spacing', '-0.5px')
    expect(nativeLetterSpacing(style)).toBe(0)
    style.letterSpacing = '2px'
    style.getPropertyValue = key => key === 'letter-spacing' ? '2px' : key === 'font-size' ? '32px' : ''
    expect(nativeLetterSpacing(style)).toBe(2)
  })
  it('composites translucent borders over nested translucent solid backgrounds', () => {
    const section = document.createElement('section')
    section.style.backgroundColor = 'rgb(0,0,255)'
    section.innerHTML = '<table style="background-color:rgba(255,0,0,.5)"><tbody><tr><td>Cell</td></tr></tbody></table>'
    document.body.append(section)
    try { expect(borderColor(section.querySelector('td')!, 'rgba(0,0,0,.5)')).toBe('400040') }
    finally { section.remove() }
  })
})
