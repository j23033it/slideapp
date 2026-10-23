import type { SourceEdit } from '../document';
import { mapBlockLines } from './blocks';
import type { Token } from './markdown-types';
import type { Run } from './types';
import { tokenSignature, withoutEmptyItemShells } from './empty';

export type NewlineKind = 'line' | 'paragraph';
type Fingerprint = (token: Token) => unknown;

function visible(tokens: Token[]): Token[] {
  return tokens.filter(token => token.type !== 'text' || token.content !== '');
}

/** Map a caret using recorded segments; never split an entity or an escape. */
function sourcePoint(run: Run, offset: number): number | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > run.text.length) return;
  let display = 0;
  for (const segment of run.segments) {
    const end = display + segment.text.length;
    if (offset >= display && offset <= end) {
      if (offset === display) return segment.start;
      if (offset === end) return segment.end;
      if (segment.kind === 'literal') return segment.start + offset - display;
      return;
    }
    display = end;
  }
}

export interface NewlinePlan {
  edit: SourceEdit;
  /** Source position of the first character on the new line. */
  caretSource: number;
  empty?: 'item' | 'paragraph' | 'line';
  validate(tokens: Token[]): boolean;
  validateRaw?(tokens: Token[]): boolean;
}

/** Construct only the explicitly allowed token splice, then compare the entire reparse. */
export function planNewline(
  source: string, tokens: Token[], run: Run, offset: number, kind: NewlineKind,
  runForToken: (token: Token) => Run | undefined, fingerprint: Fingerprint,
): NewlinePlan | undefined {
  const position = sourcePoint(run, offset);
  if (position === undefined) return;
  const inlineIndex = tokens.findIndex(token => token.type === 'inline' && token.children?.some(child => runForToken(child) === run));
  const inline = tokens[inlineIndex], opening = tokens[inlineIndex - 1];
  // Headings, cells and generated blocks are deliberately excluded.
  if (!inline || opening?.type !== 'paragraph_open') return;
  const children = inline.children ?? [];
  const childIndex = children.findIndex(child => runForToken(child) === run);
  let depth = 0;
  for (const child of children.slice(0, childIndex)) depth += child.nesting;
  if (depth !== 0) return; // Splitting an open decoration/link needs closing and reopening syntax.
  const mapping = mapBlockLines(source, inline, opening);
  if (!mapping?.length) return;
  const firstSource = mapping[0].sourceStart;
  const lineStart = source.lastIndexOf('\n', firstSource - 1) + 1;
  const prefix = source.slice(lineStart, firstSource);
  if (prefix.includes('\t')) return; // Tab widths depend on the container column.

  const stack: number[] = [];
  for (let index = 0; index < inlineIndex; index++) {
    if (tokens[index].nesting < 0) stack.pop();
    if (tokens[index].nesting > 0) stack.push(index);
  }
  const itemIndex = [...stack].reverse().find(index => tokens[index].type === 'list_item_open');
  let continuation = prefix, newItemPrefix: string | undefined;
  let nextNumber: string | undefined;
  if (itemIndex !== undefined) {
    const item = tokens[itemIndex];
    // The item's first paragraph provides a unique marker/content alignment.
    if (item.map?.[0] !== inline.map?.[0]) return;
    const marker = /^((?: *> ?)* *)([-+*]|\d+[.)])( +)((?:> ?)* *)$/.exec(prefix);
    if (!marker || !marker[2].endsWith(item.markup)) return;
    continuation = marker[1] + ' '.repeat(marker[2].length + marker[3].length) + marker[4];
    const ordered = /^(\d+)([.)])$/.exec(marker[2]);
    nextNumber = ordered ? String(Number(ordered[1]) + 1) : undefined;
    if (nextNumber && nextNumber.length > 9) return;
    newItemPrefix = marker[1] + (ordered ? nextNumber + ordered[2] : marker[2]) + marker[3] + marker[4];
  } else if (!/^(?: *> ?)* *$/.test(prefix)) return;

  const child = children[childIndex];
  const left = visible([...children.slice(0, childIndex), { ...child, content: run.text.slice(0, offset) }]);
  const right = visible([{ ...child, content: run.text.slice(offset) }, ...children.slice(childIndex + 1)]);
  if (!left.some(token => token.type === 'text' && token.content.trim())) return;
  const empty = right.length === 0 ? kind === 'line' ? 'line' : itemIndex === undefined ? 'paragraph' : 'item' : undefined;
  if (!empty && !right.some(token => token.type === 'text' && token.content.trim())) return;
  const expected = [...tokens];
  let insert: string;
  if (kind === 'line') {
    const softbreak = { ...child, type: 'softbreak', tag: 'br', nesting: 0, content: '', markup: '', attrs: null };
    expected[inlineIndex] = { ...inline, children: [...left, softbreak, ...right] };
    insert = '\n' + continuation;
  } else {
    const close = tokens[inlineIndex + 1];
    if (close?.type !== 'paragraph_close') return;
    const leftInline = { ...inline, children: left }, rightInline = { ...inline, children: right };
    if (itemIndex !== undefined) {
      // Child lists, blockquotes and multi-paragraph items are ambiguous to split.
      if (itemIndex !== inlineIndex - 2 || tokens[inlineIndex + 2]?.type !== 'list_item_close') return;
      const itemOpen = tokens[itemIndex], itemClose = tokens[inlineIndex + 2];
      expected.splice(itemIndex, 5, itemOpen, opening, leftInline, close, itemClose,
        { ...itemOpen, info: nextNumber ?? itemOpen.info }, opening, rightInline, close, itemClose);
      insert = '\n' + newItemPrefix;
    } else {
      expected.splice(inlineIndex - 1, 3, opening, leftInline, close, opening, rightInline, close);
      insert = '\n' + prefix.trimEnd() + '\n' + prefix;
    }
  }
  // Marp's incremental list markers (* and N)) derive fragment indices/counts
  // from item order. Recompute only those attributes, retaining every other one.
  if (kind === 'paragraph' && itemIndex !== undefined) {
    let slideIndex = -1, fragments = 0;
    const update = (token: Token, name: string, value: number): Token => ({
      ...token, attrs: token.attrs?.map(([key, old]) => [key, key === name ? value as unknown as string : old]) ?? null,
    });
    for (let index = 0; index < expected.length; index++) {
      const token = expected[index];
      if (token.type === 'marpit_slide_open') { slideIndex = index; fragments = 0; }
      if (token.attrs?.some(([key]) => key === 'data-marpit-fragment')) {
        expected[index] = update(token, 'data-marpit-fragment', ++fragments);
      }
      if (token.type === 'marpit_slide_close' && slideIndex >= 0) {
        expected[slideIndex] = update(expected[slideIndex], 'data-marpit-fragments', fragments);
      }
    }
  }
  const wanted = tokenSignature(expected, fingerprint);
  const rawWanted = tokenSignature(withoutEmptyItemShells(expected), fingerprint);
  return {
    edit: { start: position, end: position, insert, ...(empty && empty !== 'item' ? { draft: 'begin' as const } : {}) },
    caretSource: position + insert.length, empty,
    validate: after => tokenSignature(after, fingerprint) === wanted,
    validateRaw: empty === 'item' ? after => tokenSignature(withoutEmptyItemShells(after), fingerprint) === rawWanted : undefined,
  };
}
