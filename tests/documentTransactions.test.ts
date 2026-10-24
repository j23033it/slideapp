import { describe, expect, it } from 'vitest'
import { applyEdit, DocumentModel, replaceRange, splitEols, type SourceEdit } from '../src/document'

describe('atomic source range transactions', () => {
  it('uses original coordinates, retains mixed EOLs, and restores the whole transaction in one undo', () => {
    const raw = 'one\r\ntwo\nthree\r\n'
    const edit: SourceEdit = { start: 0, end: 0, insert: '  ', additional: [
      { start: 4, end: 4, insert: '  ' }, { start: 8, end: 8, insert: '  ' },
    ] }
    const model = new DocumentModel(raw)
    expect(replaceRange(model.text, edit)).toBe('  one\n  two\n  three\n')
    expect(applyEdit(splitEols(raw), edit).eols).toEqual(model.eols)
    model.edit(edit)
    expect(model.serialize()).toBe('  one\r\n  two\n  three\r\n')
    model.undo(); expect(model.serialize()).toBe(raw); expect(model.canUndo).toBe(false)
    model.redo(); expect(model.serialize()).toBe('  one\r\n  two\n  three\r\n')
  })

  it.each<SourceEdit>([
    { start: -1, end: 0, insert: '', additional: [{ start: 4, end: 4, insert: 'valid' }] },
    { start: 0, end: 0, insert: '', additional: [{ start: 99, end: 99, insert: 'outside' }] },
    { start: 0, end: 3, insert: '', additional: [{ start: 2, end: 4, insert: '' }] },
    { start: 0, end: 0, insert: 'a', additional: [{ start: 0, end: 0, insert: 'b' }] },
    { start: 0, end: 0, insert: '\r', additional: [] },
  ])('rejects malformed transactions without changing text, EOLs or redo history: %j', edit => {
    const model = new DocumentModel('one\r\ntwo\n')
    model.edit({ start: 0, end: 0, insert: 'X' }); model.undo()
    expect(() => model.edit(edit)).toThrow()
    expect(model.serialize()).toBe('one\r\ntwo\n')
    expect(model.canUndo).toBe(false); expect(model.canRedo).toBe(true)
    model.redo(); expect(model.serialize()).toBe('Xone\r\ntwo\n')
  })
})
