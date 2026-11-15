import { Marp } from '@marp-team/marp-core';
import { describe, expect, it } from 'vitest';
import { DocumentModel } from '../src/document';
import { createEngine, applyElementTransaction } from '../src/editing';
import { applyTableTransaction, insertTableTransaction, tableInsertionLines, tableOperationReason, type TableCommand } from '../src/editing/tableOperations';

function setup(raw: string) {
  const model = new DocumentModel(raw, { hasBom: true });
  const engine = createEngine(new Marp({ script: false }));
  const analysis = engine.analyze(model.text);
  const elementId = analysis.elementSources!.elements.find(e => e.kind === 'table')?.id ?? '';
  return { model, engine, analysis, elementId };
}
function apply(raw: string, command: TableCommand, row = 0, column = 0) {
  const state = setup(raw);
  return { ...state, result: applyTableTransaction(state.model, state.engine, state.analysis, { elementId: state.elementId, row, column, command }) };
}
describe('table insertion', () => {
  it('inserts an empty parsed table with editable zero-length header cells', () => {
    const { model, engine } = setup('before');
    const result = applyElementTransaction(model, engine, { kind: 'insert', slide: 0, lines: tableInsertionLines(3, 2)!, expectedKinds: ['table'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.elementSources!.elements.map(e => e.kind)).toEqual(['paragraph', 'table']);
    expect(result.analysis.blocks.filter(b => b.tableCell)).toHaveLength(6);
    expect(result.analysis.runs.filter(r => r.editable && r.text === '')).toHaveLength(6);
    model.undo(); expect(model.serialize()).toBe('before');
  });
  it('places the caret in the first inserted cell and undoes once', () => {
    const { model, engine, analysis } = setup('before');
    const result = insertTableTransaction(model, engine, 0, 2, 2, { anchor: analysis.elementSources!.elements[0].id });
    expect(result.ok, result.ok ? '' : result.reason.code).toBe(true);
    if (result.ok) expect(result.analysis.runs.find(run => run.id === result.cursor?.runId)?.text).toBe('');
    model.undo(); expect(model.serialize()).toBe('before'); expect(model.canUndo).toBe(false);
  });
});
describe('table row and column operations', () => {
  it.each([
    ['insert-row-below', 0, 0, '| a | b |\r\n| :---: | ---: |\n|  |  |\r\n| x | y |'],
    ['insert-row-above', 1, 0, '| a | b |\r\n| :---: | ---: |\n|  |  |\n| x | y |'],
    ['insert-row-below', 1, 0, '| a | b |\r\n| :---: | ---: |\n| x | y |\n|  |  |'],
    ['delete-row', 1, 0, '| a | b |\r\n| :---: | ---: |\n'],
    ['insert-column-left', 0, 1, '| a |  | b |\r\n| :---: | --- | ---: |\n| x |  | y |'],
    ['insert-column-right', 0, 1, '| a | b |  |\r\n| :---: | ---: | --- |\n| x | y |  |'],
    ['delete-column', 0, 0, '| b |\r\n| ---: |\n| y |'],
    ['delete-column', 0, 1, '| a |\r\n| :---: |\n| x |'],
  ] as [TableCommand, number, number, string][])('%s at %i,%i preserves untouched bytes and undoes once', (command, row, column, expected) => {
    const raw = '| a | b |\r\n| :---: | ---: |\n| x | y |';
    const { model, result } = apply(raw, command, row, column);
    expect(result.ok, result.ok ? '' : result.reason.code).toBe(true);
    expect(model.serialize()).toBe(expected);
    if (result.ok && command.startsWith('insert')) expect(result.cursor).toBeDefined();
    model.undo(); expect(model.serialize()).toBe(raw); expect(model.hasBom).toBe(true); expect(model.canUndo).toBe(false);
  });
  it('supports a header-only table and one column', () => {
    const s = apply('| a |\n| --- |', 'insert-row-below');
    expect(s.result.ok, s.result.ok ? '' : s.result.reason.code).toBe(true);
    expect(s.model.serialize()).toBe('| a |\n| --- |\n|  |');
  });
  it.each(['a | b\n--- | ---\nx | y', '| a | b\n| --- | ---\n| x | y', '| a | b |\n| --- | --- |\n| x |', '| a | b |\n| --- | --- |\n| x \\| z | y |'])('rejects unsupported source %j', raw => {
    const s = apply(raw, 'insert-column-right');
    expect(s.result).toMatchObject({ ok: false, reason: { code: 'table-unsupported' } });
    expect(s.model.serialize()).toBe(raw);
  });
  it('provides header and last column reasons', () => {
    const s = setup('| a |\n| --- |');
    expect(tableOperationReason(s.analysis, { elementId: s.elementId, row: 0, column: 0, command: 'delete-row' })?.code).toBe('table-header-row');
    expect(tableOperationReason(s.analysis, { elementId: s.elementId, row: 0, column: 0, command: 'delete-column' })?.code).toBe('table-last-column');
  });
});
