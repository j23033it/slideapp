import { Marp } from '@marp-team/marp-core'
import { describe, expect, it } from 'vitest'
import { createEngine, resolveCursor, type ListIndentDirection } from '../src/editing'
import { DocumentModel, replaceRange } from '../src/document'

describe('validated list hierarchy edits', () => {
  const cases: [string, string, ListIndentDirection, string][] = [
    ['- first\n- target\n- last', 'target', 'indent', '- first\n  - target\n- last'],
    ['- first\n  - existing\n- target', 'target', 'indent', '- first\n  - existing\n  - target'],
    ['- parent\n  - target\n  - later', 'target', 'outdent', '- parent\n- target\n  - later'],
    ['- first\n- target\n  - child\n    - grandchild\n- last', 'target', 'indent', '- first\n  - target\n    - child\n      - grandchild\n- last'],
    ['- parent\n  - target\n    - child\n      - grandchild\n  - later\n- last', 'target', 'outdent', '- parent\n- target\n  - child\n    - grandchild\n  - later\n- last'],
    ['- first\n- target\n  continuation', 'continuation', 'indent', '- first\n  - target\n    continuation'],
    ['- first\n\n- target\n\n  second paragraph\n\n- last', 'target', 'indent', '- first\n\n  - target\n\n    second paragraph\n\n- last'],
    ['7. first\n9. target\n2. later', 'target', 'indent', '7. first\n   1. target\n2. later'],
    ['7) first\n9) target\n2) later', 'target', 'indent', '7) first\n   1) target\n2) later'],
    ['10. first\n12. target\n    - child', 'target', 'indent', '10. first\n    1. target\n        - child'],
    ['7. parent\n   1. child\n9. target', 'target', 'indent', '7. parent\n   1. child\n   9. target'],
    ['7. parent\n   1. target', 'target', 'outdent', '7. parent\n1. target'],
    ['7. parent\n   1. target\n   1. later', 'target', 'outdent', '7. parent\n1. target\n   1. later'],
    ['- 日本語\n- 対象の項目', '対象の項目', 'indent', '- 日本語\n  - 対象の項目'],
    ['- first\n- **target** and *suffix*', 'target', 'indent', '- first\n  - **target** and *suffix*'],
    ['* first\n* target', 'target', 'indent', '* first\n  * target'],
    ['- first\n\n- target\n  \n  second', 'target', 'indent', '- first\n\n  - target\n  \n    second'],
  ]
  it.each(cases)('%s: %s %s', (source, label, direction, expected) => {
    const engine = createEngine(new Marp({ script: false }))
    const analysis = engine.analyze(source)
    const run = analysis.runs.find(run => run.text === label || !!label && run.text.endsWith(label))!
    expect(run, source).toBeDefined()
    const offset = Math.min(2, run.text.length)
    const result = engine.applyListIndent(source, run.id, offset, direction)
    expect(result.ok, JSON.stringify(result)).toBe(true)
    if (!result.ok) return
    expect(result.newText).toBe(expected)
    expect(replaceRange(source, result.edit)).toBe(expected)
    expect(result.analysis.runs.find(run => run.id === result.cursor.runId)?.text).toBe(run.text)
    expect(result.cursor.offset).toBe(offset)
  })

  it.each([
    ['- first\n- second', 'first', 'indent', 'list-indent-first'],
    ['- parent\n  - target\n  - second', 'target', 'indent', 'list-indent-first'],
    ['- first\n- second', 'second', 'outdent', 'list-indent-top'],
    ['# target', 'target', 'indent', 'list-indent-target'],
    ['target', 'target', 'indent', 'list-indent-target'],
    ['- first\n\t- target', 'target', 'outdent', 'list-indent-unsafe'],
    ['> - first\n> - target', 'target', 'indent', 'list-indent-unsafe'],
    ['- first\n- target\nlazy', 'target\nlazy', 'indent', 'list-indent-unsafe'],
    ['- first\n- target\n  - child\nlazy', 'target', 'indent', 'list-indent-unsafe'],
    ['7. parent\n   1. target\n   2. later', 'target', 'outdent', 'list-indent-unsafe'],
    ['- first\n- ', '', 'indent', 'list-indent-unsafe'],
    ['+ first\n+ ', '', 'indent', 'list-indent-unsafe'],
    ['- first\n- - target', 'target', 'outdent', 'list-indent-unsafe'],
  ] as const)('rejects unsafe hierarchy edit: %s', (source, label, direction, code) => {
    const engine = createEngine(new Marp({ script: false }))
    const analysis = engine.analyze(source)
    const run = analysis.runs.find(run => run.text === label || label.startsWith(run.text))!
    const result = engine.applyListIndent(source, run.id, 0, direction)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.code).toBe(code)
    if (run.editable) expect(engine.applyRunEdit(source, run.id, run.text + '!').ok).toBe(true)
  })

  it.each(['\n', '\r\n', 'mixed'])('retains %s EOLs, BOM and untouched bytes through undo/redo', eol => {
    const lines = ['---', 'marp: true', '---', '', '# Heading', '', '- first', '- target', '  - child', '', '<!-- untouched  -->', '---', '# Next', '']
    const raw = lines.map((line, i) => line + (i === lines.length - 1 ? '' : eol === 'mixed' ? i % 2 ? '\n' : '\r\n' : eol)).join('')
    const model = new DocumentModel(raw, { hasBom: true })
    const engine = createEngine(new Marp({ script: false }))
    const analysis = engine.analyze(model.text), run = analysis.runs.find(run => run.text === 'target')!
    const result = engine.applyListIndent(model.text, run.id, 3, 'indent')
    if (!result.ok) throw new Error(result.reason.description)
    const eols = [...model.eols]
    model.edit(result.edit, { before: { runId: run.id, offset: 3 }, after: result.cursor })
    expect(model.eols).toEqual(eols)
    const expected = lines.map((line, i) => (i === 7 || i === 8 ? '  ' : '') + line + (i === lines.length - 1 ? '' : eols[i])).join('')
    expect(Buffer.from('\uFEFF' + model.serialize())).toEqual(Buffer.from('\uFEFF' + expected))
    expect(model.hasBom).toBe(true)
    const before = model.undo()!
    expect(model.serialize()).toBe(raw)
    expect(resolveCursor(engine.analyze(model.text), before)?.offset).toBe(3)
    const after = model.redo()!
    expect(model.serialize()).toBe(expected)
    expect(resolveCursor(engine.analyze(model.text), after)?.offset).toBe(3)
  })

  it('isolates a single-line indent from typing before and after it', () => {
    const model = new DocumentModel('- first\n- target')
    const engine = createEngine(new Marp({ script: false }))
    let analysis = engine.analyze(model.text), run = analysis.runs[1]
    const typed = engine.applyRunEdit(model.text, run.id, 'target!')
    if (!typed.ok) throw new Error(typed.reason.description)
    model.edit(typed.edit, { before: { runId: run.id, offset: 6 }, after: { runId: run.id, offset: 7 }, time: 0 })
    const result = engine.applyListIndent(model.text, run.id, 7, 'indent')
    if (!result.ok) throw new Error(result.reason.description)
    model.edit(result.edit, { before: { runId: run.id, offset: 7 }, after: result.cursor, time: 1 })
    analysis = result.analysis; run = analysis.runs[1]
    const next = engine.applyRunEdit(model.text, run.id, 'target!!')
    if (!next.ok) throw new Error(next.reason.description)
    model.edit(next.edit, { before: result.cursor, after: { runId: run.id, offset: 8 }, time: 2 })
    model.undo(); expect(model.text).toBe('- first\n  - target!')
    model.undo(); expect(model.text).toBe('- first\n- target!')
    model.undo(); expect(model.text).toBe('- first\n- target')
  })
})
