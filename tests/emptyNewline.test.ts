import { Marp } from '@marp-team/marp-core'
import { describe, expect, it } from 'vitest'
import { DocumentModel } from '../src/document'
import { createEngine, resolveCursor } from '../src/editing'

const cases = [
  ['- A', 'paragraph', '- A\n- ', '- A\n- 次', true],
  ['- parent\n  - A', 'paragraph', '- parent\n  - A\n  - ', '- parent\n  - A\n  - 次', true],
  ['7. A', 'paragraph', '7. A\n8. ', '7. A\n8. 次', true],
  ['7) A', 'paragraph', '7) A\n8) ', '7) A\n8) 次', true],
  ['* A', 'paragraph', '* A\n* ', '* A\n* 次', true],
  ['> - A', 'paragraph', '> - A\n> - ', '> - A\n> - 次', true],
  ['A', 'paragraph', 'A\n\n', 'A\n\n次', false],
  ['> A', 'paragraph', '> A\n>\n> ', '> A\n>\n> 次', false],
  ['A', 'line', 'A\n', 'A\n次', false],
  ['- A', 'line', '- A\n  ', '- A\n  次', false],
  ['- parent\n  - A', 'line', '- parent\n  - A\n    ', '- parent\n  - A\n    次', false],
  ['> A', 'line', '> A\n> ', '> A\n> 次', false],
] as const

describe.each(['\n', '\r\n'])('empty newline targets with %j', eol => {
  it.each(cases)('%s / %s supports the first range insertion', (source, kind, emptySource, filledSource, persistent) => {
    const prefix = '# untouched' + eol + eol
    const raw = prefix + source.split('\n').join(eol)
    const model = new DocumentModel(raw, { hasBom: true })
    const engine = createEngine(new Marp({ script: false }))
    const analysis = engine.analyze(model.text)
    const run = analysis.runs.at(-1)!
    const before = { runId: run.id, offset: run.text.length }
    const newline = engine.applyNewline(model.text, run.id, before.offset, kind)
    expect(newline.ok, JSON.stringify(newline)).toBe(true)
    if (!newline.ok) return
    model.edit(newline.edit, { before, after: newline.cursor })
    expect(model.serialize()).toBe(prefix + emptySource.split('\n').join(eol))
    const empty = newline.analysis.runs.find(run => run.id === newline.cursor.runId)!
    expect(empty.text).toBe(''); expect(empty.segments[0]).toMatchObject({ start: model.text.length, end: model.text.length })
    expect(newline.analysis.html).toContain('data-sm-empty')
    const input = engine.applyRunEdit(model.text, empty.id, '次')
    expect(input.ok, JSON.stringify(input)).toBe(true)
    if (!input.ok) return
    expect(input.edit.start).toBe(input.edit.end)
    model.edit(input.edit, { before: newline.cursor, after: { runId: empty.id, offset: 1 } })
    expect(model.serialize()).toBe(prefix + filledSource.split('\n').join(eol)); expect(model.hasBom).toBe(true)
    expect(input.analysis.html).not.toContain('data-sm-empty')
    model.undo()
    expect(model.serialize()).toBe(prefix + (persistent ? emptySource : source).split('\n').join(eol))
    if (persistent) model.undo()
    expect(model.serialize()).toBe(raw)
  })

  it.each(cases)('%s / %s leaves only persistent empty items on finish', (source, kind, emptySource, _filled, persistent) => {
    const prefix = '# untouched' + eol + eol
    const raw = prefix + source.split('\n').join(eol)
    const model = new DocumentModel(raw)
    const engine = createEngine(new Marp({ script: false }))
    const analysis = engine.analyze(model.text), run = analysis.runs.at(-1)!
    const newline = engine.applyNewline(model.text, run.id, run.text.length, kind)
    if (!newline.ok) throw new Error(newline.reason.description)
    model.edit(newline.edit, { before: { runId: run.id, offset: run.text.length }, after: newline.cursor })
    if (persistent) {
      const restored = engine.analyze(model.text)
      const empty = restored.runs.find(run => run.text === '')!
      expect(empty).toBeDefined(); expect(engine.applyRunEdit(model.text, empty.id, '後から').ok).toBe(true)
      expect(model.serialize()).toBe(prefix + emptySource.split('\n').join(eol)); expect(model.canUndo).toBe(true)
    } else {
      const cancel = engine.cancelDraft(model.text)
      if (!cancel.ok) throw new Error(cancel.reason.description)
      model.edit(cancel.edit)
      expect(model.serialize()).toBe(raw); expect(model.state).toBe('clean'); expect(model.canUndo).toBe(false)
    }
  })
})

it('Ctrl+Z cancels an untouched draft without consuming an older undo/redo entry or its EOLs', () => {
  const model = new DocumentModel('A\r\n\r\nother\n', { hasBom: true })
  model.edit({ start: 0, end: 1, insert: 'AB' }, { group: false })
  model.edit({ start: 1, end: 2, insert: 'C' }, { group: false })
  model.undo() // Preserve this redo while starting and cancelling an empty paragraph.
  const engine = createEngine(new Marp({ script: false }))
  const before = engine.analyze(model.text), run = before.runs[0]
  const newline = engine.applyNewline(model.text, run.id, 2, 'paragraph')
  if (!newline.ok) throw new Error(newline.reason.description)
  model.edit(newline.edit, { before: { runId: run.id, offset: 2 }, after: newline.cursor })
  expect(model.canUndo).toBe(true)
  const cursor = model.undo()!
  expect(model.serialize()).toBe('AB\r\n\r\nother\n'); expect(model.canRedo).toBe(true)
  expect(resolveCursor(engine.analyze(model.text), cursor)?.offset).toBe(2)
  model.redo(); expect(model.serialize()).toBe('AC\r\n\r\nother\n')
})

it('restores the combined newline and first text in one redo with the new-line cursor', () => {
  const model = new DocumentModel('A\r\n\r\nother\n', { hasBom: true })
  const engine = createEngine(new Marp({ script: false }))
  const before = engine.analyze(model.text), run = before.runs[0]
  const newline = engine.applyNewline(model.text, run.id, 1, 'paragraph')
  if (!newline.ok) throw new Error(newline.reason.description)
  model.edit(newline.edit, { before: { runId: run.id, offset: 1 }, after: newline.cursor })
  const input = engine.applyRunEdit(model.text, newline.cursor.runId, '次')
  if (!input.ok) throw new Error(input.reason.description)
  model.edit(input.edit, { before: newline.cursor, after: { runId: newline.cursor.runId, offset: 1 } })
  model.undo(); expect(model.serialize()).toBe('A\r\n\r\nother\n')
  const cursor = model.redo()!
  expect(model.serialize()).toBe('A\r\n\r\n次\r\n\r\nother\n')
  const restored = engine.analyze(model.text), resolved = resolveCursor(restored, cursor)!
  expect(restored.runs.find(run => run.id === resolved.runId)?.text).toBe('次'); expect(resolved.offset).toBe(1)
})

it('remaps later text and entities around multiple permanent empty items without moving unrelated bytes', () => {
  const model = new DocumentModel('- \r\n- A\r\n- \r\n\r\nlast &amp; text\n', { hasBom: true })
  const engine = createEngine(new Marp({ script: false }))
  const analysis = engine.analyze(model.text)
  expect(analysis.runs.filter(run => run.text === '')).toHaveLength(2)
  const run = analysis.runs.find(run => run.text === 'last & text')!
  const changed = engine.applyRunEdit(model.text, run.id, 'last & text!')
  if (!changed.ok) throw new Error(changed.reason.description)
  model.edit(changed.edit)
  expect(model.serialize()).toBe('- \r\n- A\r\n- \r\n\r\nlast &amp; text!\n')
})

it('an empty line draft never replaces a following paragraph or slide', () => {
  const source = '- A\n\n---\n\n# Other'
  const engine = createEngine(new Marp({ script: false }))
  const before = engine.analyze(source)
  const newline = engine.applyNewline(source, before.runs[0].id, 1, 'line')
  expect(newline.ok, JSON.stringify(newline)).toBe(true)
  if (!newline.ok) return
  const result = engine.applyRunEdit(newline.newText, newline.cursor.runId, '次')
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) return
  expect(result.newText).toBe('- A\n  次\n\n---\n\n# Other')
})
