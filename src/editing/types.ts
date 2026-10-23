import type { SourceEdit } from '../document/model';

export type ReadonlyCode = 'table' | 'code' | 'math' | 'image' | 'html' | 'emoji' | 'front-matter' |
  'comment' | 'generated' | 'ambiguous-source' | 'renderer-transform' | 'dom-mismatch' | 'nul' |
  'invalid-source' | 'stale-run' | 'structure-changed' | 'newline' | 'cross-run' | 'format' | 'history' | 'unsupported-input';
export interface ReadonlyReason { code: ReadonlyCode; description: string }
export function reason(code: ReadonlyCode, description: string): ReadonlyReason { return { code, description }; }
export interface Segment { start: number; end: number; text: string; kind: 'literal' | 'special' }
export interface Run {
  id: string; blockId: string; text: string; segments: Segment[]; editable: boolean; reason?: ReadonlyReason;
}
export interface Block {
  id: string; tag: string; lines?: [number, number]; runs: string[]; editable: boolean; reason?: ReadonlyReason;
}
export interface ReadonlyRegion { blockId?: string; runId?: string; tokenType: string; lines?: [number, number]; reason: ReadonlyReason }
export interface Analysis {
  text: string; html: string; css: string; runs: Run[]; blocks: Block[]; readonly: ReadonlyRegion[];
  /** Internal validation fingerprints, including read-only and generated tokens. */
  structure: string; inlineStructure: string[];
  /** Unfilled paragraph/line: remove only this recorded insertion on finish. */
  draft?: { runId: string; edit: SourceEdit; before: { runId: string; offset: number } };
}
export type EditResult = { ok: true; edit: SourceEdit; newText: string; analysis: Analysis; escaped: boolean } |
  { ok: false; reason: ReadonlyReason };
