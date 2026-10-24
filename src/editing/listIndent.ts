import type { SourceEdit } from '../document/model';
import { mapBlockLines } from './blocks';
import type { Token } from './markdown-types';
import { reason, type ReadonlyReason, type Run } from './types';

export type ListIndentDirection = 'indent' | 'outdent';
type Fingerprint = (token: Token) => unknown;
interface Item {
  token: Token; list: Token; parent?: number; depth: number;
  first: number; last: number; column: number; contentColumn: number;
  marker: string; safe: boolean;
}
export interface ListSnapshot {
  items: Item[];
  runItems: Map<string, number>;
  rows: { token: Token; owner?: number }[];
  lines: { start: number; text: string }[];
}

/** Capture token ranges and columns during analysis, before any edit is requested. */
export function captureLists(source: string, tokens: Token[], runForToken: (token: Token) => Run | undefined): ListSnapshot {
  let start = 0;
  const lines = source.split('\n').map(text => { const line = { start, text }; start += text.length + 1; return line; });
  const items: Item[] = [], runItems = new Map<string, number>();
  const rows: ListSnapshot['rows'] = [];
  const stack: { token: Token; item?: number }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const parent = [...stack].reverse().find(entry => entry.item !== undefined)?.item;
    let owner = parent;
    if (token.type === 'list_item_open') {
      const list = stack.at(-1)?.token;
      const first = token.map?.[0] ?? -1, last = token.map?.[1] ?? -1;
      const marker = /^( *)([-+*]|\d{1,9}[.)])( +)(?=\S|$)/.exec(lines[first]?.text ?? '');
      const indent = marker?.[1] ?? '';
      const symbol = marker?.[2] ?? '';
      const padding = marker?.[3] ?? '';
      // Only slide/list wrappers may contain an editable list. Quotes and other
      // containers require column rules this operation deliberately does not infer.
      const safe = !!marker && padding.length <= 4 && symbol.endsWith(token.markup) &&
        !!list && /^(bullet|ordered)_list_open$/.test(list.type) &&
        stack.every(entry => /^(?:marpit_.*|bullet_list_open|ordered_list_open|list_item_open)$/.test(entry.token.type)) &&
        (parent === undefined || first > items[parent].first && indent.length >= items[parent].contentColumn) &&
        first >= 0 && last > first && last <= lines.length;
      owner = items.length;
      items.push({ token, list: list ?? token, parent, depth: parent === undefined ? 0 : items[parent].depth + 1,
        first, last, column: indent.length, contentColumn: indent.length + symbol.length + padding.length, marker: symbol, safe });
    }
    if (token.type === 'inline') {
      for (const child of token.children ?? []) {
        const run = runForToken(child);
        if (run && owner !== undefined) runItems.set(run.id, owner);
      }
      if (owner !== undefined) {
        const mapping = mapBlockLines(source, token, tokens[index - 1]);
        if (!mapping) items[owner].safe = false;
      }
    }
    if (!/^(?:(?:bullet|ordered)_list_(?:open|close)|list_item_close)$/.test(token.type)) rows.push({ token, owner });
    if (token.nesting < 0) stack.pop();
    if (token.nesting > 0) stack.push({ token, ...(token.type === 'list_item_open' ? { item: owner } : {}) });
  }
  for (const item of items) {
    for (let line = item.first; line < item.last; line++) {
      const text = lines[line]?.text;
      if (text === undefined || /^[ \t]*\t/.test(text) || (line > item.first && text.trim() && /^ */.exec(text)![0].length < item.contentColumn)) {
        item.safe = false; // Includes lazy continuation and tab-dependent columns.
      }
    }
  }
  return { items, runItems, rows, lines };
}

type IndentPlan = { ok: true; edits: SourceEdit[]; validate(after: ListSnapshot): boolean } | { ok: false; reason: ReadonlyReason };

export function planListIndent(snapshot: ListSnapshot, runId: string, direction: ListIndentDirection, fingerprint: Fingerprint): IndentPlan {
  const fail = (code: 'list-indent-target' | 'list-indent-first' | 'list-indent-top' | 'list-indent-unsafe', description: string): IndentPlan =>
    ({ ok: false, reason: reason(code, description) });
  const ordinal = snapshot.runItems.get(runId);
  if (ordinal === undefined) return fail('list-indent-target', 'Tab changes hierarchy only inside a list item');
  const { items, lines } = snapshot, target = items[ordinal];
  const subtree = items.map((item, index) => ({ item, index })).filter(({ item }) => item.first >= target.first && item.first < target.last);
  if (subtree.some(({ item }) => !item.safe) || !target.safe) return fail('list-indent-unsafe', 'List range, indentation or continuation cannot be mapped safely');
  let amount: number;
  let resetNumber = false;
  let nextParent: number | undefined;
  if (direction === 'indent') {
    const previous = items.slice(0, ordinal).reverse().find(item => item.parent === target.parent && item.list === target.list);
    if (!previous) return fail('list-indent-first', 'The first item has no preceding sibling');
    if (!previous.safe) return fail('list-indent-unsafe', 'The preceding item has ambiguous indentation');
    amount = previous.contentColumn - target.column;
    nextParent = items.indexOf(previous);
    // A list with a different marker cannot absorb this item as a sibling.
    const childLists = items.filter(item => item.parent === items.indexOf(previous));
    resetNumber = /^\d/.test(target.marker) && !childLists.some(item => item.list.type === target.list.type && item.list.markup === target.list.markup);
  } else {
    if (target.parent === undefined) return fail('list-indent-top', 'A top-level item cannot be outdented');
    const parent = items[target.parent];
    if (!parent.safe) return fail('list-indent-unsafe', 'The parent item has ambiguous indentation');
    amount = target.column - parent.column;
    nextParent = parent.parent;
  }
  if (!Number.isInteger(amount) || amount <= 0) return fail('list-indent-unsafe', 'Indentation columns are not uniquely determined');
  const ranges: SourceEdit[] = [];
  for (let line = target.first; line < target.last; line++) {
    const { start, text } = lines[line];
    if (!text.trim()) continue; // Keep blank lines byte-for-byte, including existing spaces.
    const indent = /^ */.exec(text)![0].length;
    if (direction === 'outdent' && indent < amount) return fail('list-indent-unsafe', 'A continuation line cannot be outdented safely');
    const change: SourceEdit = direction === 'indent'
      ? { start, end: start, insert: ' '.repeat(amount) }
      : { start, end: start + amount, insert: '' };
    if (line === target.first && resetNumber) {
      // Include only this line's indentation and numeric marker, preserving ./).
      change.end = start + target.column + target.marker.length - 1;
      change.insert = ' '.repeat(target.column + amount) + '1';
    }
    ranges.push(change);
  }
  const delta = direction === 'indent' ? 1 : -1;
  const moved = new Set(subtree.map(({ index }) => index));
  const signature = (state: ListSnapshot, expected: boolean): string => JSON.stringify({
    items: state.items.map((item, index) => {
      // start is derived from the first marker of each resulting ordered list.
      const list = { ...item.list, attrs: item.list.attrs?.filter(([key]) => key !== 'start') ?? null };
      let parent = item.parent;
      if (expected && index === ordinal) parent = nextParent;
      else if (expected && direction === 'outdent' && index > ordinal && item.parent === target.parent) parent = ordinal;
      return [item.depth + (expected && moved.has(index) ? delta : 0), parent, fingerprint(list)];
    }),
    rows: state.rows.map(({ token, owner }) => [owner,
      fingerprint(expected && resetNumber && token === target.token ? { ...token, info: '1' } : token),
      token.children?.map(fingerprint) ?? null]),
  });
  const expected = signature(snapshot, true);
  return { ok: true, edits: ranges.reverse(), validate: after => signature(after, false) === expected };
}
