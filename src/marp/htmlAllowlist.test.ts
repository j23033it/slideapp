import { describe, expect, it } from 'vitest'
import { Marp } from '@marp-team/marp-core'
import { boxHtmlAllowlist, boxStyle } from './htmlAllowlist'

describe('text box style allowlist', () => {
  it('preserves the specified declarations and optional font size', () => {
    for (const style of [
      'position:absolute; left:320px; top:240px; width:640px',
      ' position : absolute ; left : -10px ; top : -20px ; width : 40px ; font-size : 32pt ',
    ]) expect(boxStyle(style)).toBe(style)
  })

  it('drops the whole value for extra declarations or different syntax', () => {
    for (const style of [
      'position:absolute; left:1px; top:2px; width:3px; background:url(javascript:alert(1))',
      'position:absolute; top:2px; left:1px; width:3px',
      'position:absolute; left:1.5px; top:2px; width:3px',
      'position:absolute; left:1px; top:2px; width:3px; font-size:32px',
      'position:absolute; left:1px; top:2px; width:3px\n; color:red',
      'position:absolute; left:1px; top:2px; width:3px\n',
    ]) expect(boxStyle(style)).toBe('')
  })

  it('removes event attributes and dangerous styles in Marp output', () => {
    const marp = new Marp({ script: false, html: boxHtmlAllowlist })
    const html = marp.render('<div data-box style="position:absolute; left:1px; top:2px; width:3px; background:url(https://example.com/x)" onclick="alert(1)">\n\ntext\n\n</div>\n\n<script>alert(1)</script>').html
    expect(html).not.toContain('onclick=')
    expect(html).not.toContain('background:url')
    expect(html).not.toContain('<script>')
  })
})
