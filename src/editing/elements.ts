import { preferredEol, type DocumentModel, type Eol, type SourceEdit } from '../document';
import type { Token } from './markdown-types';
import type { SlideSources } from './slides';
import { findBoxPairs } from '../marp/boxPairs';

export type ElementKind = 'paragraph' | 'heading' | 'list' | 'quote' | 'table' | 'code' | 'image' | 'box';
export type InsertBlockKind = ElementKind | 'html';
export type ElementReasonCode = 'element-ambiguous' | 'element-structure-changed' | 'element-heading-divider' | 'element-readonly';
export interface ElementReason { code: ElementReasonCode; description: string }
export interface SourceElement { id: string; kind: ElementKind; slide: number; start: number; end: number; signature: string; unsafe: boolean; boxStyle?: { left: number; top: number; width: number; leftStart: number; leftEnd: number; topStart: number; topEnd: number; widthStart: number; widthEnd: number; size?: number; numberStart?: number; numberEnd?: number; declarationStart?: number; declarationEnd?: number; insertAt: number }; imageAlt?: { start: number; end: number; text: string; sizes: { name: string; value: string; start: number; end: number }[] } }
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
  const boxes = new Map(findBoxPairs(text, tokens, slides).map(box => [box.open, box]));
  let valid = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.level !== 0 || token.type === 'front_matter' || token.type === 'hr') continue;
    let endIndex = i + 1;
    const box = boxes.get(token);
    if (box) {
      const closeIndex = tokens.indexOf(box.close, endIndex);
      if (closeIndex < 0) { valid = false; continue; }
      endIndex = closeIndex + 1;
    } else if (token.nesting === 1) {
      let depth = 1;
      while (endIndex < tokens.length && depth) depth += tokens[endIndex++].nesting;
      if (depth) { valid = false; break; }
    }
    const group = tokens.slice(i, endIndex); i = endIndex - 1;
    const map = token.map;
    if (!map || map[0] < 0 || map[1] <= map[0] || map[0] >= starts.length || map[1] > starts.length) { valid = false; continue; }
    const start = starts[map[0]], end = box?.end ?? (starts[map[1]] ?? text.length);
    const slide = slides.bodies.findIndex(body => start >= body.start && end <= body.end);
    if (slide < 0) { valid = false; continue; }
    let kind = box ? 'box' : kinds[token.type];
    if (kind === 'paragraph') {
      const children = group.find(t => t.type === 'inline')?.children ?? [];
      const meaningful = children.filter(t => t.type !== 'text' || t.content.trim());
      if (meaningful.length === 1 && meaningful[0].type === 'image' && !/(?:^|\s)bg(?:\s|$)/i.test(meaningful[0].content)) kind = 'image';
    }
    const sig = fingerprint(group);
    signature[slide].push(sig);
    groups.push({ slide, start, end, signature: sig, kind: kind ?? (token.type === 'html_block' ? 'html' : undefined) });
    if (!kind) continue;
    const unsafe = group.some(t => (t.type === 'html_block' && t !== box?.open && t !== box?.close) || t.type === 'marpit_comment' ||
      (t.children ?? []).some(c => c.type === 'html_inline' || /comment/.test(c.type)));
    const prior = reuse?.elements[elements.length];
    const id = prior?.kind === kind && prior.slide === slide ? prior.id : `e${revision}-${elements.length}`;
    token.attrSet('data-sm-element', id);
    let imageAlt: SourceElement['imageAlt'];
    if (kind === 'image') {
      const child = group.find(t => t.type === 'inline')?.children?.find(t => t.type === 'image');
      const match = /^ {0,3}!\[([^\]\n]*)\]\(/.exec(text.slice(start, end));
      if (match && child && child.content === match[1] && !match[1].includes('\\') &&
          (child.children ?? []).every(part => part.type === 'text') &&
          (child.children ?? []).map(part => part.content).join('') === match[1]) {
        const altStart = start + match[0].length - match[1].length - 2;
        const sizes = [...match[1].matchAll(/(?:^|\s)(w|width|h|height):([^\s]+)/g)].map(size => ({
          name: size[1], value: size[2], start: altStart + size.index! + size[0].length - size[1].length - 1 - size[2].length,
          end: altStart + size.index! + size[0].length,
        }));
        imageAlt = { start: altStart, end: altStart + match[1].length, text: match[1], sizes };
      }
    }
    let boxStyle: SourceElement['boxStyle'];
    if (box) {
      const style = text.slice(box.styleStart, box.styleEnd);
      const coords = /left[ \t]*:[ \t]*(-?\d+)px[ \t]*;[ \t]*top[ \t]*:[ \t]*(-?\d+)px[ \t]*;[ \t]*width[ \t]*:[ \t]*(\d+)px/.exec(style)!;
      const leftStart = box.styleStart + coords.index + coords[0].indexOf(coords[1]);
      const topStart = box.styleStart + coords.index + coords[0].indexOf(coords[2], leftStart - box.styleStart - coords.index + coords[1].length);
      const widthStart = box.styleStart + coords.index + coords[0].lastIndexOf(coords[3]);
      const geometry = { left: Number(coords[1]), top: Number(coords[2]), width: Number(coords[3]), leftStart, leftEnd: leftStart + coords[1].length, topStart, topEnd: topStart + coords[2].length, widthStart, widthEnd: widthStart + coords[3].length };
      const font = /(;[ \t]*font-size[ \t]*:[ \t]*)(\d+)pt([ \t]*)$/.exec(style);
      const tail = /[ \t]*$/.exec(style)![0].length;
      boxStyle = font ? { ...geometry, size: Number(font[2]), numberStart: box.styleStart + font.index + font[1].length,
        numberEnd: box.styleStart + font.index + font[1].length + font[2].length,
        declarationStart: box.styleStart + font.index, declarationEnd: box.styleEnd - font[3].length,
        insertAt: box.styleStart + font.index } : { ...geometry, insertAt: box.styleEnd - tail };
    }
    elements.push({ id, kind, slide, start, end, signature: sig, unsafe, imageAlt, boxStyle });
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
