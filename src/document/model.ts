import { joinEols, preferredEol, splitEols, type Eol, type NormalizedText } from './eol';

export interface SourceEdit { start: number; end: number; insert: string }
export interface Cursor { runId: string; offset: number }
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
  const eols = [...document.eols];
  eols.splice(startLine, removed, ...Array<Eol>(added).fill(preferredEol(document.eols)));
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
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  serialize(): string { return joinEols(this.text, this.eols); }
  breakHistoryGroup(): void { this.groupBoundary = true; }

  edit(edit: SourceEdit, options: { before?: Cursor; after?: Cursor; time?: number; group?: boolean } = {}): void {
    if (this.state === 'readonly') throw new Error('NUL source is read-only');
    const next = applyEdit(this, edit);
    if (next.text === this.text) return;
    const time = options.time ?? Date.now();
    const previous = this.past.at(-1);
    const change: HistoryChange = {
      forward: { ...edit }, reverse: { start: edit.start, end: edit.start + edit.insert.length, insert: this.text.slice(edit.start, edit.end) },
      beforeEols: [...this.eols], afterEols: [...next.eols],
    };
    const runId = options.before?.runId;
    if (options.group !== false && !this.groupBoundary && !this.future.length && previous && runId && previous.runId === runId &&
        previous.after?.offset === options.before?.offset && time >= previous.time && time - previous.time <= 1000) {
      previous.changes.push(change); previous.after = options.after; previous.time = time;
    } else {
      this.past.push({ changes: [change], before: options.before, after: options.after, runId, time });
    }
    this.text = next.text; this.eols = next.eols;
    this.future = []; this.groupBoundary = false;
  }

  undo(): Cursor | undefined {
    const entry = this.past.pop();
    if (!entry) return;
    for (const change of [...entry.changes].reverse()) this.text = replaceRange(this.text, change.reverse);
    this.eols = [...entry.changes[0].beforeEols]; this.future.push(entry); this.groupBoundary = true;
    return entry.before;
  }
  redo(): Cursor | undefined {
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
  }
}
