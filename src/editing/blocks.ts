import type { Token } from './markdown-types';

export interface LineMapping { inlineStart: number; inlineEnd: number; sourceStart: number }

// This is a grammar for removed prefixes, not a search/replace operation.
const prefix = /^(?:[ \t]|>|[-+*][ \t]+|\d+[.)][ \t]+|#{1,6}[ \t]+)*$/;
const suffix = /^(?:[ \t]*|[ \t]+#+[ \t]*)$/;

/** Enumerate ALL allowed alignments. Only a unique alignment is safe. */
export function mapBlockLines(source: string, inline: Token, opening: Token): LineMapping[] | undefined {
  if (!inline.map) return;
  const sourceLines = source.split('\n');
  let [first, last] = inline.map;
  if (opening.type === 'heading_open' && /^[-=]+$/.test(opening.markup) && opening.map?.[1] === last) last--;
  const contentLines = inline.content.split('\n');
  if (last - first !== contentLines.length) return;
  let sourceOffset = sourceLines.slice(0, first).reduce((sum, line) => sum + line.length + 1, 0);
  let inlineOffset = 0;
  const mappings: LineMapping[] = [];
  for (let i = 0; i < contentLines.length; i++) {
    const raw = sourceLines[first + i], content = contentLines[i];
    const candidates: number[] = [];
    for (let offset = 0; offset <= raw.length - content.length; offset++) {
      if (raw.slice(offset, offset + content.length) === content && prefix.test(raw.slice(0, offset)) && suffix.test(raw.slice(offset + content.length))) {
        candidates.push(offset);
      }
    }
    if (candidates.length !== 1) return;
    mappings.push({ inlineStart: inlineOffset, inlineEnd: inlineOffset + content.length, sourceStart: sourceOffset + candidates[0] });
    sourceOffset += raw.length + 1; inlineOffset += content.length + 1;
  }
  return mappings;
}

export function sourceRange(mapping: LineMapping[], start: number, end: number): { start: number; end: number } | undefined {
  const line = mapping.find(m => start >= m.inlineStart && end <= m.inlineEnd);
  if (line) return { start: line.sourceStart + start - line.inlineStart, end: line.sourceStart + end - line.inlineStart };
}
