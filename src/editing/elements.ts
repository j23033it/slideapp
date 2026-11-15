import { preferredEol, type DocumentModel, type Eol, type SourceEdit } from '../document';
import type { Token } from './markdown-types';
import type { SlideSources } from './slides';

export type ElementKind = 'paragraph' | 'heading' | 'list' | 'quote' | 'table' | 'code' | 'image';
export type InsertBlockKind = ElementKind | 'html';
export type ElementReasonCode = 'element-ambiguous' | 'element-structure-changed' | 'element-heading-divider' | 'element-readonly';
export interface ElementReason { code: ElementReasonCode; description: string }
export interface SourceElement { id: string; kind: ElementKind; slide: number; start: number; end: number; signature: string; unsafe: boolean }
export interface SourceGroup { slide: number; start: number; end: number; signature: string; kind?: InsertBlockKind }
export interface ElementSources { elements: SourceElement[]; groups: SourceGroup[]; signature: string[][]; valid: boolean }
export type ElementOperation = { kind: 'delete'; elementId: string } | {
  kind: 'insert'; slide: number; anchor?: { elementId: string; side: 'before' | 'after' };
  lines: string[]; expectedKinds: InsertBlockKind[];
};
export type ElementOperationResult = { ok: false; reason: ElementReason } | {
  ok: true; edit: SourceEdit; newText: string; analysis: import('./types').Analysis;
};
export function elementReason(code: ElementReasonCode): ElementReason { return { code, description: code }; }

/** Validate against the current revision, then record the single replacement as one undo entry. */
export function applyElementTransaction(model: DocumentModel, engine: import('./engine').EditingEngine, operation: ElementOperation, options: { readonly?: boolean } = {}): ElementOperationResult {
  if (options.readonly || model.state === 'readonly' || model.state === 'conflict') return { ok: false, reason: elementReason('element-readonly') };
  const result = engine.applyElementOperation(model.text, operation, model.eols);
  if (!result.ok) return result;
  try { model.editTransaction([result.edit]); }
  catch {
    engine.analyze(model.text);
    return { ok: false, reason: elementReason('element-ambiguous') };
  }
  return result;
}

const kinds: Record<string, ElementKind> = {
  paragraph_open: 'paragraph', heading_open: 'heading', bullet_list_open: 'list', ordered_list_open: 'list',
  blockquote_open: 'quote', table_open: 'table', fence: 'code', code_block: 'code',
};
function fingerprint(tokens: Token[]): string {
  const shape = (t: Token): unknown => [t.type, t.tag, t.nesting, t.markup, t.info, t.hidden, t.content,
    t.attrs?.filter(([name]) => !name.startsWith('data-sm-')) ?? null, t.children?.map(shape) ?? null];
  return JSON.stringify(tokens.map(shape));
}
/** Capture top-level token groups while their original markdown-it line maps still exist. */
export function collectElements(text: string, tokens: Token[], slides: SlideSources, revision: number, reuse?: ElementSources): ElementSources {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const elements: SourceElement[] = [], groups: SourceGroup[] = [], signature = slides.bodies.map(() => [] as string[]);
  let valid = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.level !== 0 || token.type === 'front_matter' || token.type === 'hr') continue;
    let endIndex = i + 1;
    if (token.nesting === 1) {
      let depth = 1;
      while (endIndex < tokens.length && depth) depth += tokens[endIndex++].nesting;
      if (depth) { valid = false; break; }
    }
    const group = tokens.slice(i, endIndex); i = endIndex - 1;
    const map = token.map;
    if (!map || map[0] < 0 || map[1] <= map[0] || map[0] >= starts.length || map[1] > starts.length) { valid = false; continue; }
    const start = starts[map[0]], end = starts[map[1]] ?? text.length;
    const slide = slides.bodies.findIndex(body => start >= body.start && end <= body.end);
    if (slide < 0) { valid = false; continue; }
    let kind = kinds[token.type];
    if (kind === 'paragraph') {
      const children = group.find(t => t.type === 'inline')?.children ?? [];
      const meaningful = children.filter(t => t.type !== 'text' || t.content.trim());
      if (meaningful.length === 1 && meaningful[0].type === 'image' && !/(?:^|\s)bg(?:\s|$)/i.test(meaningful[0].content)) kind = 'image';
    }
    const sig = fingerprint(group);
    signature[slide].push(sig);
    groups.push({ slide, start, end, signature: sig, kind: kind ?? (token.type === 'html_block' ? 'html' : undefined) });
    if (!kind) continue;
    const unsafe = group.some(t => t.type === 'html_block' || t.type === 'marpit_comment' ||
      (t.children ?? []).some(c => c.type === 'html_inline' || /comment/.test(c.type)));
    const prior = reuse?.elements[elements.length];
    const id = prior?.kind === kind && prior.slide === slide ? prior.id : `e${revision}-${elements.length}`;
    token.attrSet('data-sm-element', id);
    elements.push({ id, kind, slide, start, end, signature: sig, unsafe });
  }
  return { elements, groups, signature, valid };
}

export function planElementOperation(text: string, sources: ElementSources, slides: SlideSources, operation: ElementOperation, eols: readonly Eol[]): SourceEdit | ElementReason {
  if (slides.reason?.code === 'slide-heading-divider') return elementReason('element-heading-divider');
  if (slides.reason || !sources.valid) return elementReason('element-ambiguous');
  if (operation.kind === 'delete') {
    const element = sources.elements.find(e => e.id === operation.elementId);
    if (!element || element.unsafe) return elementReason('element-ambiguous');
    const peers = sources.elements.filter(e => e.slide === element.slide);
    const index = peers.indexOf(element), body = slides.bodies[element.slide];
    let { start, end } = element;
    if (peers.length > 1 && index < peers.length - 1) {
      const gap = text.slice(end, peers[index + 1].start);
      const blank = /^(?:[ \t]*\n)*/.exec(gap)?.[0] ?? '';
      end += blank.length;
    } else if (peers.length > 1) {
      const previous = peers[index - 1];
      const gap = text.slice(previous.end, start);
      if (/^(?:[ \t]*\n)*$/.test(gap)) start = previous.end;
    }
    if (start < body.start || end > body.end) return elementReason('element-ambiguous');
    return { start, end, insert: '', eols: [] };
  }
  const body = slides.bodies[operation.slide];
  if (!body || !operation.lines.length || !operation.expectedKinds.length || operation.lines.some(line => /[\r\n\0]/.test(line))) return elementReason('element-ambiguous');
  const anchor = operation.anchor && sources.elements.find(e => e.id === operation.anchor!.elementId && e.slide === operation.slide);
  if (operation.anchor && (!anchor || anchor.unsafe)) return elementReason('element-ambiguous');
  const position = anchor ? (operation.anchor!.side === 'before' ? anchor.start : anchor.end) : body.end;
  const before = text.slice(body.start, position), after = text.slice(position, body.end);
  const prefix = position > 0 && text[position - 1] !== '\n' ? '\n\n' : before && !/(?:^|\n)[ \t]*\n$/.test(before) ? '\n' : '';
  const suffix = after ? (after.startsWith('\n') || /^[ \t]*\n/.test(after) ? '\n' : '\n\n') :
    operation.slide < slides.separators.length ? '\n\n' : '\n';
  const insert = prefix + operation.lines.join('\n') + suffix;
  const line = text.slice(0, position).split('\n').length - 1;
  const eol = eols[line] || eols[line - 1] || preferredEol(eols);
  return { start: position, end: position, insert, eols: Array(insert.split('\n').length - 1).fill(eol) };
}
