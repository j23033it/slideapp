import { replaceRange, type Cursor, type SourceEdit } from '../document/model';
import { mapBlockLines, sourceRange } from './blocks';
import type { MarpLike, Markdown, Token } from './markdown-types';
import { getSegments, installTracking } from './tracking';
import { planNewline, type NewlineKind } from './newline';
import { emptyItemPositions, tokenSignature, withoutEmptyItemShells } from './empty';
import { reason, type Analysis, type Block, type EditResult, type ReadonlyReason, type Run } from './types';

const engines = new WeakMap<object, EditingEngine>();
const tokenRuns = new WeakMap<Token, Run>();
const readonlyTypes: Record<string, ReadonlyReason> = {
  code_inline: reason('code', 'Inline code is read-only'), fence: reason('code', 'Code blocks are read-only'),
  code_block: reason('code', 'Code blocks are read-only'), image: reason('image', 'Images are read-only'),
  html_inline: reason('html', 'HTML is read-only'), html_block: reason('html', 'HTML is read-only'),
};
function tokenReason(token: Token): ReadonlyReason | undefined {
  if (/emoji/.test(token.type)) return reason('emoji', 'Emoji replacement has no stable source map');
  if (/math/.test(token.type)) return reason('math', 'Math is read-only');
  if (/front_matter/.test(token.type)) return reason('front-matter', 'Front matter is read-only');
  if (/comment/.test(token.type)) return reason('comment', 'Comments and directives are read-only');
  if (token.type === 'marpit_style') return reason('html', 'Style blocks are read-only');
  return readonlyTypes[token.type];
}
function attributes(token: Token): [string, string][] | null {
  // Slugs are a rendering derivative of heading text, not source structure.
  const kept = token.attrs?.filter(([name]) => !name.startsWith('data-sm-') && !(name === 'id' && /^h[1-6]$/.test(token.tag)));
  return kept?.length ? kept : null;
}
function shape(token: Token): unknown {
  return [token.type, token.tag, token.nesting, token.markup, token.info, token.hidden, attributes(token),
    token.type === 'inline' ? undefined : token.content];
}
function inlineShape(tokens: Token[]): string {
  return JSON.stringify(tokens.filter(t => !(t.type === 'text' && !t.content)).map(t =>
    t.type === 'text' ? ['text'] : shape(t)));
}

/** html_inline tokens carry no nesting metadata. Only accept balanced, explicit boundaries. */
function htmlContents(tokens: Token[]): { inside: Set<Token>; ambiguous: boolean } {
  const inside = new Set<Token>(), stack: string[] = [];
  const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
  for (const token of tokens) {
    if (token.type !== 'html_inline') {
      if (stack.length) inside.add(token);
      continue;
    }
    if (/^<!--[\s\S]*-->$/.test(token.content)) continue;
    const closing = /^<\/([a-z][a-z0-9-]*)\s*>$/i.exec(token.content);
    if (closing) {
      if (stack.pop() !== closing[1].toLowerCase()) return { inside, ambiguous: true };
      continue;
    }
    // markdown-it already validated the complete HTML token, including quoted attributes.
    const opening = /^<([a-z][a-z0-9-]*)(?=[\s/>])/i.exec(token.content);
    if (!opening) return { inside, ambiguous: true };
    const tag = opening[1].toLowerCase();
    if (voidTags.has(tag)) continue;
    // A slash does not close a non-void element in HTML. Do not infer its boundary.
    if (/\/\s*>$/.test(token.content)) return { inside, ambiguous: true };
    stack.push(tag);
  }
  return { inside, ambiguous: stack.length !== 0 };
}

export interface EditingEngine {
  /** Input must be LF normalized and BOM-free (use src/document at file boundaries). */
  analyze(text: string): Analysis;
  /** Uses only the latest analysis; old IDs are rejected, never silently rebound. */
  applyRunEdit(text: string, runId: string, newRunText: string): EditResult;
  applyNewline(text: string, runId: string, offset: number, kind: NewlineKind): NewlineResult;
  cancelDraft(text: string): NewlineResult;
}

export type NewlineResult = (Extract<EditResult, { ok: true }> & { cursor: Cursor }) | Extract<EditResult, { ok: false }>;

export function createEngine(marp: MarpLike): EditingEngine {
  const existing = engines.get(marp);
  if (existing) return existing;
  const md = marp.markdown;
  installTracking(md);
  let current: Analysis | undefined;
  let pending: Analysis | undefined;
  let reuseIds: Analysis | undefined;
  let revision = 0;
  const analysisTokens = new WeakMap<Analysis, Token[]>();
  const rawTokens = new WeakMap<Analysis, Token[]>();
  let emptyPositions: number[] = [];
  wrapRenderers(md);

  md.core.ruler.push('sm_source_map', state => {
    if (!pending) return;
    collect(state.src, state.tokens, pending, ++revision, reuseIds);
    if (emptyPositions.length) {
      const probePositions = emptyPositions.map((position, index) => position + index);
      for (const token of state.tokens) {
        if (token.type !== 'inline') continue;
        for (const child of token.children ?? []) {
          const run = tokenRuns.get(child);
          if (!run) continue;
          const first = run.segments[0];
          const anchor = first && probePositions.indexOf(first.start);
          if (anchor !== undefined && anchor >= 0 && run.text === 'x' && first.end === first.start + 1) {
            const traceStart = getSegments(child)?.[0]?.start;
            if (traceStart !== undefined) token.content = token.content.slice(0, traceStart) + token.content.slice(traceStart + 1);
            child.content = ''; run.text = '';
            run.segments = [{ start: emptyPositions[anchor], end: emptyPositions[anchor], text: '', kind: 'literal' }];
          } else {
            for (const segment of run.segments) {
              segment.start -= probePositions.filter(position => position < segment.start).length;
              segment.end -= probePositions.filter(position => position < segment.end).length;
            }
          }
        }
      }
    }
    analysisTokens.set(pending, state.tokens);
  });

  function renderAnalysis(text: string, reuse?: Analysis, extraEmpty?: number, probes?: number[]): Analysis {
    if (text.includes('\r') || text.startsWith('\uFEFF')) throw new Error('Engine requires LF normalized, BOM-free text');
    const analysis: Analysis = { text, html: '', css: '', runs: [], blocks: [], readonly: [], structure: '', inlineStructure: [] };
    pending = analysis;
    reuseIds = reuse;
    emptyPositions = probes ?? [];
    try {
      let renderText = text;
      for (const position of [...emptyPositions].reverse()) renderText = replaceRange(renderText, { start: position, end: position, insert: 'x' });
      const result = marp.render(renderText);
      analysis.html = result.html; analysis.css = result.css;
      // Renderer wrappers may have discovered additional read-only transforms.
      for (const run of analysis.runs) if (run.reason && !analysis.readonly.some(r => r.runId === run.id)) {
        analysis.readonly.push({ blockId: run.blockId, runId: run.id, tokenType: 'text', reason: run.reason });
      }
      for (const block of analysis.blocks) block.editable = block.runs.some(id => analysis.runs.find(run => run.id === id)?.editable);
      if (!probes) {
        const actual = analysisTokens.get(analysis) ?? [];
        const positions = emptyItemPositions(text, actual);
        if (extraEmpty !== undefined) positions.push(extraEmpty);
        if (positions.length) {
          const editable = renderAnalysis(text, reuse, undefined, [...new Set(positions)].sort((a, b) => a - b));
          // Permanent empty items may gain only their editable paragraph shell.
          if (extraEmpty === undefined && tokenSignature(withoutEmptyItemShells(actual), shape) !==
              tokenSignature(withoutEmptyItemShells(analysisTokens.get(editable) ?? []), shape)) {
            current = analysis; return analysis;
          }
          rawTokens.set(editable, actual);
          return editable;
        }
      }
      current = analysis;
      return analysis;
    } finally { pending = undefined; reuseIds = undefined; emptyPositions = []; }
  }
  function analyze(text: string): Analysis { return renderAnalysis(text); }

  function applyRunEdit(text: string, runId: string, newRunText: string): EditResult {
    const before = current;
    const run = before?.runs.find(run => run.id === runId);
    const fail = (why: ReadonlyReason): EditResult => { current = before; return { ok: false, reason: why }; };
    if (!before || before.text !== text || !run) return fail(reason('stale-run', 'Analyze this document revision before editing'));
    if (before.draft && before.draft.runId !== runId) return fail(reason('cross-run', 'Finish the empty-line draft before editing another run'));
    if (!run.editable) return fail(run.reason ?? reason('ambiguous-source', 'Run has no verified source map'));
    if (/[\r\n\0]/.test(newRunText)) return fail(reason('newline', 'Run edits cannot insert newlines or NUL'));
    const edit = makeRunEdit(run, newRunText);
    if (!edit) return fail(reason('ambiguous-source', 'Edit crosses an unmapped source gap'));
    let parseFailed = false;
    const tryEdit = (candidate: SourceEdit, escaped: boolean): EditResult | undefined => {
      const newText = replaceRange(text, candidate);
      let after: Analysis;
      try { after = renderAnalysis(newText, before); }
      catch { parseFailed = true; return; }
      if (!validEdit(before, after, run, newRunText)) return;
      if (before.draft) candidate = { ...candidate, draft: 'accept' };
      return { ok: true, edit: candidate, newText, analysis: after, escaped };
    };
    const direct = tryEdit(edit, false);
    if (direct) return direct;
    const escaped = { ...edit, insert: escapePunctuation(edit.insert) };
    if (escaped.insert !== edit.insert) {
      const retry = tryEdit(escaped, true);
      if (retry) return retry;
    }
    return fail(parseFailed ? reason('invalid-source', 'Parser could not validate the edited source') :
      reason('structure-changed', 'Edit changes Markdown structure or other displayed text'));
  }

  function applyNewline(text: string, runId: string, offset: number, kind: NewlineKind): NewlineResult {
    const before = current;
    const run = before?.runs.find(entry => entry.id === runId);
    const fail = (why: ReadonlyReason): NewlineResult => { current = before; return { ok: false, reason: why }; };
    if (!before || before.text !== text || !run) return fail(reason('stale-run', 'Analyze this document revision before editing'));
    if (before.draft) return fail(reason('structure-changed', 'Fill or finish the pending empty line before inserting another newline'));
    if (!run.editable) return fail(run.reason ?? reason('ambiguous-source', 'Run has no verified source map'));
    const tokens = analysisTokens.get(before);
    const plan = tokens && planNewline(text, tokens, run, offset, kind, token => tokenRuns.get(token), shape);
    if (!plan) return fail(reason('structure-changed', 'A newline cannot safely split this location or its decoration'));
    const newText = replaceRange(text, plan.edit);
    let after: Analysis;
    try { after = renderAnalysis(newText, undefined, plan.empty && plan.empty !== 'item' ? plan.caretSource : undefined); }
    catch { return fail(reason('invalid-source', 'Parser could not validate the newline')); }
    if (!plan.validate(analysisTokens.get(after) ?? [])) return fail(reason('structure-changed', 'Newline changes other content or Markdown structure'));
    if (plan.validateRaw && !plan.validateRaw(rawTokens.get(after) ?? analysisTokens.get(after) ?? [])) return fail(reason('structure-changed', 'Empty item changes other Markdown structure'));
    const target = after.runs.find(entry => entry.editable && entry.segments[0]?.start === plan.caretSource);
    if (!target) return fail(reason('ambiguous-source', 'The new line has no verified editable caret position'));
    if (plan.edit.draft === 'begin') after.draft = { runId: target.id, edit: plan.edit, before: { runId, offset } };
    return { ok: true, edit: plan.edit, newText, analysis: after, escaped: false, cursor: { runId: target.id, offset: 0 } };
  }

  function cancelDraft(text: string): NewlineResult {
    const before = current;
    if (!before?.draft || before.text !== text) return { ok: false, reason: reason('stale-run', 'There is no current empty-line draft') };
    const original = before.draft.edit;
    const edit: SourceEdit = { start: original.start, end: original.start + original.insert.length, insert: '', draft: 'cancel' };
    const newText = replaceRange(text, edit);
    const analysis = renderAnalysis(newText);
    const cursor = resolveCursor(analysis, before.draft.before);
    if (!cursor) { current = before; return { ok: false, reason: reason('ambiguous-source', 'The original caret cannot be restored') }; }
    return { ok: true, edit, newText, analysis, escaped: false, cursor };
  }

  const engine = { analyze, applyRunEdit, applyNewline, cancelDraft };
  engines.set(marp, engine);
  return engine;
}

function collect(source: string, tokens: Token[], analysis: Analysis, revision: number, reuse?: Analysis): void {
  analysis.structure = JSON.stringify(tokens.filter(t => t.type !== 'inline').map(shape));
  const stack: Token[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.nesting < 0) stack.pop();
    const ownReason = tokenReason(token);
    if (ownReason) analysis.readonly.push({ tokenType: token.type, lines: token.map ?? undefined, reason: ownReason });
    if (token.type === 'table_open') analysis.readonly.push({ tokenType: token.type, lines: token.map ?? undefined, reason: reason('table', 'Tables are read-only') });
    if (token.type === 'marpit_hidden_inline') {
      for (const child of token.children ?? []) {
        const why = tokenReason(child);
        if (why) analysis.readonly.push({ tokenType: child.type, lines: token.map ?? undefined, reason: why });
      }
    }
    if (token.type === 'inline') {
      const opening = tokens[index - 1];
      const block: Block = { id: reuse?.blocks[analysis.blocks.length]?.id ?? `b${revision}-${analysis.blocks.length}`, tag: opening?.tag ?? '', lines: token.map ?? undefined,
        runs: [], editable: false };
      analysis.blocks.push(block);
      analysis.inlineStructure.push(inlineShape(token.children ?? []));
      const mapping = opening && mapBlockLines(source, token, opening);
      const html = htmlContents(token.children ?? []);
      const blocked = analysis.text.includes('\0') ? reason('nul', 'NUL source is read-only') :
        stack.some(t => t.type === 'table_open') ? reason('table', 'Tables are read-only') :
        !token.map || !['heading_open', 'paragraph_open'].includes(opening?.type) ? reason('generated', 'Generated content is read-only') :
        html.ambiguous ? reason('html', 'HTML boundaries cannot be verified') :
        !mapping ? reason('ambiguous-source', 'Block has no unique line alignment') : undefined;
      block.reason = blocked;
      if (blocked) analysis.readonly.push({ blockId: block.id, tokenType: token.type, lines: block.lines, reason: blocked });
      const blockElement = opening?.hidden ? [...stack].reverse().find(t => t.type === 'list_item_open') : opening;
      if (blockElement && !blocked) blockElement.attrSet('data-sm-block', block.id);
      for (const child of token.children ?? []) {
        const childReason = tokenReason(child);
        if (childReason) analysis.readonly.push({ blockId: block.id, tokenType: child.type, reason: childReason });
        if (child.type !== 'text' || !child.content) continue;
        const trace = getSegments(child);
        const segments = trace?.map(s => {
          const range = mapping && sourceRange(mapping, s.start, s.end);
          return range ? { ...s, ...range } : undefined;
        });
        const why = blocked ?? (html.inside.has(child) ? readonlyTypes.html_inline : undefined) ??
          (!trace || !segments || segments.some(s => !s) ? reason('ambiguous-source', 'Token lost its source positions') : undefined);
        const run: Run = { id: reuse?.runs[analysis.runs.length]?.id ?? `r${revision}-${analysis.runs.length}`, blockId: block.id, text: child.content,
          segments: segments?.filter(s => s !== undefined) ?? [], editable: !why, reason: why };
        // Verify literal source bytes a second time after all Marp postprocessing.
        if (run.segments.some(s => s.kind === 'literal' && source.slice(s.start, s.end) !== s.text)) {
          run.editable = false; run.reason = reason('ambiguous-source', 'Source segment no longer matches token');
        }
        tokenRuns.set(child, run); block.runs.push(run.id); analysis.runs.push(run);
      }
    }
    if (token.nesting > 0) stack.push(token);
  }
}

function wrapRenderers(md: Markdown): void {
  const original = md.renderer.rules.text;
  md.renderer.rules.text = (tokens, index, options, env, self) => {
    const token = tokens[index];
    const html = original(tokens, index, options, env, self);
    const run = tokenRuns.get(token);
    if (!run) return html;
    if (html !== md.utils.escapeHtml(token.content)) {
      run.editable = false; run.reason = reason('renderer-transform', 'Renderer changed the token text');
    }
    return `<span data-sm-run="${run.id}"${run.text === '' ? ' data-sm-empty="" style="display:inline-block;min-width:0.5em;min-height:1em"' : ''}>${html}</span>`;
  };
}

export function makeRunEdit(run: Run, newText: string): SourceEdit | undefined {
  const old = run.text;
  let start = 0, oldEnd = old.length, newEnd = newText.length;
  while (start < oldEnd && start < newEnd && old[start] === newText[start]) start++;
  while (oldEnd > start && newEnd > start && old[oldEnd - 1] === newText[newEnd - 1]) { oldEnd--; newEnd--; }
  // Widen partial edits of indivisible entities / escapes to their whole segment.
  let offset = 0;
  for (const segment of run.segments) {
    const end = offset + segment.text.length;
    if (segment.kind === 'special') {
      if (start > offset && start < end) start = offset;
      if (oldEnd > offset && oldEnd < end) oldEnd = end;
    }
    offset = end;
  }
  const locate = (position: number, endBias: boolean): number | undefined => {
    let offset = 0;
    for (let i = 0; i < run.segments.length; i++) {
      const segment = run.segments[i], end = offset + segment.text.length;
      if (position >= offset && position <= end && (position < end || endBias || i === run.segments.length - 1)) {
        if (segment.kind === 'special') return position === offset ? segment.start : position === end ? segment.end : undefined;
        return segment.start + position - offset;
      }
      offset = end;
    }
  };
  const sourceStart = locate(start, false), sourceEnd = locate(oldEnd, true);
  if (sourceStart === undefined || sourceEnd === undefined || sourceEnd < sourceStart) return;
  // Never consume an unrepresented marker between two segments.
  let previousEnd: number | undefined, display = 0;
  for (const segment of run.segments) {
    const displayEnd = display + segment.text.length;
    if (displayEnd > start && display < oldEnd) {
      if (previousEnd !== undefined && previousEnd !== segment.start) return;
      previousEnd = segment.end;
    }
    display = displayEnd;
  }
  // Recompute the new interval when widening the start of a special segment.
  const unchangedSuffix = old.length - oldEnd;
  const insert = newText.slice(start, newText.length - unchangedSuffix);
  return { start: sourceStart, end: sourceEnd, insert };
}

/** Restore an ordinal recorded for this history revision after a fresh analysis. */
export function resolveCursor(analysis: Analysis, cursor: Cursor): Cursor | undefined {
  const ordinal = /^r\d+-(\d+)$/.exec(cursor.runId)?.[1];
  const run = ordinal === undefined ? undefined : analysis.runs[Number(ordinal)];
  if (!run?.editable) return;
  return { runId: run.id, offset: Math.min(run.text.length, Math.max(0, cursor.offset)) };
}

function escapePunctuation(text: string): string { return text.replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '\\$&'); }

function validEdit(before: Analysis, after: Analysis, run: Run, newText: string): boolean {
  if (before.structure !== after.structure || before.inlineStructure.join('\0') !== after.inlineStructure.join('\0')) return false;
  if (before.blocks.length !== after.blocks.length || before.runs.length !== after.runs.length) return false;
  const index = before.runs.indexOf(run);
  return before.runs.every((old, i) => i === index ? after.runs[i].text === newText : after.runs[i].text === old.text);
}
