import { describe, expect, it } from 'vitest';
import { applyEdit, DocumentModel, joinEols, splitEols } from '../src/document';

describe('lossless document model', () => {
  it.each(['', 'one', 'one\n', 'one\r\ntwo\r\n', 'one\r\ntwo\nthree', '\uFEFFone\r\ntwo\n'])('round trips %j', raw => {
    const document = splitEols(raw);
    expect(joinEols(document.text, document.eols)).toBe(raw);
    expect(new TextEncoder().encode(joinEols(document.text, document.eols))).toEqual(new TextEncoder().encode(raw));
  });
  it('changes only the selected range with mixed EOL and no final newline', () => {
    const raw = 'before  \r\nrepeat\nrepeat\r\nafter';
    const document = splitEols(raw);
    const start = 'before  \nrepeat\n'.length;
    const updated = applyEdit(document, { start, end: start + 6, insert: 'changed' });
    expect(joinEols(updated.text, updated.eols)).toBe('before  \r\nrepeat\nchanged\r\nafter');
  });
  it('assigns majority EOL to inserted newlines and preserves surviving newlines', () => {
    const original = splitEols('a\r\nb\nc\r\nd');
    const inserted = applyEdit(original, { start: 3, end: 3, insert: 'X\nY\n' });
    expect(joinEols(inserted.text, inserted.eols)).toBe('a\r\nbX\r\nY\r\n\nc\r\nd');
    const removed = applyEdit(original, { start: 1, end: 4, insert: '' });
    expect(joinEols(removed.text, removed.eols)).toBe('ac\r\nd');
  });
  it('rejects invalid ranges and malformed EOL arrays', () => {
    const doc = splitEols('hello');
    expect(() => applyEdit(doc, { start: -1, end: 0, insert: '' })).toThrow();
    expect(() => applyEdit(doc, { start: 0, end: 99, insert: '' })).toThrow();
    expect(() => applyEdit(doc, { start: 0, end: 0, insert: '\r\n' })).toThrow();
    expect(() => joinEols('a\nb', [''])).toThrow();
    expect(() => splitEols('a\rb')).toThrow();
  });
  it('groups same-run contiguous typing within one second with cursors', () => {
    const doc = new DocumentModel('a\r\nb', { hasBom: true, diskHash: 'old' });
    const cursor = (offset: number) => ({ runId: 'run', offset });
    doc.edit({ start: 1, end: 1, insert: 'b' }, { before: cursor(1), after: cursor(2), time: 0 });
    doc.edit({ start: 2, end: 2, insert: 'c' }, { before: cursor(2), after: cursor(3), time: 1000 });
    expect(doc.state).toBe('dirty');
    expect(doc.undo()).toEqual(cursor(1));
    expect(doc.serialize()).toBe('a\r\nb');
    expect(doc.state).toBe('clean');
    expect(doc.canUndo).toBe(false);
    expect(doc.redo()).toEqual(cursor(3));
    expect(doc.serialize()).toBe('abc\r\nb');
    expect(doc.hasBom).toBe(true);
  });
  it('separates runs, timeouts and explicit boundaries; new edits clear redo', () => {
    const doc = new DocumentModel('');
    const edit = (insert: string, time: number, runId = 'a') => doc.edit({ start: doc.text.length, end: doc.text.length, insert },
      { before: { runId, offset: doc.text.length }, after: { runId, offset: doc.text.length + insert.length }, time });
    edit('a', 0); edit('b', 1001); edit('c', 1002, 'b');
    doc.breakHistoryGroup(); edit('d', 1003, 'b');
    doc.undo(); expect(doc.text).toBe('abc');
    doc.undo(); expect(doc.text).toBe('ab');
    edit('X', 1004); expect(doc.canRedo).toBe(false);
    doc.markConflict(); expect(doc.state).toBe('conflict');
    doc.markSaved('new'); expect(doc.state).toBe('clean');
    doc.reload('other\r\n', 'external'); expect(doc.canUndo).toBe(false); expect(doc.diskHash).toBe('external');
  });
  it('undo restores EOL arrays after insertion/removal and NUL is read-only', () => {
    const doc = new DocumentModel('a\r\nb\nc');
    doc.edit({ start: 1, end: 4, insert: 'X\n' });
    doc.undo(); expect(doc.serialize()).toBe('a\r\nb\nc');
    doc.redo(); expect(doc.serialize()).toBe('aX\nc');
    const nul = new DocumentModel('a\0b');
    expect(nul.state).toBe('readonly'); expect(() => nul.edit({ start: 0, end: 1, insert: '' })).toThrow();
  });
});
