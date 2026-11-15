import { describe, expect, it } from 'vitest'
import { Marp } from '@marp-team/marp-core'
import { createBoxMarp } from './boxHtml'
import { svgHtmlAllowlist } from '../export/pptx/svgAllowlist'

const open = '<div data-box style="position:absolute; left:1px; top:2px; width:3px; font-size:32pt">'
describe('box HTML rendering', () => {
  it('admits only a paired box and keeps inner markdown', () => {
    const html = createBoxMarp().render(`${open}\n\n**text**\n\n</div>`).html
    expect(html).toContain(open)
    expect(html).toContain('<strong>text</strong>')
  })

  it('renders all other div HTML exactly as the normal allowlist does', () => {
    const inputs = [
      `${open}\n\nunclosed`, `${open}\n\n---\n\n</div>`,
      `${open}\n\n<div data-box style="position:absolute; left:1px; top:2px; width:3px">\n\nx\n\n</div>\n\n</div>`,
      '<div style="position:absolute; left:1px; top:2px; width:3px" onclick="alert(1)">\n\nx\n\n</div>',
      'inline <div data-box style="position:absolute; left:1px; top:2px; width:3px">x</div>',
      `${open.replace('font-size:32pt', 'background:url(https://example.com/x)')}\n\nx\n\n</div>`,
      `${open.replace('data-box ', 'data-box onclick="alert(1)" ')}\n\nx\n\n</div>`,
    ]
    for (const input of inputs) {
      expect(createBoxMarp().render(input).html, input).toBe(new Marp({ script: false, math: 'mathjax' }).render(input).html)
    }
  })

  it('does not admit scripts and preserves the SVG export rules', () => {
    const html = createBoxMarp({ svgHtmlAllowlist }).render(`${open}\n\nx\n\n</div>\n\n<script>alert(1)</script>\n\n<svg viewBox="0 0 10 10"><rect width="2" height="2" /></svg>`).html
    expect(html).not.toContain('<script>')
    expect(html).toContain('<svg viewbox="0 0 10 10">')
  })

  it('shows paired boxes in headingDivider documents while not pairing across generated slides', () => {
    const marp = createBoxMarp()
    const source = `---\nheadingDivider: 2\n---\n\n## One\n\n${open}\n\ntext\n\n</div>\n\n## Two`
    expect(marp.render(source).html).toContain(open)
    const crossed = `---\nheadingDivider: 2\n---\n\n## One\n\n${open}\n\ntext\n\n## Two\n\n</div>`
    expect(marp.render(crossed).html).toBe(new Marp({ script: false, math: 'mathjax' }).render(crossed).html)
  })
})
