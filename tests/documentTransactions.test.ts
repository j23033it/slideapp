import { describe, expect, it } from 'vitest'
import { DocumentModel, type SourceEdit } from '../src/document'

describe('atomic source range transactions', () => {
  it('uses original coordinates, retains mixed EOLs, and restores the whole transaction in one undo', () => {
    const raw = 'one\r\ntwo\nthree\r\n'
    const edits: SourceEdit[] = [
      { start: 8, end: 8, insert: '  ' }, { start: 4, end: 4, insert: '  ' }, { start: 0, end: 0, insert: '  ' },
    ]
    const model = new DocumentModel(raw)
    const eols = [...model.eols]
    model.editTransaction(edits)
    expect(model.eols).toEqual(eols)
    expect(model.serialize()).toBe('  one\r\n  two\n  three\r\n')
    model.undo(); expect(model.serialize()).toBe(raw); expect(model.canUndo).toBe(false)
    model.redo(); expect(model.serialize()).toBe('  one\r\n  two\n  three\r\n')
  })

  it.each<{ edits: SourceEdit[] }>([
    { edits: [{ start: 4, end: 4, insert: 'valid' }, { start: -1, end: 0, insert: '' }] },
    { edits: [{ start: 99, end: 99, insert: 'outside' }, { start: 0, end: 0, insert: '' }] },
    { edits: [{ start: 2, end: 4, insert: '' }, { start: 0, end: 3, insert: '' }] },
    { edits: [{ start: 0, end: 0, insert: 'a' }, { start: 0, end: 0, insert: 'b' }] },
    { edits: [{ start: 0, end: 0, insert: '\r' }] },
    { edits: [{ start: 0, end: 0, insert: '\n', eols: [] }] },
    { edits: [{ start: 0, end: 0, insert: 'draft\n', draft: 'begin' }] },
    { edits: [{ start: 0, end: 0, insert: 'low' }, { start: 4, end: 4, insert: 'high' }] },
  ])('rejects malformed transactions without changing text, EOLs or redo history: %j', ({ edits }) => {
    const model = new DocumentModel('one\r\ntwo\n')
    model.edit({ start: 0, end: 0, insert: 'X' }); model.undo()
    expect(() => model.editTransaction(edits)).toThrow()
    expect(model.serialize()).toBe('one\r\ntwo\n')
    expect(model.canUndo).toBe(false); expect(model.canRedo).toBe(true)
    model.redo(); expect(model.serialize()).toBe('Xone\r\ntwo\n')
  })

  it('records EOL-only changes, restores cursors, and forwards legacy stage array input to the transaction', () => {
    const model = new DocumentModel('same\r\n')
    const before = { runId: '', offset: 0, slideIndex: 0 }, after = { ...before, slideIndex: 1 }
    model.edit([{ start: 0, end: 5, insert: 'same\n', eols: ['\n'] }], { before, after })
    expect(model.text).toBe('same\n'); expect(model.serialize()).toBe('same\n')
    expect(model.state).toBe('dirty'); expect(model.undo()).toEqual(before)
    expect(model.serialize()).toBe('same\r\n'); expect(model.redo()).toEqual(after)
    expect(model.serialize()).toBe('same\n')
  })
})
