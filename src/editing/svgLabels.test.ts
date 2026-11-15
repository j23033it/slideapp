import { describe, expect, it } from 'vitest'
import { DocumentModel } from '../document'
import { MarpRenderer } from '../marp/renderer'
import { collectSvgLabelGroups } from './svgLabels'
import type { Token } from './markdown-types'

const svg = '<svg viewBox="0 0 100 100">\n<text x="1" y="2">送信</text><text x="2" y="3">受信</text>\n</svg>'
describe('SVG label editing', () => {
  it('edits only the recorded text range, escapes XML, and supports undo', () => {
    const original = `# flow\r\n\r\n${svg.replaceAll('\n', '\r\n')}\r\n`
    const model = new DocumentModel(original, { hasBom: true })
    const renderer = new MarpRenderer(path => path)
    renderer.analyze(model.text, null)
    const groups = renderer.editing.svgLabelGroups()
    expect(groups.map(g => g.labels.map(x => x.text))).toEqual([['送信', '受信']])
    const result = renderer.editing.applySvgLabelEdit(model.text, 0, 0, 'A < B & C')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    model.edit(result.edit)
    expect(model.serialize()).toBe(original.replace('送信', 'A &lt; B &amp; C'))
    expect(renderer.editing.svgLabelGroups()[0]!.labels[0]!.text).toBe('A < B & C')
    model.undo(); expect(model.serialize()).toBe(original)
    expect(model.hasBom).toBe(true)
  })
  it('keeps positions isolated when a different slide uses the same SVG text', () => {
    const source = `# one\n\n${svg}\n\n---\n\n# two\n\n${svg}\n`
    const renderer = new MarpRenderer(path => path)
    renderer.analyze(source, null)
    expect(renderer.editing.svgLabelGroups().map(group => group.slide)).toEqual([0, 1])
    const result = renderer.editing.applySvgLabelEdit(source, 1, 1, '別の値')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const position = source.lastIndexOf('受信')
    expect(result.newText).toBe(source.slice(0, position) + '別の値' + source.slice(position + '受信'.length))
  })
  it('refuses boundary ambiguity even when position-dependent CSS is also present', () => {
    const token = { type: 'html_block', map: [0, 3], content: svg } as unknown as Token
    const groups = collectSvgLabelGroups(svg, [token], {
      bodies: [{ start: 0, end: svg.length }], separators: [], inheritedSettings: [], boundariesAmbiguous: true,
      reason: { code: 'slide-position-css', description: 'position-dependent CSS' },
    })
    expect(groups).toEqual([])
  })
  it('rejects stale sources, control characters, nested or ambiguous labels', () => {
    const renderer = new MarpRenderer(path => path)
    renderer.analyze(svg, null)
    expect(renderer.editing.applySvgLabelEdit(svg + 'x', 0, 0, 'x').ok).toBe(false)
    expect(renderer.editing.applySvgLabelEdit(svg, 0, 0, 'x\ny').ok).toBe(false)
    const nested = '<svg>\n<text><tspan>nested</tspan></text>\n</svg>'
    renderer.analyze(nested, null)
    expect(renderer.editing.svgLabelGroups()).toEqual([])
  })
})
