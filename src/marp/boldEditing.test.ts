import { describe, expect, it } from 'vitest'
import { MarpRenderer } from './renderer'
import { DocumentModel } from '../document'

describe('bold editing', () => {
  it.each([
    ['hello world', 0, 5, '**hello** world'],
    ['hello world', 6, 11, 'hello **world**'],
    ['abc def', 0, 7, '**abc def**'],
    ['say hello world today', 3, 16, 'say **hello world** today'],
    [' hello world ', 0, 11, ' **hello world** '],
  ])('adds bold to %s', (source, start, end, expected) => {
    const renderer = new MarpRenderer(path => path)
    const run = renderer.analyze(source, null).analysis.runs[0]
    const result = renderer.editing.applyBold(source, { runId: run.id, offset: start }, { runId: run.id, offset: end })
    expect(result.ok && result.newText).toBe(expected)
  })
  it.each(['**hello**', '__hello__', '***hello***'])('removes %s', source => {
    const renderer = new MarpRenderer(path => path)
    const run = renderer.analyze(source, null).analysis.runs[0]
    const result = renderer.editing.applyBold(source, { runId: run.id, offset: 1 }, { runId: run.id, offset: 1 })
    expect(result.ok).toBe(true)
  })
  it.each([
    ['日本語です', 0, 3, '**日本語**です'],
    ['hello 世界', 6, 8, 'hello **世界**'],
    ['[hello](https://example.com)', 0, 5, '[**hello**](https://example.com)'],
    ['*hello*', 0, 5, '***hello***'],
    ['| a |\n| --- |\n| hello |', 0, 5, '| a |\n| --- |\n| **hello** |'],
    ['<div data-box style="position:absolute; left:1px; top:2px; width:100px">\n\nhello\n\n</div>', 0, 5, '<div data-box style="position:absolute; left:1px; top:2px; width:100px">\n\n**hello**\n\n</div>'],
  ])('preserves surrounding structure in %s', (source, start, end, expected) => {
    const renderer = new MarpRenderer(path => path)
    const run = renderer.analyze(source, null).analysis.runs.find(entry => entry.text === (source.startsWith('日本') ? '日本語です' : source.startsWith('hello') ? 'hello 世界' : 'hello'))!
    const result = renderer.editing.applyBold(source, { runId: run.id, offset: start }, { runId: run.id, offset: end })
    expect(result.ok && result.newText).toBe(expected)
  })
  it('rejects a partial selection in bold and a collapsed selection outside it', () => {
    const renderer = new MarpRenderer(path => path)
    const run = renderer.analyze('**hello**', null).analysis.runs[0]
    expect(renderer.editing.applyBold('**hello**', { runId: run.id, offset: 0 }, { runId: run.id, offset: 2 })).toMatchObject({ ok: false, reason: { code: 'bold-partial' } })
    const plain = renderer.analyze('hello', null).analysis.runs[0]
    expect(renderer.editing.applyBold('hello', { runId: plain.id, offset: 1 }, { runId: plain.id, offset: 1 })).toMatchObject({ ok: false, reason: { code: 'bold-invalid-position' } })
  })
  it('rejects Japanese punctuation where delimiter flanking does not create strong emphasis', () => {
    const renderer = new MarpRenderer(path => path)
    const source = '文「引用」文'
    const run = renderer.analyze(source, null).analysis.runs[0]
    const result = renderer.editing.applyBold(source, { runId: run.id, offset: 1 }, { runId: run.id, offset: 2 })
    expect(result).toMatchObject({ ok: false, reason: { code: 'bold-invalid-position' } })
  })
  it('removes an exactly selected bold span and rejects a selection across decorations', () => {
    const renderer = new MarpRenderer(path => path)
    const source = 'plain **bold** tail'
    const runs = renderer.analyze(source, null).analysis.runs
    const bold = runs.find(run => run.text === 'bold')!
    const removed = renderer.editing.applyBold(source, { runId: bold.id, offset: 0 }, { runId: bold.id, offset: 4 })
    expect(removed.ok && removed.newText).toBe('plain bold tail')
    const fresh = renderer.editing.analyze(source).runs
    expect(renderer.editing.applyBold(source, { runId: fresh[0].id, offset: 0 }, { runId: fresh[1].id, offset: 4 })).toMatchObject({ ok: false, reason: { code: 'bold-multiple-runs' } })
  })
  it('uses original marker positions after an earlier empty-cell probe', () => {
    const source = '| empty | text |\n| --- | --- |\n|  | **word** |'
    const renderer = new MarpRenderer(path => path)
    const run = renderer.analyze(source, null).analysis.runs.find(item => item.text === 'word')!
    const result = renderer.editing.applyBold(source, { runId: run.id, offset: 2 }, { runId: run.id, offset: 2 })
    expect(result.ok && result.newText).toBe('| empty | text |\n| --- | --- |\n|  | word |')
  })
  it('keeps mixed line endings and BOM through a single undo and redo', () => {
    const model = new DocumentModel('hello world\r\n\nsecond\r\n', { hasBom: true })
    const original = model.serialize()
    const renderer = new MarpRenderer(path => path)
    const run = renderer.analyze(model.text, null).analysis.runs[0]
    const result = renderer.editing.applyBold(model.text, { runId: run.id, offset: 0 }, { runId: run.id, offset: 5 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    model.editTransaction(result.edit)
    const changed = model.serialize()
    expect(changed).toBe('**hello** world\r\n\nsecond\r\n')
    expect(model.hasBom).toBe(true)
    model.undo(); expect(model.serialize()).toBe(original)
    model.redo(); expect(model.serialize()).toBe(changed)
  })
})
