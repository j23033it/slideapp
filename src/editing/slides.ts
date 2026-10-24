import { replaceRange, preferredEol, type Eol, type SourceEdit } from '../document';
import type { Markdown, Token } from './markdown-types';
import type { Analysis } from './types';

export type SlideOperation =
  | { kind: 'add'; index: number }
  | { kind: 'duplicate'; index: number }
  | { kind: 'delete'; index: number }
  /** `to` is the final zero-based index after removing and inserting `index`. */
  | { kind: 'move'; index: number; to: number };
export type SlideOperationCode = 'slide-heading-divider' | 'slide-ambiguous-boundary' |
  'slide-inherited-settings' | 'slide-only-slide' | 'slide-invalid-index' |
  'slide-render-changed' | 'slide-stale-analysis' | 'slide-pending-edit' | 'slide-readonly';
export interface SlideOperationReason { code: SlideOperationCode; description: string }
export interface SlideSourceRange { start: number; end: number }
export interface SlideSources {
  frontMatter?: SlideSourceRange;
  bodies: SlideSourceRange[];
  separators: SlideSourceRange[];
  /** Source ranges containing settings that can affect other slides. */
  inheritedSettings: SlideSourceRange[];
  reason?: SlideOperationReason;
}
export type SlideOperationResult = { ok: false; reason: SlideOperationReason } | {
  ok: true; edits: SourceEdit[]; newText: string; analysis: Analysis;
  selectedSlide: number;
  /** Each new position maps to an old position; null denotes a newly added slide. */
  newToOld: Array<number | null>;
};

export function slideReason(code: SlideOperationCode): SlideOperationReason {
  const descriptions: Record<SlideOperationCode, string> = {
    'slide-heading-divider': 'headingDivider documents do not support slide operations',
    'slide-ambiguous-boundary': 'Slide source boundaries cannot be uniquely verified',
    'slide-inherited-settings': 'The affected source contains settings inherited by other slides',
    'slide-only-slide': 'The only slide cannot be deleted',
    'slide-invalid-index': 'The requested slide position is invalid',
    'slide-render-changed': 'The operation changes another slide or its rendered appearance',
    'slide-stale-analysis': 'Analyze the current document revision before operating on slides',
    'slide-pending-edit': 'Commit text input and finish the empty-line draft first',
    'slide-readonly': 'This document is read-only',
  };
  return { code, description: descriptions[code] };
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** Called immediately before Marpit consumes level-zero hr tokens. */
export function collectSlideSources(text: string, tokens: Token[], md: Markdown): SlideSources {
  const starts = lineStarts(text);
  const range = (token: Token): SlideSourceRange | undefined => {
    const map = token.map;
    if (!map || map[0] < 0 || map[1] <= map[0] || map[0] >= starts.length || map[1] > starts.length) return;
    return { start: starts[map[0]], end: starts[map[1]] ?? text.length };
  };
  const sources: SlideSources = { bodies: [], separators: [], inheritedSettings: [] };
  const ambiguous = () => { sources.reason ??= slideReason('slide-ambiguous-boundary'); };
  const marpit = md.marpit;
  const globals = marpit?.lastGlobalDirectives ?? {};
  if (Object.hasOwn(globals, 'headingDivider') || (marpit?.options.headingDivider !== undefined && marpit.options.headingDivider !== false)) {
    sources.reason = slideReason('slide-heading-divider');
  }
  let start = 0;
  for (const token of tokens) {
    if (token.type === 'front_matter') {
      const front = range(token);
      if (!front || front.start !== 0 || sources.frontMatter || sources.separators.length) ambiguous();
      else { sources.frontMatter = front; start = front.end; }
    }
    if (token.type === 'hr' && token.level === 0) {
      const separator = range(token);
      // Generated heading dividers and any synthetic/multiline boundary are unsafe.
      if (!separator || token.hidden || !token.map || token.map[1] !== token.map[0] + 1 || separator.start < start ||
          !/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})\n?$/.test(text.slice(separator.start, separator.end))) {
        ambiguous(); continue;
      }
      sources.bodies.push({ start, end: separator.start });
      sources.separators.push(separator); start = separator.end;
    }
    const inspect = (item: Token, parent: Token) => {
      const directives = item.meta?.marpitParsedDirectives;
      if (directives && typeof directives === 'object') {
        const keys = Object.keys(directives);
        if (keys.includes('headingDivider')) sources.reason = slideReason('slide-heading-divider');
        // Marpit marks recognized global directives before this rule; local ones
        // are recognized later. Include custom names from the same parser instance.
        const known = new Set(['headingDivider', 'style', 'theme', 'lang', 'backgroundColor', 'backgroundImage',
          'backgroundPosition', 'backgroundRepeat', 'backgroundSize', 'class', 'color', 'footer', 'header', 'paginate',
          ...Object.keys(marpit?.customDirectives.global ?? {}), ...Object.keys(marpit?.customDirectives.local ?? {})]);
        if (keys.some(key => known.has(key))) {
          const affected = range(parent);
          if (!affected) ambiguous(); else sources.inheritedSettings.push(affected);
        }
      }
      if (item.type === 'marpit_style' && !item.meta?.marpitStyleScoped) {
        const affected = range(parent);
        if (!affected) ambiguous(); else sources.inheritedSettings.push(affected);
      }
    };
    inspect(token, token);
    for (const child of token.children ?? []) inspect(child, token);
  }
  sources.bodies.push({ start, end: text.length });
  return sources;
}

interface SlidePlan { edits: SourceEdit[]; selectedSlide: number; newToOld: Array<number | null> }

/** Plans only replacements at the source positions recorded by the parser. */
export function planSlideOperation(
  text: string, sources: SlideSources, operation: SlideOperation, eols: readonly Eol[],
): SlidePlan | SlideOperationReason {
  if (sources.reason) return sources.reason;
  const { index } = operation, count = sources.bodies.length;
  const validIndex = (value: number) => Number.isInteger(value) && value >= 0 && value < count;
  if (!validIndex(index) || (operation.kind === 'move' && !validIndex(operation.to))) return slideReason('slide-invalid-index');
  if (operation.kind === 'delete' && count === 1) return slideReason('slide-only-slide');
  const body = sources.bodies[index];
  const protectedRange = operation.kind === 'delete' ? {
    start: index === 0 ? body.start : sources.separators[index - 1].start,
    end: index === 0 ? sources.separators[0].end : body.end,
  } : body;
  if (operation.kind !== 'add' && sources.inheritedSettings.some(range => range.start < protectedRange.end && range.end > protectedRange.start)) {
    return slideReason('slide-inherited-settings');
  }
  const atLine = (position: number) => text.slice(0, position).split('\n').length - 1;
  const nearbySeparator = sources.separators[index] ?? sources.separators[index - 1];
  const eol = (nearbySeparator && eols[atLine(nearbySeparator.start)]) || preferredEol(eols);
  const slice = (range: SlideSourceRange) => ({
    insert: text.slice(range.start, range.end),
    eols: eols.slice(atLine(range.start), atLine(range.end)) as Exclude<Eol, ''>[],
  });
  const insertion = (position: number, insert: string, endings?: Exclude<Eol, ''>[]): SourceEdit => ({
    start: position, end: position, insert,
    eols: endings ?? Array<Exclude<Eol, ''>>(insert.split('\n').length - 1).fill(eol),
  });
  const newToOld: Array<number | null> = sources.bodies.map((_, i) => i);
  if (operation.kind === 'add' || operation.kind === 'duplicate') {
    // Two newlines before --- guarantee an empty line even after a paragraph
    // without a final EOL. Existing bytes (including any blank lines) stay put.
    const prefix = (body.end > 0 && text[body.end - 1] !== '\n' ? '\n\n' : '\n') + '---\n';
    const copy = operation.kind === 'duplicate' ? slice(body) : { insert: '', eols: [] };
    const suffix = index < count - 1 && copy.insert && !copy.insert.endsWith('\n') ? '\n' : '';
    const insert = prefix + copy.insert + suffix;
    const edit = insertion(body.end, insert, [
      ...Array<Exclude<Eol, ''>>(prefix.split('\n').length - 1).fill(eol), ...copy.eols, ...(suffix ? [eol] : []),
    ]);
    newToOld.splice(index + 1, 0, operation.kind === 'duplicate' ? index : null);
    return { edits: [edit], selectedSlide: index + 1, newToOld };
  }
  if (operation.kind === 'delete') {
    newToOld.splice(index, 1);
    return { edits: [{ ...protectedRange, insert: '', eols: [] }], selectedSlide: Math.min(index, count - 2), newToOld };
  }
  newToOld.splice(index, 1); newToOld.splice(operation.to, 0, index);
  const edits: SourceEdit[] = [];
  for (let target = 0; target < count; target++) {
    const oldIndex = newToOld[target]!;
    if (oldIndex === target) continue;
    const copy = slice(sources.bodies[oldIndex]);
    if (target < count - 1 && copy.insert && !copy.insert.endsWith('\n')) {
      copy.insert += '\n\n'; copy.eols.push(eol, eol);
    }
    edits.push({ ...sources.bodies[target], ...copy });
  }
  return { edits: edits.reverse(), selectedSlide: operation.to, newToOld };
}

export function applySlideRanges(text: string, edits: readonly SourceEdit[]): string {
  for (const edit of edits) text = replaceRange(text, edit);
  return text;
}
