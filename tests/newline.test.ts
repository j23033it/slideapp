import { Marp } from '@marp-team/marp-core'
import { describe, expect, it } from 'vitest'
import { createEngine, resolveCursor } from '../src/editing'
import { DocumentModel } from '../src/document'

describe('validated newline range edits', () => {
  const cases = [
    ['abcd', 'paragraph', 'ab\n\ncd'],
    ['abcd', 'line', 'ab\ncd'],
    ['- abcd\n- next', 'line', '- ab\n  cd\n- next'],
    ['- abcd\n- next', 'paragraph', '- ab\n- cd\n- next'],
    ['+ abcd', 'paragraph', '+ ab\n+ cd'],
    ['* abcd', 'paragraph', '* ab\n* cd'],
    ['7. abcd\n2. next', 'paragraph', '7. ab\n8. cd\n2. next'],
    ['7) abcd\n2) next', 'paragraph', '7) ab\n8) cd\n2) next'],
    ['- parent\n  - abcd\n  - next', 'line', '- parent\n  - ab\n    cd\n  - next'],
    ['- parent\n  - abcd\n  - next', 'paragraph', '- parent\n  - ab\n  - cd\n  - next'],
    ['> abcd', 'line', '> ab\n> cd'],
    ['> abcd', 'paragraph', '> ab\n>\n> cd'],
    ['> > abcd', 'line', '> > ab\n> > cd'],
    ['> - abcd', 'line', '> - ab\n>   cd'],
    ['> - abcd', 'paragraph', '> - ab\n> - cd'],
    ['- > abcd', 'line', '- > ab\n  > cd'],
    ['- abcd\n  continuation', 'line', '- ab\n  cd\n  continuation'],
    ['- ab\n  cdxy', 'line', '- ab\n  cd\n  xy'],
    ['before **bold** abcd *after*', 'paragraph', 'before **bold** ab\n\ncd *after*'],
  ] as const
  it.each(cases)('%s: %s produces only the intended structure', (source, kind, expected) => {
    const engine = createEngine(new Marp({ script: false }))
    const analysis = engine.analyze(source)
    const run = analysis.runs.find(run => run.text.includes('abcd') || run.text === 'cdxy')!
    const offset = run.text.includes('abcd') ? run.text.indexOf('abcd') + 2 : 2
    const result = engine.applyNewline(source, run.id, offset, kind)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.newText).toBe(expected)
    expect(result.edit.start).toBe(result.edit.end)
    expect(result.analysis.runs.find(run => run.id === result.cursor.runId)?.text.startsWith(kind === 'line' && source.includes('cdxy') ? 'xy' : 'cd')).toBe(true)
    expect(result.cursor.offset).toBe(0)
    expect(engine.applyRunEdit(result.newText, result.cursor.runId, 'changed').ok).toBe(true)
  })

  it.each([
    ['# abcd', 'abcd', 2], ['**abcd**', 'abcd', 2], ['[abcd](https://example.com)', 'abcd', 2],
    ['| abcd |\n| --- |', 'abcd', 2], ['abcd', 'abcd', 0],
    ['- abcd\n  - child', 'abcd', 2], ['- abcd\n\n  second', 'abcd', 2],
    ['ab&amp;cd', 'ab&cd', 3], ['- ab# cd', 'ab# cd', 2],
  ] as const)('rejects unsafe paragraph splitting: %s', (source, target, offset) => {
    const engine = createEngine(new Marp({ script: false }))
    const analysis = engine.analyze(source)
    const run = analysis.runs.find(run => run.text === target)!
    expect(engine.applyNewline(source, run.id, offset, 'paragraph').ok).toBe(false)
    if (run.editable) expect(engine.applyRunEdit(source, run.id, target + '!').ok).toBe(true)
  })

  it('keeps newline undo separate from typing before and after, retaining mixed EOL bytes', () => {
    const raw = 'abcd\r\n\r\nuntouched\nlast\r\n'
    const model = new DocumentModel(raw, { hasBom: true })
    const engine = createEngine(new Marp({ script: false }))
    const analysis = engine.analyze(model.text)
    let run = analysis.runs[0]
    const typed = engine.applyRunEdit(model.text, run.id, 'abXcd')
    if (!typed.ok) throw new Error(typed.reason.description)
    model.edit(typed.edit, { before: { runId: run.id, offset: 2 }, after: { runId: run.id, offset: 3 }, time: 0 })
    const split = engine.applyNewline(model.text, run.id, 3, 'paragraph')
    if (!split.ok) throw new Error(split.reason.description)
    model.edit(split.edit, { before: { runId: run.id, offset: 3 }, after: split.cursor, time: 1 })
    expect(model.serialize()).toBe('abX\r\n\r\ncd\r\n\r\nuntouched\nlast\r\n')
    run = split.analysis.runs.find(run => run.id === split.cursor.runId)!
    const nextTyped = engine.applyRunEdit(model.text, run.id, 'Ycd')
    if (!nextTyped.ok) throw new Error(nextTyped.reason.description)
    model.edit(nextTyped.edit, { before: split.cursor, after: { runId: run.id, offset: 1 }, time: 2 })
    model.undo(); expect(model.text).toBe(split.newText)
    model.undo(); expect(model.serialize()).toBe('abXcd\r\n\r\nuntouched\nlast\r\n')
    model.undo(); expect(model.serialize()).toBe(raw)
  })

  it.each(['\n', '\r\n'])('preserves BOM, untouched bytes and one-step history with %j', eol => {
    const raw = ['---', 'marp: true', '---', '', '7) abcd', '2) next', '', '<!-- untouched  -->', ''].join(eol)
    const model = new DocumentModel(raw, { hasBom: true })
    const engine = createEngine(new Marp({ script: false }))
    const analysis = engine.analyze(model.text)
    const run = analysis.runs.find(run => run.text === 'abcd')!
    const result = engine.applyNewline(model.text, run.id, 2, 'paragraph')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    model.edit(result.edit, { before: { runId: run.id, offset: 2 }, after: result.cursor })
    expect(model.hasBom).toBe(true)
    expect(model.serialize()).toBe(['---', 'marp: true', '---', '', '7) ab', '8) cd', '2) next', '', '<!-- untouched  -->', ''].join(eol))
    const before = model.undo()!
    expect(model.serialize()).toBe(raw)
    expect(resolveCursor(engine.analyze(model.text), before)?.offset).toBe(2)
    const after = model.redo()!
    expect(resolveCursor(engine.analyze(model.text), after)?.offset).toBe(0)
  })
})
