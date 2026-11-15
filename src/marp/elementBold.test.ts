import { describe, it, expect } from 'vitest'
import { MarpRenderer } from './renderer'
import { DocumentModel } from '../document'

describe('element bold', () => {
  it.each([
    ['hello', '**hello**'],
    ['part **bold** text', '**part bold text**'],
    ['**hello**', 'hello'],
    ['__hello__', 'hello'],
    ['***hello***', '*hello*'],
    ['# hello', '# **hello**'],
    ['「引用」、終わり。', '**「引用」、終わり。**'],
    ['**one** and __two__', '**one and two**'],
    ['- **one**\n- __two__', '- one\n- two'],
    ['> quote\n>\n> another', '> **quote**\n>\n> **another**'],
    ['- one\n  - two\n- three', '- **one**\n  - **two**\n- **three**'],
    ['[link](https://example.com) and *em*', '**[link](https://example.com) and *em***'],
    ['| head | code |\n| --- | --- |\n|  | `code` |', '| **head** | **code** |\n| --- | --- |\n|  | **`code`** |'],
    ['<div data-box style="position:absolute; left:1px; top:2px; width:100px">\n\none\n\ntwo\n\n</div>', '<div data-box style="position:absolute; left:1px; top:2px; width:100px">\n\n**one**\n\n**two**\n\n</div>'],
  ])('toggles %s', (source, expected) => {
    const renderer = new MarpRenderer(path => path)
    const analysis = renderer.analyze(source, null).analysis
    const element = analysis.elementSources!.elements[0]
    const result = renderer.editing.applyElementBold(source, element.id)
    expect(result.ok && result.newText).toBe(expected)
  })
  it('reports pressed state only when every nonempty group is fully bold', () => {
    const renderer = new MarpRenderer(path => path)
    const source = '| **head** | __other__ |\n| --- | --- |\n|  | ***body*** |'
    const element = renderer.analyze(source, null).analysis.elementSources!.elements[0]
    expect(renderer.editing.isElementBold(element.id)).toBe(true)
    const changed = renderer.editing.applyElementBold(source, element.id)
    expect(changed.ok && changed.newText).toBe('| head | other |\n| --- | --- |\n|  | *body* |')
    expect(renderer.editing.isElementBold(element.id)).toBe(false)
  })
  it('rejects an unsafe element without changing the source', () => {
    const renderer = new MarpRenderer(path => path)
    const source = 'one <span>two</span>'
    const element = renderer.analyze(source, null).analysis.elementSources!.elements[0]
    expect(renderer.editing.applyElementBold(source, element.id)).toMatchObject({ ok: false, reason: { code: 'bold-invalid-position' } })
  })
  it('preserves mixed EOL and BOM and uses one undo/redo', () => {
    const model = new DocumentModel('- one\r\n- two\n\r\nafter\r\n', { hasBom: true })
    const original = model.serialize()
    const renderer = new MarpRenderer(path => path)
    const element = renderer.analyze(model.text, null).analysis.elementSources!.elements[0]
    const result = renderer.editing.applyElementBold(model.text, element.id)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    model.editTransaction(result.edit)
    const changed = model.serialize()
    expect(changed).toBe('- **one**\r\n- **two**\n\r\nafter\r\n')
    expect(model.hasBom).toBe(true)
    model.undo(); expect(model.serialize()).toBe(original)
    model.redo(); expect(model.serialize()).toBe(changed)
  })
})
