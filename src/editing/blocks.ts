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

/** Map cells by column using markdown-it table's escapedSplit delimiter rules. */
export function tableCells(source: string, line: number): (LineMapping & { escaped: boolean })[] | undefined {
  const lines = source.split('\n'), raw = lines[line];
  if (raw === undefined || /^[ \t]/.test(raw)) return;
  const lineStart = lines.slice(0, line).reduce((n, value) => n + value.length + 1, 0);
  const trimmed = raw.trim();
  const base = raw.length - raw.trimStart().length;
  const spans: { start: number; end: number; escaped: boolean }[] = [];
  let start = 0, escaped = false, hasEscape = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '|') {
      if (!escaped) { spans.push({ start, end: i, escaped: hasEscape }); start = i + 1; hasEscape = false; }
      else hasEscape = true;
    }
    escaped = ch === '\\';
  }
  spans.push({ start, end: trimmed.length, escaped: hasEscape });
  if (spans[0]?.end === 0) spans.shift();
  if (spans.at(-1)?.start === trimmed.length) spans.pop();
  return spans.map(span => {
    const part = trimmed.slice(span.start, span.end);
    const leading = part.length - part.trimStart().length;
    const content = part.trim();
    return { inlineStart: 0, inlineEnd: content.length, sourceStart: lineStart + base + span.start + leading, escaped: span.escaped };
  });
}
