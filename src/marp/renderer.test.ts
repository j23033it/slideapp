import { describe, expect, it } from 'vitest'

import sample from '../../tests/fixtures/sample.md?raw'
import { MarpRenderer } from './renderer'
import { DocumentModel } from '../document'

describe('MarpRenderer', () => {
  it('renders the sample deck and rewrites relative image paths', () => {
    const renderer = new MarpRenderer((path) => `asset://localhost/${encodeURIComponent(path)}`)
    const deck = renderer.render(sample, 'C:\\deck')

    expect(deck.slides).toHaveLength(5)
    expect(deck.width).toBe(1280)
    expect(deck.height).toBe(720)

    const backgroundSlide = deck.slides[3] ?? ''
    expect(backgroundSlide).toContain('asset://localhost/')
    expect(backgroundSlide).toContain('sample.png')
    expect(backgroundSlide).not.toContain('url(&quot;images/sample.png&quot;)')
  })

  it('registers custom themes on the render engine and invalidates a cached deck', () => {
    const renderer = new MarpRenderer((path) => `asset://localhost/${encodeURIComponent(path)}`)
    const markdown = '<!-- theme: custom -->\n\n# Theme'

    renderer.setThemes([
      {
        path: 'C:\\deck\\themes\\custom.css',
        css: '/* @theme custom */\nsection { color: #123456; }',
      },
    ])
    expect(renderer.render(markdown, 'C:\\deck').css).toContain('#123456')

    renderer.setThemes([
      {
        path: 'C:\\deck\\themes\\custom.css',
        css: '/* @theme custom */\nsection { color: #abcdef; }',
      },
    ])
    const updated = renderer.render(markdown, 'C:\\deck')

    expect(updated.css).toContain('#abcdef')
    expect(updated.css).not.toContain('#123456')
  })
  it('preserves SVG HTML through a heading edit and undo', () => {
    const svg = '<svg viewBox="0 0 100 40">\r\n<defs><marker id="arrow"><path d="M0 0 L10 5 L0 10 z"/></marker></defs><path d="M0 0 L90 0" marker-end="url(#arrow)"/><text x="2" y="20">diagram text</text>\r\n</svg>'
    const original = `# Jev版の処理フロー\r\n\r\n${svg}\r\n`
    const model = new DocumentModel(original, { hasBom: true })
    const renderer = new MarpRenderer(path => path)
    const { analysis, deck } = renderer.analyze(model.text, null)
    expect(deck.slides[0]).toContain('<svg viewbox=')
    expect(deck.slides[0]).toContain('<marker id="arrow"')
    expect(analysis.runs.some(run => run.text.includes('diagram text'))).toBe(false)
    expect(analysis.elementSources?.elements.map(element => element.kind)).toEqual(['heading'])
    const run = analysis.runs.find(item => item.text === 'Jev版の処理フロー')!
    const edit = renderer.editing.applyRunEdit(model.text, run.id, '変更済み')
    expect(edit.ok).toBe(true)
    if (!edit.ok) return
    model.edit(edit.edit)
    expect(model.serialize()).toContain(svg + '\r\n')
    model.undo()
    expect(model.serialize()).toBe(original)
    expect(model.hasBom).toBe(true)
  })

  it('refuses editing text within a single-line SVG', () => {
    const renderer = new MarpRenderer(path => path)
    const source = '<svg viewBox="0 0 10 10"><text>read only</text></svg>'
    const { analysis } = renderer.analyze(source, null)
    const run = analysis.runs.find(item => item.text === 'read only')!
    expect(run.editable).toBe(false)
    expect(renderer.editing.applyRunEdit(source, run.id, 'changed').ok).toBe(false)
  })

  it('retains the SVG allowlist restrictions', () => {
    const renderer = new MarpRenderer(path => path)
    const deck = renderer.render('<svg><script>alert(1)</script><foreignObject>bad</foreignObject><path onclick="alert(1)" d="M0 0 L1 1"/></svg>', null)
    expect(deck.slides[0]).not.toContain('<script>')
    expect(deck.slides[0]).not.toContain('<foreignObject>')
    expect(deck.slides[0]).not.toContain('onclick=')
  })
})
