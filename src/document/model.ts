import { joinEols, preferredEol, splitEols, type Eol, type NormalizedText } from './eol';

export interface SourceEdit {
  start: number; end: number; insert: string;
  /** EOLs for inserted newline characters, in order (no final empty sentinel). */
  eols?: Exclude<Eol, ''>[];
  /** Empty paragraph/line insertion, its first text input, or its exact rollback. */
  draft?: 'begin' | 'accept' | 'cancel';
}
export interface Cursor {
  runId: string; offset: number;
  /** Slide operation history restores selection without entering text editing. */
  slideIndex?: number;
}
export type SaveState = 'clean' | 'dirty' | 'conflict' | 'readonly';

export function replaceRange(text: string, edit: SourceEdit): string {
  if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > text.length) {
    throw new RangeError('Invalid source range');
  }
  if (edit.insert.includes('\r')) throw new Error('Insert must be LF normalized');
  return text.slice(0, edit.start) + edit.insert + text.slice(edit.end);
}

/** Existing newline characters retain their own EOL, even when lines move. */
export function applyEdit(document: NormalizedText, edit: SourceEdit): NormalizedText {
  const text = replaceRange(document.text, edit);
  joinEols(document.text, document.eols); // Check the caller's invariant before changing anything.
  const startLine = document.text.slice(0, edit.start).split('\n').length - 1;
  const removed = document.text.slice(edit.start, edit.end).split('\n').length - 1;
  const added = edit.insert.split('\n').length - 1;
  if (edit.eols && (edit.eols.length !== added || edit.eols.some(eol => eol !== '\n' && eol !== '\r\n'))) {
    throw new Error('Inserted line endings do not match the range edit');
  }
  const eols = [...document.eols];
  eols.splice(startLine, removed, ...(edit.eols ?? Array<Eol>(added).fill(preferredEol(document.eols))));
  return { text, eols };
}

interface HistoryChange { forward: SourceEdit; reverse: SourceEdit; beforeEols: Eol[]; afterEols: Eol[] }
interface HistoryEntry { changes: HistoryChange[]; before?: Cursor; after?: Cursor; runId?: string; time: number }

export class DocumentModel {
  text: string;
  eols: Eol[];
  hasBom: boolean;
  diskHash: string;
  private savedRaw: string;
  private conflict = false;
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private groupBoundary = false;
  private draft?: { change: HistoryChange; before?: Cursor };

  constructor(raw: string, options: { hasBom?: boolean; diskHash?: string } = {}) {
    const normalized = splitEols(raw);
    this.text = normalized.text;
    this.eols = normalized.eols;
    this.hasBom = options.hasBom ?? false;
    this.diskHash = options.diskHash ?? '';
    this.savedRaw = raw;
  }

  get state(): SaveState {
    if (this.text.includes('\0')) return 'readonly';
    if (this.conflict) return 'conflict';
    return this.serialize() === this.savedRaw ? 'clean' : 'dirty';
  }
  get canUndo(): boolean { return !!this.draft || this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  serialize(): string { return joinEols(this.text, this.eols); }
  breakHistoryGroup(): void { this.groupBoundary = true; }

  /**
   * Atomic range edits in descending, nonoverlapping original-source order.
   * The caller must commit text input (including IME) and finish drafts first.
   */
  editTransaction(edits: readonly SourceEdit[], options: { before?: Cursor; after?: Cursor } = {}): void {
    if (this.state === 'readonly') throw new Error('NUL source is read-only');
    if (this.draft) throw new Error('Finish the pending empty-line edit first');
    let next: NormalizedText = { text: this.text, eols: this.eols };
    let boundary = this.text.length + 1;
    const changes: HistoryChange[] = [];
    for (const edit of edits) {
      if (edit.draft || edit.end > boundary || edit.start >= boundary) throw new Error('Transaction ranges must be descending and nonoverlapping');
      const updated = applyEdit(next, edit);
      if (updated.text !== next.text || updated.eols.some((eol, index) => eol !== next.eols[index])) {
        changes.push({
          forward: { ...edit, eols: edit.eols && [...edit.eols] },
          reverse: { start: edit.start, end: edit.start + edit.insert.length, insert: next.text.slice(edit.start, edit.end) },
          beforeEols: [...next.eols], afterEols: [...updated.eols],
        });
      }
      boundary = edit.start;
      next = updated;
    }
    if (!changes.length) return;
    this.past.push({ changes, before: options.before, after: options.after, time: Date.now() });
    this.text = next.text; this.eols = next.eols; this.future = []; this.groupBoundary = true;
  }

  edit(edit: SourceEdit | readonly SourceEdit[], options: { before?: Cursor; after?: Cursor; time?: number; group?: boolean } = {}): void {
    if (this.state === 'readonly') throw new Error('NUL source is read-only');
    // Existing stage callbacks may pass a transaction through the same entry point.
    // All multi-range validation and history recording lives in editTransaction.
    if (Array.isArray(edit)) { this.editTransaction(edit, options); return; }
    const range = edit as SourceEdit;
    this.editRange(range, options);
  }

  private editRange(edit: SourceEdit, options: { before?: Cursor; after?: Cursor; time?: number; group?: boolean }): void {
    if (edit.draft === 'cancel') {
      const pending = this.draft;
      if (!pending || edit.start !== pending.change.reverse.start || edit.end !== pending.change.reverse.end || edit.insert !== '') {
        throw new Error('Draft rollback does not match the recorded insertion');
      }
      this.cancelDraft(); return;
    }
    if (this.draft && edit.draft !== 'accept') throw new Error('Finish the pending empty-line edit first');
    if (edit.draft === 'begin' && (edit.start !== edit.end || !edit.insert.includes('\n'))) throw new Error('Draft must insert a newline');
    if (edit.draft === 'accept' && (!this.draft || edit.start !== this.draft.change.reverse.end || edit.end !== edit.start)) {
      throw new Error('First draft input must use the recorded empty-run position');
    }
    const next = applyEdit(this, edit);
    if (next.text === this.text) return;
    const time = options.time ?? Date.now();
    const previous = this.past.at(-1);
    const structural = edit.insert.includes('\n') || this.text.slice(edit.start, edit.end).includes('\n');
    const change: HistoryChange = {
      forward: { ...edit }, reverse: { start: edit.start, end: edit.start + edit.insert.length, insert: this.text.slice(edit.start, edit.end) },
      beforeEols: [...this.eols], afterEols: [...next.eols],
    };
    const runId = options.before?.runId;
    if (edit.draft === 'begin') {
      this.draft = { change, before: options.before };
      this.text = next.text; this.eols = next.eols; return;
    }
    if (edit.draft === 'accept' && this.draft) {
      this.past.push({ changes: [this.draft.change, change], before: this.draft.before, after: options.after, runId, time });
      this.draft = undefined;
    } else if (!structural && options.group !== false && !this.groupBoundary && !this.future.length && previous && runId && previous.runId === runId &&
        previous.after?.offset === options.before?.offset && time >= previous.time && time - previous.time <= 1000) {
      previous.changes.push(change); previous.after = options.after; previous.time = time;
    } else {
      this.past.push({ changes: [change], before: options.before, after: options.after, runId, time });
    }
    this.text = next.text; this.eols = next.eols;
    this.future = []; this.groupBoundary = structural;
  }

  undo(): Cursor | undefined {
    if (this.draft) return this.cancelDraft();
    const entry = this.past.pop();
    if (!entry) return;
    for (const change of [...entry.changes].reverse()) this.text = replaceRange(this.text, change.reverse);
    this.eols = [...entry.changes[0].beforeEols]; this.future.push(entry); this.groupBoundary = true;
    return entry.before;
  }
  private cancelDraft(): Cursor | undefined {
    const pending = this.draft;
    if (!pending) return;
    this.text = replaceRange(this.text, pending.change.reverse);
    this.eols = [...pending.change.beforeEols];
    this.draft = undefined;
    return pending.before;
  }
  redo(): Cursor | undefined {
    if (this.draft) this.cancelDraft();
    const entry = this.future.pop();
    if (!entry) return;
    for (const change of entry.changes) this.text = replaceRange(this.text, change.forward);
    this.eols = [...entry.changes.at(-1)!.afterEols]; this.past.push(entry); this.groupBoundary = true;
    return entry.after;
  }
  markSaved(diskHash: string): void {
    this.savedRaw = this.serialize(); this.diskHash = diskHash; this.conflict = false; this.breakHistoryGroup();
  }
  markConflict(): void { this.conflict = true; this.breakHistoryGroup(); }
  reload(raw: string, diskHash: string, hasBom = this.hasBom): void {
    const next = splitEols(raw);
    this.text = next.text; this.eols = next.eols; this.savedRaw = raw; this.diskHash = diskHash; this.hasBom = hasBom;
    this.past = []; this.future = []; this.conflict = false; this.groupBoundary = false;
    this.draft = undefined;
  }
}
