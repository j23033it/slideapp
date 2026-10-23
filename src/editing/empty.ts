import type { Token } from './markdown-types';

/** Empty list items must have an unambiguous content-start position. */
export function emptyItemPositions(source: string, tokens: Token[]): number[] {
  const lines = source.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const positions: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const item = tokens[i];
    if (item.type !== 'list_item_open' || tokens[i + 1]?.type !== 'list_item_close' || !item.map) continue;
    const line = lines[item.map[0]];
    // Preserve the marker's trailing space: it is the recorded insertion point.
    if (/^(?: *> ?)* *(?:[-+*]|\d+[.)]) +$/.test(line)) positions.push(starts[item.map[0]] + line.length);
  }
  return positions;
}

/** Compare raw empty li tokens with their editable, zero-text paragraph shell. */
export function withoutEmptyItemShells(tokens: Token[]): Token[] {
  return tokens.filter((token, i) => {
    const start = token.type === 'paragraph_open' ? i : token.type === 'inline' ? i - 1 : token.type === 'paragraph_close' ? i - 2 : -1;
    if (start < 0 || tokens[start - 1]?.type !== 'list_item_open' || tokens[start + 3]?.type !== 'list_item_close') return true;
    const inline = tokens[start + 1];
    return inline?.type !== 'inline' || !!inline.children?.some(child => child.type !== 'text' || child.content !== '');
  });
}

export function tokenSignature(tokens: Token[], fingerprint: (token: Token) => unknown): string {
  return JSON.stringify(tokens.map(token => [fingerprint(token),
    token.children ? token.children.filter(child => child.type !== 'text' || child.content !== '').map(fingerprint) : null]));
}
