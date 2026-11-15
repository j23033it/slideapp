import { preferredEol, type Cursor, type DocumentModel, type Eol, type SourceEdit } from '../document';
import { tableCells, tablePipes } from './blocks';
import type { EditingEngine } from './engine';
import type { Analysis } from './types';
import { renderedSlideSignatures } from './slideValidation';

export type TableCommand = 'insert-row-above' | 'insert-row-below' | 'insert-column-left' | 'insert-column-right' | 'delete-row' | 'delete-column';
export type TableReasonCode = 'table-unsupported' | 'table-header-row' | 'table-last-column' | 'element-ambiguous' | 'element-structure-changed' | 'element-heading-divider' | 'element-readonly';
export interface TableReason { code: TableReasonCode; description: string }
export interface TableOperation { elementId: string; row: number; column: number; command: TableCommand }
export type TableResult = { ok: false; reason: TableReason } | { ok: true; edits: SourceEdit[]; newText: string; analysis: Analysis; cursor?: Cursor; elementId: string };
const reject = (code: TableReasonCode): { ok: false; reason: TableReason } => ({ ok: false, reason: { code, description: code } });

interface TableRow { start: number; end: number; line: number; pipes: number[] }
interface TableSnapshot { rows: TableRow[]; columns: number; cells: string[][]; alignment: string[] }

/** Build coordinates from the same delimiter rules used for editable cells. */
function readSnapshot(analysis: Analysis, elementId: string): TableSnapshot | undefined {
  const element = analysis.elementSources?.elements.find(e => e.id === elementId && e.kind === 'table');
  if (!element || !analysis.elementSources?.valid) return;
  const text = analysis.text, lines = text.split('\n');
  const first = text.slice(0, element.start).split('\n').length - 1;
  const raw = text.slice(element.start, element.end);
  const count = raw.split('\n').length - (raw.endsWith('\n') ? 1 : 0);
  if (count < 2) return;
  const rows: TableRow[] = [], cells: string[][] = [];
  let start = element.start, columns = 0;
  for (let i = 0; i < count; i++) {
    const line = first + i, value = lines[line];
    const pipes = tablePipes(text, line), mapped = tableCells(text, line);
    if (!pipes || pipes.escaped || !mapped || !value.startsWith('|') || !value.endsWith('|') || pipes.positions[0] !== start || pipes.positions.at(-1) !== start + value.length - 1) return;
    if (!i) columns = pipes.positions.length - 1;
    if (!columns || pipes.positions.length !== columns + 1 || mapped.length !== columns) return;
    const end = start + value.length + (start + value.length < text.length ? 1 : 0);
    rows.push({ start, end, line, pipes: pipes.positions });
    if (i !== 1) {
      const blocks = analysis.blocks.filter(block => block.tableCell && block.lines?.[0] === line);
      // A table-cell reason means the source slice did not match markdown-it's cell.
      // Other read-only reasons concern text editing, not these delimiter coordinates.
      if (blocks.length !== columns || blocks.some(block => block.reason?.code === 'table-cell')) return;
      cells.push(blocks.map((block, column) => {
        const index = analysis.blocks.indexOf(block);
        const source = text.slice(pipes.positions[column] + 1, pipes.positions[column + 1]);
        return JSON.stringify([source, analysis.inlineStructure[index], block.runs.map(id => analysis.runs.find(run => run.id === id)?.text)]);
      }));
    }
    start = end;
  }
  let alignment: string[];
  try {
    const tokens = JSON.parse(element.signature) as unknown[][];
    alignment = tokens.filter(token => token[0] === 'th_open').map(token => JSON.stringify(token[7]));
  } catch { return; }
  if (alignment.length !== columns) return;
  return { rows, columns, cells, alignment };
}

const snapshots = new WeakMap<Analysis, Map<string, TableSnapshot>>();

/** Record source coordinates when the analysis is finalized, never when applying an edit. */
export function captureTableSnapshots(analysis: Analysis): void {
  const tables = new Map<string, TableSnapshot>();
  for (const element of analysis.elementSources?.elements ?? []) {
    if (element.kind !== 'table') continue;
    const table = readSnapshot(analysis, element.id);
    if (table) tables.set(element.id, table);
  }
  snapshots.set(analysis, tables);
}

function snapshot(analysis: Analysis, elementId: string): TableSnapshot | undefined {
  return snapshots.get(analysis)?.get(elementId);
}

export function tableOperationReason(analysis: Analysis, operation: TableOperation): TableReason | undefined {
  if (analysis.slideSources?.reason?.code === 'slide-heading-divider') return reject('element-heading-divider').reason;
  if (!analysis.slideSources || analysis.slideSources.reason || analysis.draft) return reject('element-ambiguous').reason;
  const table = snapshot(analysis, operation.elementId);
  if (!table || !Number.isInteger(operation.row) || !Number.isInteger(operation.column) || operation.row < 0 || operation.row >= table.cells.length || operation.column < 0 || operation.column >= table.columns) return reject('table-unsupported').reason;
  if (operation.row === 0 && (operation.command === 'insert-row-above' || operation.command === 'delete-row')) return reject('table-header-row').reason;
  if (table.columns === 1 && operation.command === 'delete-column') return reject('table-last-column').reason;
}

export function planTableOperation(before: Analysis, operation: TableOperation, eols: readonly Eol[]): SourceEdit[] | TableReason {
  const why = tableOperationReason(before, operation); if (why) return why;
  const table = snapshot(before, operation.elementId)!;
  const { command, row, column } = operation;
  const sourceRow = table.rows[row === 0 ? 0 : row + 1];
  if (command === 'delete-row') return [{ start: sourceRow.start, end: sourceRow.end, insert: '' }];
  if (command === 'insert-row-above' || command === 'insert-row-below') {
    const below = command === 'insert-row-below';
    const reference = row === 0 && below ? table.rows[1] : sourceRow;
    const position = below ? reference.end : reference.start;
    const empty = '|' + '  |'.repeat(table.columns);
    const eol = eols[sourceRow.line] || eols[reference.line] || eols[sourceRow.line - 1] || preferredEol(eols);
    const noFinalEol = below && position === before.text.length && before.text[position - 1] !== '\n';
    return [{ start: position, end: position, insert: noFinalEol ? '\n' + empty : empty + '\n', eols: [eol] }];
  }
  const edits: SourceEdit[] = [];
  for (let i = 0; i < table.rows.length; i++) {
    const pipes = table.rows[i].pipes;
    if (command === 'delete-column') {
      const last = column === table.columns - 1;
      // Preserve the outer delimiter for last-column deletion.
      edits.push({ start: last ? pipes[column] : pipes[column] + 1, end: last ? pipes[column + 1] : pipes[column + 1] + 1, insert: '' });
    } else {
      const boundary = column + (command === 'insert-column-right' ? 1 : 0);
      edits.push({ start: pipes[boundary] + 1, end: pipes[boundary] + 1, insert: i === 1 ? ' --- |' : '  |' });
    }
  }
  return edits.reverse();
}

/** Validate the candidate before the caller records all original-coordinate edits. */
export function validateTableOperation(before: Analysis, after: Analysis, operation: TableOperation): { cursor?: Cursor; elementId: string } | undefined {
  const oldElement = before.elementSources?.elements.find(e => e.id === operation.elementId);
  if (!oldElement || !before.elementSources || !after.elementSources?.valid || !after.slideSources || after.slideSources.reason) return;
  const oldGroups = before.elementSources.groups, newGroups = after.elementSources.groups;
  const index = oldGroups.findIndex(g => g.start === oldElement.start && g.end === oldElement.end && g.slide === oldElement.slide);
  if (index < 0 || oldGroups.length !== newGroups.length || newGroups[index]?.kind !== 'table' || oldGroups.some((group, i) => i !== index && (group.signature !== newGroups[i].signature || group.slide !== newGroups[i].slide))) return;
  const oldSlides = renderedSlideSignatures(before.html), newSlides = renderedSlideSignatures(after.html);
  if (!oldSlides || !newSlides || oldSlides.length !== newSlides.length || oldSlides.some((s, i) => i !== oldElement.slide && s !== newSlides[i])) return;
  const newElement = after.elementSources.elements.find(e => e.start === newGroups[index].start && e.kind === 'table');
  const oldTable = snapshot(before, operation.elementId), newTable = newElement && snapshot(after, newElement.id);
  if (!oldTable || !newTable || !newElement) return;
  const { command, row, column } = operation;
  const expected = oldTable.cells.map(cells => [...cells]);
  let targetRow = row, targetColumn = column;
  const empty = JSON.stringify(['  ', JSON.stringify([['text']]), ['']]);
  if (command === 'insert-row-above' || command === 'insert-row-below') {
    targetRow = row + (command === 'insert-row-below' ? 1 : 0);
    expected.splice(targetRow, 0, Array(oldTable.columns).fill(empty));
  } else if (command === 'delete-row') expected.splice(row, 1);
  else if (command === 'delete-column') expected.forEach(cells => cells.splice(column, 1));
  else {
    targetColumn = column + (command === 'insert-column-right' ? 1 : 0);
    expected.forEach(cells => cells.splice(targetColumn, 0, empty));
  }
  const alignment = [...oldTable.alignment];
  if (command === 'delete-column') alignment.splice(column, 1);
  else if (command === 'insert-column-left' || command === 'insert-column-right') alignment.splice(targetColumn, 0, 'null');
  if (JSON.stringify(alignment) !== JSON.stringify(newTable.alignment) || JSON.stringify(expected) !== JSON.stringify(newTable.cells) || newTable.columns !== expected[0].length) return;
  if (command.startsWith('insert-')) {
    const line = newTable.rows[targetRow === 0 ? 0 : targetRow + 1].line;
    const blocks = after.blocks.filter(block => block.tableCell && block.lines?.[0] === line);
    const run = after.runs.find(entry => entry.blockId === blocks[targetColumn]?.id && entry.editable && entry.text === '');
    if (!run) return;
    return { cursor: { runId: run.id, offset: 0 }, elementId: newElement.id };
  }
  return { elementId: newElement.id };
}

export function applyTableTransaction(model: DocumentModel, engine: EditingEngine, before: Analysis, operation: TableOperation, options: { readonly?: boolean; before?: Cursor } = {}): TableResult {
  if (options.readonly || model.state === 'readonly' || model.state === 'conflict') return reject('element-readonly');
  if (before.text !== model.text) return reject('element-ambiguous');
  const result = engine.applyTableOperation(model.text, operation, model.eols);
  if (!result.ok) return result;
  try { model.editTransaction(result.edits, { before: options.before, after: result.cursor }); }
  catch { engine.analyze(model.text); return reject('element-ambiguous'); }
  return result;
}

export function tableInsertionLines(columns: number, rows: number): string[] | undefined {
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || columns > 10 || rows < 2 || rows > 8) return;
  const empty = '|' + '  |'.repeat(columns);
  return [empty, '|' + ' --- |'.repeat(columns), ...Array(rows - 1).fill(empty)];
}

/** Insert through 7.10 and verify the new table has an editable first cell. */
export function insertTableTransaction(model: DocumentModel, engine: EditingEngine, slide: number, columns: number, rows: number, options: { readonly?: boolean; anchor?: string; before?: Cursor } = {}): TableResult {
  if (options.readonly || model.state === 'readonly' || model.state === 'conflict') return reject('element-readonly');
  const lines = tableInsertionLines(columns, rows);
  if (!lines) return reject('table-unsupported');
  const result = engine.applyElementOperation(model.text, { kind: 'insert', slide, anchor: options.anchor ? { elementId: options.anchor, side: 'after' } : undefined, lines, expectedKinds: ['table'] }, model.eols);
  if (!result.ok) return result;
  const source = result.analysis.elementSources?.elements.find(element => element.kind === 'table' && element.slide === slide && element.start >= result.edit.start && element.end <= result.edit.start + result.edit.insert.length);
  const table = source && snapshot(result.analysis, source.id);
  const firstLine = table?.rows[0].line;
  const block = result.analysis.blocks.find(entry => entry.tableCell && entry.lines?.[0] === firstLine);
  const run = result.analysis.runs.find(entry => entry.blockId === block?.id && entry.editable && entry.text === '');
  if (!source || !table || table.columns !== columns || table.cells.length !== rows || !run) {
    engine.analyze(model.text); return reject('element-structure-changed');
  }
  const cursor = { runId: run.id, offset: 0 };
  try { model.editTransaction([result.edit], { before: options.before, after: cursor }); }
  catch { engine.analyze(model.text); return reject('element-ambiguous'); }
  return { ok: true, edits: [result.edit], newText: result.newText, analysis: result.analysis, elementId: source.id, cursor };
}
