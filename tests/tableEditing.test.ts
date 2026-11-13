import { describe, expect, it } from 'vitest';
import { Marp } from '@marp-team/marp-core';
import { createEngine } from '../src/editing';
import { DocumentModel } from '../src/document/model';

const source = '| 方式 | 分類 | 正解率 |\n|---|---|---:|\n| Jev版<br>5回 | 新17分類 | **964/1000<br>96.4%** |\n| 旧ローカル方式<br>1回 | 検索・NLI・<br>独自ルール | 115/200<br>57.5% |';
function setup(text = source) {
  const engine = createEngine(new Marp({ script: false }));
  return { engine, analysis: engine.analyze(text) };
}

describe('table cell editing', () => {
  it.each(['方式', '分類', '正解率', 'Jev版', '5回', '新17分類', '964/1000', '96.4%', '旧ローカル方式', '1回', '検索・NLI・', '独自ルール', '115/200', '57.5%'])('edits %s in its cell', text => {
    const { engine, analysis } = setup();
    const run = analysis.runs.find(entry => entry.text === text)!;
    expect(run?.editable).toBe(true);
    const result = engine.applyRunEdit(source, run.id, text + '修正');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.newText).toBe(source.slice(0, run.segments.at(-1)!.end) + '修正' + source.slice(run.segments.at(-1)!.end));
  });
  it('rejects pipes and handles read-only escaped and missing cells', () => {
    const text = '| a | b | c |\n|---|---|---|\n| x\\|y | z |';
    const { engine, analysis } = setup(text);
    const a = analysis.runs.find(run => run.text === 'a')!;
    expect(engine.applyRunEdit(text, a.id, 'a|b')).toMatchObject({ ok: false, reason: { code: 'table-input' } });
    expect(analysis.runs.find(run => run.text === 'x|y')).toMatchObject({ editable: false, reason: { code: 'table-cell' } });
    expect(analysis.blocks.filter(block => block.reason?.code === 'table-cell')).toHaveLength(2);
  });
  it('deletes a whole run and restores an empty cell as an editable target', () => {
    const text = '| a | b |\n|---|---|\n| テスト  | other |';
    const { engine, analysis } = setup(text);
    const run = analysis.runs.find(entry => entry.text === 'テスト')!;
    const removed = engine.applyRunEdit(text, run.id, '');
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.newText).toBe('| a | b |\n|---|---|\n|   | other |');
    const fresh = engine.analyze(removed.newText);
    const empty = fresh.runs.find(entry => entry.text === '' && entry.blockId === fresh.blocks[2].id)!;
    expect(empty?.editable).toBe(true);
    const inserted = engine.applyRunEdit(removed.newText, empty.id, '再入力');
    expect(inserted.ok).toBe(true);
  });
  it('rejects deleting the only contents of emphasis', () => {
    const text = '| a |\n|---|\n| **strong** |';
    const { engine, analysis } = setup(text);
    const run = analysis.runs.find(entry => entry.text === 'strong')!;
    expect(engine.applyRunEdit(text, run.id, '').ok).toBe(false);
  });
  it.each(['backward', 'forward'] as const)('deletes a break and undoes it: %s', direction => {
    const text = '| a |\n|---|\n| 前<br>後 |';
    const { engine, analysis } = setup(text);
    const run = analysis.runs.find(entry => entry.text === (direction === 'backward' ? '後' : '前'))!;
    const result = engine.applyTableBreakDeletion(text, run.id, direction);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newText).toBe('| a |\n|---|\n| 前後 |');
    expect(result.cursor.offset).toBe(1);
    const model = new DocumentModel(text);
    model.edit(result.edit);
    model.undo();
    expect(model.text).toBe(text);
  });
  it.each(['> | a | b |\n> |---|---|\n> | x | y |', '- | a | b |\n  |---|---|\n  | x | y |'])('keeps nested tables read-only', text => {
    const { analysis } = setup(text);
    expect(analysis.runs.filter(run => ['a', 'b', 'x', 'y'].includes(run.text)).every(run => !run.editable)).toBe(true);
  });
  it('preserves CRLF, BOM metadata and all bytes outside the recorded edit', () => {
    const raw = '| 名称 | 数量 |\r\n|---|---:|\r\n| 前<br>後 | 2 |\r\n';
    const model = new DocumentModel(raw, { hasBom: true });
    const engine = createEngine(new Marp({ script: false }));
    const analysis = engine.analyze(model.text);
    const run = analysis.runs.find(entry => entry.text === '後')!;
    const result = engine.applyRunEdit(model.text, run.id, '後半');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    model.edit(result.edit);
    expect(model.hasBom).toBe(true);
    expect(model.serialize()).toBe(raw.replace('後', '後半'));
  });
  it('moves to the previous run after deleting all text beside a break', () => {
    const text = '| a |\n|---|\n| 前<br>後 |';
    const { engine, analysis } = setup(text);
    const run = analysis.runs.find(entry => entry.text === '後')!;
    const result = engine.applyRunEdit(text, run.id, '');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.analysis.runs.find(entry => entry.id === result.cursor?.runId)?.text).toBe('前');
      expect(result.cursor?.offset).toBe(1);
    }
  });
  it('leaves every cell read-only when any table line is indented', () => {
    const { analysis } = setup(' | a | b |\n |---|---|\n| x | y |');
    expect(analysis.runs.filter(run => ['a', 'b', 'x', 'y'].includes(run.text)).every(run => !run.editable)).toBe(true);
  });

  it.each([
    ['a<br>', 'a', 'forward', 'a', 'a', 1],
    ['<br>a', 'a', 'backward', 'a', 'a', 0],
    ['a<br><br>b', 'b', 'backward', 'a<br>b', 'b', 0],
    ['a<br><br>b', 'a', 'forward', 'a<br>b', 'a', 1],
  ] as const)('deletes the adjacent break in %s (%s, %s)', (cell, label, direction, expected, caret, offset) => {
    const text = `| h |\n|---|\n| ${cell} |`;
    const model = new DocumentModel(text), { engine, analysis } = setup(text);
    const result = engine.applyTableBreakDeletion(text, analysis.runs.find(run => run.text === label)!.id, direction);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newText).toBe(`| h |\n|---|\n| ${expected} |`);
    expect(result.analysis.runs.find(run => run.id === result.cursor.runId)?.text).toBe(caret);
    expect(result.cursor.offset).toBe(offset);
    model.edit(result.edit); model.undo(); expect(model.text).toBe(text);
  });
  it('deletes a trailing break after removing the following run', () => {
    const text = '| h |\n|---|\n| 前<br>後 |', { engine, analysis } = setup(text);
    const removed = engine.applyRunEdit(text, analysis.runs.find(run => run.text === '後')!.id, '');
    expect(removed.ok).toBe(true); if (!removed.ok || !removed.cursor) return;
    const result = engine.applyTableBreakDeletion(removed.newText, removed.cursor.runId, 'forward');
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.newText).toBe('| h |\n|---|\n| 前 |');
    expect(result.cursor.offset).toBe(1);
    const model = new DocumentModel(removed.newText); model.edit(result.edit); model.undo(); expect(model.text).toBe(removed.newText);
  });
  it.each([['a<br>', 'forward'], ['<br>a', 'backward']] as const)('deletes a break beside an emptied run: %s', (cell, direction) => {
    const text = `| h |\n|---|\n| ${cell} |`, { engine, analysis } = setup(text);
    const removed = engine.applyRunEdit(text, analysis.runs.find(run => run.text === 'a')!.id, '');
    expect(removed.ok).toBe(true); if (!removed.ok || !removed.cursor) return;
    const result = engine.applyTableBreakDeletion(removed.newText, removed.cursor.runId, direction);
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.newText).toBe('| h |\n|---|\n|  |');
    expect(result.analysis.runs.find(run => run.id === result.cursor.runId)?.text).toBe('');
    expect(result.cursor.offset).toBe(0);
  });
  it.each(['<span>', '<br class="x">'])('rejects deleting other HTML: %s', html => {
    const text = `| h |\n|---|\n| a${html} |`, { engine, analysis } = setup(text);
    const run = analysis.runs.find(entry => entry.text === 'a')!;
    expect(engine.applyTableBreakDeletion(text, run.id, 'forward').ok).toBe(false);
  });

});
