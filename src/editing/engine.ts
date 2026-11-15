import { replaceRange, type Cursor, type SourceEdit } from '../document/model';
import { joinEols, type Eol } from '../document/eol';
import { applySlideRanges, collectSlideSources, planSlideOperation, slideReason, type SlideOperation, type SlideOperationResult } from './slides';
import { renderedSlideSignatures, validateSlideRendering } from './slideValidation';
import { mapBlockLines, sourceRange, tableCells } from './blocks';
import type { MarpLike, Markdown, Token } from './markdown-types';
import { getSegments, getMarkerRange, installTracking } from './tracking';
import { planNewline, sourcePoint, type NewlineKind } from './newline';
import { emptyItemPositions, tokenSignature, withoutEmptyItemShells } from './empty';
import { captureLists, planListIndent, type ListSnapshot, type ListIndentDirection } from './listIndent';
import { collectElements, elementReason, planElementOperation, type ElementOperation, type ElementOperationResult } from './elements';
import { captureTableSnapshots, planTableOperation, validateTableOperation, type TableOperation, type TableResult } from './tableOperations';
import { reason, type Analysis, type Block, type EditResult, type ReadonlyReason, type Run } from './types';
import { findBoxPairs } from '../marp/boxPairs';

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
  applyTableBreakDeletion(text: string, runId: string, direction: 'backward' | 'forward'): NewlineResult;
  applyNewline(text: string, runId: string, offset: number, kind: NewlineKind): NewlineResult;
  applyListIndent(text: string, runId: string, offset: number, direction: ListIndentDirection, endRunId?: string): ListIndentResult;
  applyBold(text: string, start: Cursor, end: Cursor): BoldResult;
  isBold(runId: string): boolean;
  isElementBold(elementId: string): boolean;
  applyElementBold(text: string, elementId: string): ElementBoldResult;
  cancelDraft(text: string): NewlineResult;
  /** Commit pending text input/IME and finish drafts before calling. Indices are zero-based. */
  applySlideOperation(text: string, operation: SlideOperation, eols: readonly Eol[]): SlideOperationResult;
  applyElementOperation(text: string, operation: ElementOperation, eols: readonly Eol[]): ElementOperationResult;
  insertBox(text: string, slide: number, width: number, height: number, eols: readonly Eol[]): NewlineResult;
  applyTableOperation(text: string, operation: TableOperation, eols: readonly Eol[]): TableResult;
}

export type ListIndentResult = (Extract<EditResult<SourceEdit[]>, { ok: true }> & { cursor: Cursor }) | Extract<EditResult, { ok: false }>;
export type BoldResult = (Extract<EditResult<SourceEdit[]>, { ok: true }> & { cursor: Cursor; selectionEnd: Cursor }) | Extract<EditResult, { ok: false }>;

export type ElementBoldResult = (Extract<EditResult<SourceEdit[]>, { ok: true }> & { elementId: string }) | Extract<EditResult, { ok: false }>;
interface InlineRange { token: Token; lines?: [number, number]; start?: number; end?: number }

interface StrongRange { open: Token; close: Token; start: number; end: number; closeStart: number; closeEnd: number; runs: Run[]; textOnly: boolean }

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
  let elementRevision = 0;
  const analysisTokens = new WeakMap<Analysis, Token[]>();
  const rawTokens = new WeakMap<Analysis, Token[]>();
  const tableEmptyPositions = new WeakMap<Analysis, number[]>();
  const boxEmptyPositions = new WeakMap<Analysis, number[]>();
  const listSnapshots = new WeakMap<Analysis, ListSnapshot>();
  const strongRanges = new WeakMap<Analysis, StrongRange[]>();
  const boldRuns = new WeakMap<Analysis, Set<string>>();
  const rawStrongRanges = new WeakMap<Analysis, StrongRange[]>();
  const inlineRanges = new WeakMap<Analysis, InlineRange[]>();
  let emptyPositions: number[] = [];
  wrapRenderers(md);

  md.core.ruler.before('marpit_slide', 'sm_slide_sources', state => {
    if (!pending) return;
    const slides = collectSlideSources(state.src, state.tokens, md);
    if (!emptyPositions.length) {
      pending.slideSources = slides;
      pending.elementSources = collectElements(state.src, state.tokens, slides, ++elementRevision, reuseIds?.elementSources);
      tableEmptyPositions.set(pending, findEmptyTableCells(state.src, state.tokens));
      boxEmptyPositions.set(pending, findEmptyBoxes(state.src, state.tokens, slides));
      return;
    }
    // Probes change source offsets and may create a temporary block. Only map
    // rendered elements back to uniquely matching original source ranges.
    const rendered = collectElements(state.src, state.tokens, slides, ++elementRevision);
    const probePositions = emptyPositions.map((position, index) => position + index);
    const originalOffset = (position: number) => position - probePositions.filter(probe => probe < position).length;
    const ids = new Map<string, string>();
    for (const element of rendered.elements) {
      const matches = reuseIds?.elementSources?.elements.filter(original => original.kind === element.kind && original.slide === element.slide &&
        original.start === originalOffset(element.start) && original.end === originalOffset(element.end)) ?? [];
      if (matches.length === 1) ids.set(element.id, matches[0].id);
    }
    for (const token of state.tokens) {
      const attribute = token.attrs?.find(([name]) => name === 'data-sm-element');
      if (!attribute) continue;
      const id = ids.get(attribute[1]);
      if (id) attribute[1] = id;
      else token.attrs = token.attrs!.filter(([name]) => name !== 'data-sm-element');
    }
  });

  md.core.ruler.push('sm_source_map', state => {
    if (!pending) return;
    collect(state.src, state.tokens, pending, ++revision, reuseIds, (ranges, runs, inlines) => { strongRanges.set(pending!, ranges); boldRuns.set(pending!, runs); inlineRanges.set(pending!, inlines); });
    if (emptyPositions.length) {
      const probePositions = emptyPositions.map((position, index) => position + index);
      for (const range of strongRanges.get(pending) ?? []) {
        const originalOffset = (position: number) => position - probePositions.filter(probe => probe < position).length;
        range.start = originalOffset(range.start); range.end = originalOffset(range.end);
        range.closeStart = originalOffset(range.closeStart); range.closeEnd = originalOffset(range.closeEnd);
      }
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
      listSnapshots.set(analysis, captureLists(text, analysisTokens.get(analysis) ?? [], token => tokenRuns.get(token)));
      if (!probes) {
        const actual = analysisTokens.get(analysis) ?? [];
        const emptyBoxes = boxEmptyPositions.get(analysis) ?? [];
        const positions = [...emptyItemPositions(text, actual), ...(tableEmptyPositions.get(analysis) ?? []), ...emptyBoxes];
        if (extraEmpty !== undefined) positions.push(extraEmpty);
        if (positions.length) {
          const editable = renderAnalysis(text, analysis, undefined, [...new Set(positions)].sort((a, b) => a - b));
          // Permanent empty items may gain only their editable paragraph shell.
          if (extraEmpty === undefined && tokenSignature(withoutEmptyTableInlines(withoutEmptyItemShells(actual)), shape) !==
              tokenSignature(withoutEmptyBoxShells(withoutEmptyTableInlines(withoutEmptyItemShells(analysisTokens.get(editable) ?? [])), text, emptyBoxes), shape)) {
            captureTableSnapshots(analysis); current = analysis; return analysis;
          }
          rawTokens.set(editable, actual);
          inlineRanges.set(editable, inlineRanges.get(analysis) ?? []);
          rawStrongRanges.set(editable, strongRanges.get(analysis) ?? []);
          editable.slideSources = analysis.slideSources;
          editable.elementSources = analysis.elementSources;
          captureTableSnapshots(editable);
          return editable;
        }
      }
      captureTableSnapshots(analysis);
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
    const tableCell = before.blocks.find(block => block.id === run.blockId)?.tableCell;
    if (/[\r\n\0]/.test(newRunText)) return fail(reason('newline', 'Run edits cannot insert newlines or NUL'));
    const edit = makeRunEdit(run, newRunText);
    if (!edit) return fail(reason('ambiguous-source', 'Edit crosses an unmapped source gap'));
    if (tableCell && edit.insert.includes('|')) return fail(reason('table-input', 'Pipes cannot be entered in table cells'));
    let parseFailed = false;
    const tryEdit = (candidate: SourceEdit, escaped: boolean): EditResult | undefined => {
      const newText = replaceRange(text, candidate);
      let after: Analysis;
      try { after = renderAnalysis(newText, before); }
      catch { parseFailed = true; return; }
      if (tableCell && !newRunText && run.text) {
        if (!validRemovedRun(analysisTokens.get(before) ?? [], analysisTokens.get(after) ?? [], run)) return;
        const oldBlock = before.blocks.findIndex(block => block.id === run.blockId);
        let nextBlock = after.blocks[oldBlock];
        const oldIds = before.blocks[oldBlock].runs, position = oldIds.indexOf(run.id);
        let remaining = nextBlock?.runs.map(id => after.runs.find(entry => entry.id === id)!) ?? [];
        if (!remaining.some(entry => entry.editable)) {
          try { after = renderAnalysis(newText, before, candidate.start); } catch { return; }
          if (!validRemovedRun(analysisTokens.get(before) ?? [], analysisTokens.get(after) ?? [], run)) return;
          nextBlock = after.blocks[oldBlock];
          remaining = nextBlock?.runs.map(id => after.runs.find(entry => entry.id === id)!) ?? [];
        }
        const previous = remaining.slice(0, position).reverse().find(entry => entry.editable);
        const target = previous ?? remaining.slice(position).find(entry => entry.editable);
        if (!target) return;
        return { ok: true, edit: candidate, newText, analysis: after, escaped, cursor: { runId: target.id, offset: previous ? previous.text.length : 0 } };
      }
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

  function applyTableBreakDeletion(text: string, runId: string, direction: 'backward' | 'forward'): NewlineResult {
    const before = current;
    const fail = (why: ReadonlyReason): NewlineResult => { current = before; return { ok: false, reason: why }; };
    const run = before?.runs.find(entry => entry.id === runId);
    if (!before || before.text !== text || !run) return fail(reason('stale-run', 'Analyze this document revision before editing'));
    const blockIndex = before.blocks.findIndex(block => block.id === run.blockId);
    if (!run.editable || !before.blocks[blockIndex]?.tableCell) return fail(reason('cross-run', 'Only a table cell break can be deleted here'));
    const tokens = analysisTokens.get(before) ?? [];
    const inline = tokens.find(token => token.type === 'inline' && token.children?.some(child => tokenRuns.get(child) === run));
    const children = inline?.children ?? [];
    const index = children.findIndex(child => tokenRuns.get(child) === run);
    const breakIndex = index + (direction === 'backward' ? -1 : 1);
    const br = children[breakIndex];
    const left = children[breakIndex - 1], right = children[breakIndex + 1];
    const leftRun = left && tokenRuns.get(left), rightRun = right && tokenRuns.get(right);
    const trace = br && getSegments(br), runTrace = getSegments(children[index]);
    if (br?.type !== 'html_inline' || !/^<br\s*\/?>$/i.test(br.content) || trace?.length !== 1 || !inline ||
        (direction === 'forward' ? leftRun !== run : rightRun !== run)) {
      return fail(reason('cross-run', 'There is no deletable break adjacent to this run'));
    }
    const anchor = direction === 'forward' ? run.segments.at(-1)?.end : run.segments[0]?.start;
    if (anchor === undefined) return fail(reason('ambiguous-source', 'Break source range cannot be verified'));
    const start = direction === 'forward' ? anchor : anchor - br.content.length;
    const edit: SourceEdit = { start, end: start + br.content.length, insert: '' };
    const adjacentTrace = direction === 'forward' ? runTrace?.at(-1)?.end === trace[0].start : runTrace?.[0]?.start === trace[0].end;
    if (start < 0 || text.slice(edit.start, edit.end) !== br.content || (run.text !== '' && !adjacentTrace)) {
      return fail(reason('ambiguous-source', 'Break source range cannot be verified'));
    }
    const newText = replaceRange(text, edit);
    let after: Analysis;
    try { after = renderAnalysis(newText); } catch { return fail(reason('invalid-source', 'Parser could not validate break deletion')); }
    const expectedLeft = leftRun?.text ?? '', expectedRight = rightRun?.text ?? '';
    const targetStart = leftRun ? leftRun.segments[0]?.start : anchor - br.content.length;
    let target = after.runs.find(entry => entry.blockId === after.blocks[blockIndex]?.id && entry.segments[0]?.start === targetStart);
    if (!target && !expectedLeft && !expectedRight) {
      target = after.runs.find(entry => entry.blockId === after.blocks[blockIndex]?.id && entry.editable && !entry.text);
    }
    if (!target && !expectedLeft && !expectedRight) {
      try { after = renderAnalysis(newText, undefined, edit.start); } catch { return fail(reason('invalid-source', 'Parser could not validate break deletion')); }
      target = after.runs.find(entry => entry.blockId === after.blocks[blockIndex]?.id && entry.segments[0]?.start === edit.start);
    }
    if (mergedTokenSequences(tokens, br) !== mergedTokenSequences(analysisTokens.get(after) ?? [])) {
      return fail(reason('structure-changed', 'Break deletion changes other content or structure'));
    }
    if (!target?.editable || target.text !== expectedLeft + expectedRight) return fail(reason('ambiguous-source', 'Merged text has no verified caret position'));
    return { ok: true, edit, newText, analysis: after, escaped: false, separateHistory: true, cursor: { runId: target.id, offset: expectedLeft.length } };
  }

  function applyNewline(text: string, runId: string, offset: number, kind: NewlineKind): NewlineResult {
    const before = current;
    const run = before?.runs.find(entry => entry.id === runId);
    const fail = (why: ReadonlyReason): NewlineResult => { current = before; return { ok: false, reason: why }; };
    if (!before || before.text !== text || !run) return fail(reason('stale-run', 'Analyze this document revision before editing'));
    if (before.blocks.find(block => block.id === run.blockId)?.tableCell) return fail(reason('table-input', 'Newlines are not supported in table cells'));
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

  function applyListIndent(text: string, runId: string, offset: number, direction: ListIndentDirection, endRunId = runId): ListIndentResult {
    const before = current;
    const run = before?.runs.find(entry => entry.id === runId);
    const fail = (why: ReadonlyReason): ListIndentResult => { current = before; return { ok: false, reason: why }; };
    if (!before || before.text !== text || !run) return fail(reason('stale-run', 'Analyze this document revision before editing'));
    if (before.blocks.find(block => block.id === run.blockId)?.tableCell) return fail(reason('table-input', 'Tab is not supported in table cells'));
    if (before.draft) return fail(reason('list-indent-target', 'Fill or finish the empty-line draft first'));
    if (!run.editable) return fail(run.reason ?? reason('ambiguous-source', 'Run has no verified source map'));
    if (!Number.isInteger(offset) || offset < 0 || offset > run.text.length) return fail(reason('ambiguous-source', 'Invalid caret offset'));
    const snapshot = listSnapshots.get(before);
    if (!snapshot) return fail(reason('list-indent-unsafe', 'List metadata is unavailable'));
    if (snapshot.runItems.get(runId) !== snapshot.runItems.get(endRunId) || !before.runs.some(entry => entry.id === endRunId && entry.editable)) {
      return fail(reason('list-indent-target', 'The selection must remain inside one list item'));
    }
    const plan = planListIndent(snapshot, runId, direction, shape);
    if (!plan.ok) return fail(plan.reason);
    const newText = plan.edits.reduce((next, edit) => replaceRange(next, edit), text);
    let after: Analysis;
    try { after = renderAnalysis(newText); }
    catch { return fail(reason('invalid-source', 'Parser could not validate the list indentation')); }
    const nextSnapshot = listSnapshots.get(after);
    if (!nextSnapshot || !plan.validate(nextSnapshot) || before.runs.length !== after.runs.length ||
        before.runs.some((old, index) => old.text !== after.runs[index].text)) {
      return fail(reason('list-indent-unsafe', 'Indentation changes other content or Markdown structure'));
    }
    const target = after.runs[before.runs.indexOf(run)];
    if (!target?.editable) return fail(reason('ambiguous-source', 'The item has no verified editable caret position'));
    return { ok: true, edit: plan.edits, newText, analysis: after, escaped: false, cursor: { runId: target.id, offset } };
  }

  function isBold(runId: string): boolean {
    return !!current && !!boldRuns.get(current)?.has(runId);
  }

  function elementInlines(analysis: Analysis, id: string): InlineRange[] | undefined {
    const element = analysis.elementSources?.elements.find(entry => entry.id === id);
    if (!element || element.unsafe || element.kind === 'code' || element.kind === 'image') return;
    const all = inlineRanges.get(analysis) ?? [];
    // Line maps identify the owning top-level element even for nested lists and boxes.
    const starts = [0];
    for (let i = 0; i < analysis.text.length; i++) if (analysis.text[i] === '\n') starts.push(i + 1);
    return all.filter(entry => {
      if (entry.start !== undefined && entry.end !== undefined) return entry.start >= element.start && entry.end <= element.end;
      const map = entry.lines;
      return map && (starts[map[0]] ?? -1) >= element.start && (starts[map[1]] ?? analysis.text.length) <= element.end;
    }).filter(entry => entry.token.content.trim().length > 0);
  }

  function wholeStrong(entry: InlineRange): boolean {
    const children = entry.token.children ?? [];
    const opens = children.filter(child => child.type === 'strong_open');
    if (opens.length !== 1 || children.filter(child => child.type === 'strong_close').length !== 1) return false;
    const open = children.indexOf(opens[0]), close = children.findIndex(child => child.type === 'strong_close');
    if (close <= open) return false;
    return children.every((child, index) => index > open && index < close ||
      (child.type === 'text' ? !child.content.trim() : ['strong_open', 'strong_close', 'em_open', 'em_close', 'link_open', 'link_close', 's_open', 's_close'].includes(child.type)));
  }

  function isElementBold(elementId: string): boolean {
    const entries = current && elementInlines(current, elementId);
    return !!entries?.length && entries.every(wholeStrong);
  }

  function applyElementBold(text: string, elementId: string): ElementBoldResult {
    const before = current;
    const fail = (): ElementBoldResult => { current = before; return { ok: false, reason: reason('bold-invalid-position', 'bold-invalid-position') }; };
    if (!before || before.text !== text || before.draft) return fail();
    const entries = elementInlines(before, elementId);
    if (!entries?.length || (inlineRanges.get(before) ?? []).some(entry => entry.token.content.trim() && !entry.lines && entry.start === undefined) ||
        entries.some(entry => entry.start === undefined || entry.end === undefined || entry.start >= entry.end)) return fail();
    const remove = entries.every(wholeStrong);
    const ranges = rawStrongRanges.get(before) ?? strongRanges.get(before) ?? [];
    const edits: SourceEdit[] = [];
    for (const entry of entries) {
      const children = entry.token.children ?? [];
      const own = ranges.filter(range => children.includes(range.open) && children.includes(range.close));
      if (own.length * 2 !== children.filter(child => child.type === 'strong_open' || child.type === 'strong_close').length) return fail();
      for (const range of own) {
        if (text.slice(range.start, range.end) !== range.open.markup || text.slice(range.closeStart, range.closeEnd) !== range.close.markup) return fail();
        edits.push({ start: range.start, end: range.end, insert: '' }, { start: range.closeStart, end: range.closeEnd, insert: '' });
      }
      if (!remove) {
        edits.push({ start: entry.start!, end: entry.start!, insert: '**' }, { start: entry.end!, end: entry.end!, insert: '**' });
      }
    }
    // Combine insertion at a deleted marker boundary into that same range.
    for (const edit of [...edits].filter(item => item.start === item.end)) {
      const atStart = edits.find(item => item !== edit && item.start === edit.start && item.end > item.start);
      const atEnd = edits.find(item => item !== edit && item.end === edit.start && item.end > item.start);
      if (atStart || atEnd) { (atStart ?? atEnd)!.insert = edit.insert; edits.splice(edits.indexOf(edit), 1); }
    }
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    if (edits.some((edit, index) => index > 0 && (edit.end > edits[index - 1].start || edit.start === edits[index - 1].start))) return fail();
    const newText = edits.reduce((value, edit) => replaceRange(value, edit), text);
    let after: Analysis;
    try { after = renderAnalysis(newText, before); } catch { return fail(); }
    const oldElement = before.elementSources?.elements.find(entry => entry.id === elementId);
    const nextElement = after.elementSources?.elements.find(entry => entry.id === elementId);
    const next = elementInlines(after, elementId);
    if (!oldElement || !nextElement || oldElement.kind !== nextElement.kind || !next || next.length !== entries.length ||
        next.some(entry => remove ? (entry.token.children ?? []).some(child => child.type === 'strong_open' || child.type === 'strong_close') :
          !wholeStrong(entry) || !(rawStrongRanges.get(after) ?? strongRanges.get(after) ?? []).some(range => (entry.token.children ?? []).includes(range.open) && (entry.token.children ?? []).includes(range.close))) ||
        elementBoldFingerprint(rawTokens.get(before) ?? analysisTokens.get(before) ?? [], entries) !==
          elementBoldFingerprint(rawTokens.get(after) ?? analysisTokens.get(after) ?? [], next)) return fail();
    return { ok: true, edit: edits, newText, analysis: after, escaped: false, separateHistory: true, elementId };
  }

  function applyBold(text: string, start: Cursor, end: Cursor): BoldResult {
    const before = current;
    const fail = (code: 'bold-multiple-runs' | 'bold-partial' | 'bold-invalid-position'): BoldResult => {
      current = before; return { ok: false, reason: reason(code, code) };
    };
    if (!before || before.text !== text || before.draft) return fail('bold-invalid-position');
    const first = before.runs.find(run => run.id === start.runId), last = before.runs.find(run => run.id === end.runId);
    if (!first?.editable || !last?.editable || first.blockId !== last.blockId ||
        start.offset < 0 || start.offset > first.text.length || end.offset < 0 || end.offset > last.text.length) return fail('bold-multiple-runs');
    const collapsed = first === last && start.offset === end.offset;
    const ranges = strongRanges.get(before) ?? [];
    const containing = ranges.filter(range => range.runs.includes(first) || range.runs.includes(last));
    const selected = containing.find(range => collapsed ? range.runs.includes(first) :
      range.textOnly && range.runs[0] === first && start.offset === 0 && range.runs.at(-1) === last && end.offset === last.text.length);
    if (!selected && first !== last) return fail('bold-multiple-runs');
    if (!selected && containing.length) return fail('bold-partial');
    if (!selected && (boldRuns.get(before)?.has(first.id) || boldRuns.get(before)?.has(last.id))) return fail(collapsed ? 'bold-invalid-position' : 'bold-partial');
    if (!selected && first !== last) return fail('bold-multiple-runs');
    if (!selected && collapsed) return fail('bold-invalid-position');
    let edits: SourceEdit[], targetStart: number, targetEnd: number;
    if (selected) {
      if (text.slice(selected.start, selected.end) !== selected.open.markup || text.slice(selected.closeStart, selected.closeEnd) !== selected.close.markup) return fail('bold-invalid-position');
      edits = [{ start: selected.closeStart, end: selected.closeEnd, insert: '' }, { start: selected.start, end: selected.end, insert: '' }];
      targetStart = selected.start; targetEnd = selected.closeStart - 2;
    } else {
      const value = first.text.slice(start.offset, end.offset);
      const left = value.length - value.trimStart().length, right = value.trimEnd().length;
      if (left >= right) return fail('bold-invalid-position');
      const a = sourcePoint(first, start.offset + left), b = sourcePoint(first, start.offset + right);
      if (a === undefined || b === undefined || b <= a) return fail('bold-invalid-position');
      edits = [{ start: b, end: b, insert: '**' }, { start: a, end: a, insert: '**' }];
      targetStart = a; targetEnd = b + 2;
    }
    if (edits.some(edit => edit.start < 0 || edit.end > text.length)) return fail('bold-invalid-position');
    const newText = edits.reduce((value, edit) => replaceRange(value, edit), text);
    let after: Analysis;
    try { after = renderAnalysis(newText); } catch { return fail('bold-invalid-position'); }
    const target = selected ? selected : (strongRanges.get(after) ?? []).find(range => range.start === targetStart && range.closeStart === targetEnd && range.open.markup === '**');
    if (!target || before.structure !== after.structure ||
        boldFingerprint(analysisTokens.get(before) ?? [], selected) !== boldFingerprint(analysisTokens.get(after) ?? [], selected ? undefined : target)) return fail('bold-invalid-position');
    const oldBlock = before.blocks.findIndex(block => block.id === first.blockId);
    const oldRuns = before.blocks[oldBlock]?.runs.map(id => before.runs.find(run => run.id === id)!);
    const newRuns = after.blocks[oldBlock]?.runs.map(id => after.runs.find(run => run.id === id)!);
    if (!oldRuns || !newRuns) return fail('bold-invalid-position');
    const position = (run: Run, offset: number) => oldRuns.slice(0, oldRuns.indexOf(run)).reduce((sum, item) => sum + item.text.length, 0) + offset;
    const resolve = (offset: number, forward: boolean): Cursor | undefined => {
      for (let i = 0; i < newRuns.length; i++) {
        const run = newRuns[i];
        if (offset < run.text.length || (offset === run.text.length && (!forward || i === newRuns.length - 1))) return run.editable ? { runId: run.id, offset } : undefined;
        offset -= run.text.length;
      }
    };
    const cursor = resolve(position(first, start.offset), !collapsed), selectionEnd = resolve(position(last, end.offset), false);
    if (!cursor || !selectionEnd) return fail('bold-invalid-position');
    return { ok: true, edit: edits, newText, analysis: after, escaped: false, cursor, selectionEnd, separateHistory: true };
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

  function applySlideOperation(text: string, operation: SlideOperation, eols: readonly Eol[]): SlideOperationResult {
    const before = current;
    const fail = (code: Parameters<typeof slideReason>[0]): SlideOperationResult => {
      current = before; return { ok: false, reason: slideReason(code) };
    };
    if (!before || before.text !== text) return fail('slide-stale-analysis');
    if (before.draft) return fail('slide-pending-edit');
    if (text.includes('\0')) return fail('slide-readonly');
    const sources = before.slideSources;
    if (!sources) return fail('slide-ambiguous-boundary');
    try { joinEols(text, eols); } catch { return fail('slide-stale-analysis'); }
    const plan = planSlideOperation(text, sources, operation, eols);
    if ('code' in plan) return { ok: false, reason: plan };
    const oldSlides = renderedSlideSignatures(before.html);
    if (!oldSlides || oldSlides.length !== sources.bodies.length) return fail('slide-ambiguous-boundary');
    const newText = applySlideRanges(text, plan.edits);
    let after: Analysis;
    try { after = renderAnalysis(newText); } catch { return fail('slide-render-changed'); }
    if (!after.slideSources || after.slideSources.reason || after.slideSources.bodies.length !== plan.newToOld.length ||
        !validateSlideRendering(before.html, after.html, plan.newToOld)) return fail('slide-render-changed');
    return { ok: true, ...plan, newText, analysis: after };
  }

  function applyElementOperation(text: string, operation: ElementOperation, eols: readonly Eol[]): ElementOperationResult {
    const before = current;
    const fail = (code: Parameters<typeof elementReason>[0]): ElementOperationResult => {
      current = before; return { ok: false, reason: elementReason(code) };
    };
    if (!before || before.text !== text || before.draft || !before.slideSources || !before.elementSources) return fail('element-ambiguous');
    if (text.includes('\0')) return fail('element-readonly');
    try { joinEols(text, eols); } catch { return fail('element-ambiguous'); }
    const plan = planElementOperation(text, before.elementSources, before.slideSources, operation, eols);
    if ('code' in plan) return fail(plan.code);
    const target = operation.kind === 'delete' ? before.elementSources.elements.find(e => e.id === operation.elementId) : undefined;
    const slide = operation.kind === 'delete' ? target!.slide : operation.slide;
    const newText = replaceRange(text, plan);
    let after: Analysis;
    try { after = renderAnalysis(newText); } catch { return fail('element-structure-changed'); }
    const newSources = after.elementSources;
    const oldSlides = renderedSlideSignatures(before.html), newSlides = renderedSlideSignatures(after.html);
    if (!newSources?.valid || !after.slideSources || after.slideSources.reason || !oldSlides || !newSlides ||
        oldSlides.length !== newSlides.length || oldSlides.some((signature, index) => index !== slide && signature !== newSlides[index])) return fail('element-structure-changed');
    const oldGroups = before.elementSources.signature[slide], newGroups = newSources.signature[slide];
    if (operation.kind === 'delete') {
      const expected = [...oldGroups], index = expected.indexOf(target!.signature);
      if (index < 0) return fail('element-ambiguous');
      expected.splice(index, 1);
      if (JSON.stringify(expected) !== JSON.stringify(newGroups)) return fail('element-structure-changed');
    } else {
      const inserted = newSources.groups.filter(e => e.slide === slide && e.start >= plan.start && e.end <= plan.start + plan.insert.length);
      if (JSON.stringify(inserted.map(e => e.kind)) !== JSON.stringify(operation.expectedKinds)) return fail('element-structure-changed');
      const remaining = [...newGroups];
      for (const element of inserted) {
        const index = remaining.indexOf(element.signature);
        if (index < 0) return fail('element-structure-changed');
        remaining.splice(index, 1);
      }
      if (JSON.stringify(remaining) !== JSON.stringify(oldGroups)) return fail('element-structure-changed');
    }
    return { ok: true, edit: plan, newText, analysis: after };
  }

  function insertBox(text: string, slide: number, width: number, height: number, eols: readonly Eol[]): NewlineResult {
    const before = current;
    const fail = (): NewlineResult => { current = before; return { ok: false, reason: reason('structure-changed', 'The empty text box could not be validated') }; };
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return fail();
    const left = Math.round(width * 0.25), top = Math.round(height * 0.4), boxWidth = Math.round(width * 0.5);
    const open = `<div data-box style="position:absolute; left:${left}px; top:${top}px; width:${boxWidth}px">`;
    const inserted = applyElementOperation(text, { kind: 'insert', slide, lines: [open, '', '', '', '</div>'], expectedKinds: ['box'] }, eols);
    if (!inserted.ok) return fail();
    const prefixLength = /^\n*/.exec(inserted.edit.insert)![0].length;
    const position = inserted.edit.start + prefixLength + open.length + 2;
    let analysis: Analysis;
    try { analysis = renderAnalysis(inserted.newText, inserted.analysis, position); } catch { return fail(); }
    const run = analysis.runs.find(entry => entry.editable && entry.text === '' && entry.segments.length === 1 && entry.segments[0].start === position);
    if (!run) return fail();
    const edit: SourceEdit = { ...inserted.edit, draft: 'begin', draftPosition: position };
    analysis.draft = { runId: run.id, edit, before: { runId: '', offset: 0, slideIndex: slide } };
    current = analysis;
    return { ok: true, edit, newText: inserted.newText, analysis, escaped: false, cursor: { runId: run.id, offset: 0 } };
  }

  function applyTableOperation(text: string, operation: TableOperation, eols: readonly Eol[]): TableResult {
    const before = current;
    const fail = (code: import('./tableOperations').TableReasonCode): TableResult => {
      current = before; return { ok: false, reason: { code, description: code } };
    };
    if (!before || before.text !== text || before.draft) return fail('element-ambiguous');
    if (text.includes('\0')) return fail('element-readonly');
    try { joinEols(text, eols); } catch { return fail('element-ambiguous'); }
    const edits = planTableOperation(before, operation, eols);
    if (!Array.isArray(edits)) return fail(edits.code);
    let newText = text;
    try {
      for (const edit of edits) newText = replaceRange(newText, edit);
      const analysis = renderAnalysis(newText);
      const validated = validateTableOperation(before, analysis, operation);
      if (!validated) return fail('element-structure-changed');
      return { ok: true, edits, newText, analysis, ...validated };
    } catch { return fail('element-structure-changed'); }
  }

  const engine = { analyze, applyRunEdit, applyTableBreakDeletion, applyNewline, applyListIndent, applyBold, isBold, applyElementBold, isElementBold, cancelDraft, applySlideOperation, applyElementOperation, applyTableOperation, insertBox };
  engines.set(marp, engine);
  return engine;
}

function collect(source: string, tokens: Token[], analysis: Analysis, revision: number, reuse: Analysis | undefined, saveStrong: (ranges: StrongRange[], runs: Set<string>, inlines: InlineRange[]) => void): void {
  const strong: StrongRange[] = [];
  const bold = new Set<string>();
  const inlines: InlineRange[] = [];
  let column = 0, cellColumn = 0;
  analysis.structure = JSON.stringify(tokens.filter(t => t.type !== 'inline').map(shape));
  const stack: Token[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.nesting < 0) stack.pop();
    if (token.type === 'tr_open') column = 0;
    if (token.type === 'th_open' || token.type === 'td_open') cellColumn = column++;
    const ownReason = tokenReason(token);
    if (ownReason) analysis.readonly.push({ tokenType: token.type, lines: token.map ?? undefined, reason: ownReason });
    if (token.type === 'table_open') analysis.readonly.push({ tokenType: token.type, lines: token.map ?? undefined, reason: reason('table', 'Tables are read-only') });
    if (token.type === 'marpit_hidden_inline') {
      for (const child of token.children ?? []) {
        const why = tokenReason(child);
        if (why) analysis.readonly.push({ tokenType: child.type, lines: token.map ?? undefined, reason: why });
      }
    }
    if ((token.type === 'th_open' || token.type === 'td_open') && (tokens[index + 1]?.type === token.type.replace('_open', '_close') || (tokens[index + 1]?.type === 'marpit_hidden_inline' && !tokens[index + 1].content))) {
      const row = [...stack].reverse().find(t => t.type === 'tr_open');
      const block: Block = { id: reuse?.blocks[analysis.blocks.length]?.id ?? `b${revision}-${analysis.blocks.length}`, tag: token.tag, lines: row?.map ?? undefined, runs: [], editable: false, tableCell: true, reason: reason('table-cell', 'This cell has no verified source range') };
      analysis.blocks.push(block); analysis.inlineStructure.push(inlineShape([]));
      analysis.readonly.push({ blockId: block.id, tokenType: 'inline', lines: block.lines, reason: block.reason! });
      token.attrSet('data-sm-block', block.id);
    }
    if (token.type === 'inline') {
      const opening = tokens[index - 1];
      const block: Block = { id: reuse?.blocks[analysis.blocks.length]?.id ?? `b${revision}-${analysis.blocks.length}`, tag: opening?.tag ?? '', lines: token.map ?? undefined,
        runs: [], editable: false };
      analysis.blocks.push(block);
      analysis.inlineStructure.push(inlineShape(token.children ?? []));
      const table = stack.some(t => t.type === 'table_open');
      const row = [...stack].reverse().find(t => t.type === 'tr_open');
      const cells = table && row?.map ? tableCells(source, row.map[0]) : undefined;
      const cell = table ? cells?.[cellColumn] : undefined;
      const tableToken = stack.find(t => t.type === 'table_open');
      const tableLines = tableToken?.map && source.split('\n').slice(tableToken.map[0], tableToken.map[1]);
      const inContainer = hasTableContainer(stack) || !!tableLines?.some(line => /^[ \t]/.test(line));
      const cellMapping = cell && !cell.escaped && source.slice(cell.sourceStart, cell.sourceStart + cell.inlineEnd) === token.content ? [cell] : undefined;
      const mapping = table ? cellMapping : opening && mapBlockLines(source, token, opening);
      block.tableCell = table;
      if (table && row?.map) block.lines = row.map;
      const left = token.content.length - token.content.trimStart().length, right = token.content.trimEnd().length;
      const first = mapping && sourceRange(mapping, left, left), last = mapping && sourceRange(mapping, right, right);
      inlines.push({ token, lines: table ? row?.map ?? undefined : token.map ?? undefined, start: first?.start, end: last?.end });
      const html = htmlContents(token.children ?? []);
      const blocked = analysis.text.includes('\0') ? reason('nul', 'NUL source is read-only') :
        table && inContainer ? reason('table', 'Tables inside containers are read-only') :
        table && !mapping ? reason('table-cell', 'This cell has no verified source range') :
        !table && (!token.map || !['heading_open', 'paragraph_open'].includes(opening?.type)) ? reason('generated', 'Generated content is read-only') :
        html.ambiguous ? reason('html', 'HTML boundaries cannot be verified') :
        !mapping ? reason('ambiguous-source', 'Block has no unique line alignment') : undefined;
      block.reason = blocked;
      if (blocked) analysis.readonly.push({ blockId: block.id, tokenType: token.type, lines: block.lines, reason: blocked });
      const blockElement = opening?.hidden ? [...stack].reverse().find(t => t.type === 'list_item_open') : opening;
      if (blockElement && (!blocked || table)) blockElement.attrSet('data-sm-block', block.id);
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
      const openStack: Array<{ token: Token; range?: { start: number; end: number }; runs: Run[]; textOnly: boolean }> = [];
      for (const child of token.children ?? []) {
        const raw = getMarkerRange(child), marker = raw && mapping && sourceRange(mapping, raw.start, raw.end);
        if (child.type === 'strong_open') openStack.push({ token: child, range: marker && source.slice(marker.start, marker.end) === child.markup ? marker : undefined, runs: [], textOnly: true });
        const run = tokenRuns.get(child);
        if (run) {
          if (openStack.length) bold.add(run.id);
          for (const open of openStack) open.runs.push(run);
        }
        if (!['text', 'strong_open', 'strong_close', 'em_open', 'em_close', 'link_open', 'link_close', 's_open', 's_close'].includes(child.type)) for (const open of openStack) open.textOnly = false;
        if (child.type === 'strong_close') {
          const open = openStack.pop();
          if (open?.range && marker && source.slice(marker.start, marker.end) === child.markup) strong.push({ open: open.token, close: child, start: open.range.start, end: open.range.end, closeStart: marker.start, closeEnd: marker.end, runs: open.runs, textOnly: open.textOnly });
        }
      }
    }
    if (token.nesting > 0) stack.push(token);
  }
  saveStrong(strong, bold, inlines);
}

function elementBoldFingerprint(tokens: Token[], entries: InlineRange[]): string {
  const selected = new Set(entries.map(entry => entry.token));
  return JSON.stringify(tokens.map(token => {
    const children: unknown[][] = [];
    for (const child of token.children ?? []) {
      if (selected.has(token) && (child.type === 'strong_open' || child.type === 'strong_close')) continue;
      if (child.type === 'text' && !child.content) continue;
      if (child.type === 'text') {
        const previous = children.at(-1);
        if (previous?.[0] === 'text') previous[1] = String(previous[1]) + child.content;
        else children.push(['text', child.content]);
      } else children.push(['token', shape(child)]);
    }
    return [shape(token), token.children ? children : null];
  }));
}

function boldFingerprint(tokens: Token[], remove?: StrongRange): string {
  return JSON.stringify(tokens.map(token => {
    const children: unknown[][] = [];
    for (const child of token.children ?? []) {
      if (child === remove?.open || child === remove?.close || (child.type === 'text' && !child.content)) continue;
      if (child.type === 'text') {
        const previous = children.at(-1);
        if (previous?.[0] === 'text') previous[1] = String(previous[1]) + child.content;
        else children.push(['text', child.content]);
      } else children.push(['token', shape(child)]);
    }
    return [shape(token), token.children ? children : null];
  }));
}

function wrapRenderers(md: Markdown): void {
  for (const type of ['fence', 'code_block']) {
    const render = md.renderer.rules[type];
    if (!render) continue;
    md.renderer.rules[type] = (tokens, index, options, env, self) => {
      const html = render(tokens, index, options, env, self);
      const id = tokens[index].attrs?.find(([name]) => name === 'data-sm-element')?.[1];
      return id ? html.replace(/^<pre(?=[\s>])/, `<pre data-sm-element="${id}"`) : html;
    };
  }
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
  if (cursor.slideIndex !== undefined) return cursor;
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

function tokenSequences(tokens: Token[], remove?: Token): string {
  return JSON.stringify(tokens.map(token => [shape(token), token.children?.filter(child => child !== remove && !(child.type === 'text' && !child.content)).map(child => [shape(child), child.type === 'text' ? child.content : undefined]) ?? null]));
}

function validRemovedRun(before: Token[], after: Token[], run: Run): boolean {
  const child = before.flatMap(token => token.children ?? []).find(token => tokenRuns.get(token) === run);
  return !!child && tokenSequences(before, child) === tokenSequences(after);
}

function mergedTokenSequences(tokens: Token[], remove?: Token): string {
  return JSON.stringify(tokens.filter((token, index) => !(
    ['inline', 'marpit_hidden_inline'].includes(token.type) && ['th_open', 'td_open'].includes(tokens[index - 1]?.type) &&
    !(token.children ?? []).some(child => child !== remove && (child.type !== 'text' || child.content))
  )).map(token => {
    const children: unknown[][] = [];
    for (const child of token.children ?? []) {
      if (child === remove || (child.type === 'text' && !child.content)) continue;
      if (child.type === 'text') {
        const previous = children.at(-1);
        if (previous?.[0] === 'text') previous[1] = String(previous[1]) + child.content;
        else children.push(['text', child.content]);
      } else children.push(['token', shape(child)]);
    }
    return [shape(token), token.children ? children : null];
  }));
}

function findEmptyTableCells(source: string, tokens: Token[]): number[] {
  const result: number[] = [], stack: Token[] = [];
  let column = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.nesting < 0) stack.pop();
    if (token.type === 'tr_open') column = 0;
    if (token.type === 'th_open' || token.type === 'td_open') {
      const row = [...stack].reverse().find(entry => entry.type === 'tr_open');
      const cell = row?.map && tableCells(source, row.map[0])?.[column];
      column++;
      const table = stack.find(entry => entry.type === 'table_open');
      const tableLines = table?.map && source.split('\n').slice(table.map[0], table.map[1]);
      const inside = hasTableContainer(stack) || !!tableLines?.some(line => /^[ \t]/.test(line));
      if (!inside && cell && !cell.escaped && !cell.inlineEnd && tokens[i + 1]?.type === 'inline' && !tokens[i + 1].content) result.push(cell.sourceStart);
    }
    if (token.nesting > 0) stack.push(token);
  }
  return result;
}

function findEmptyBoxes(source: string, tokens: Token[], slides: import('./slides').SlideSources): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
  return findBoxPairs(source, tokens, slides).flatMap(box => {
    if (!box.open.map || !box.close.map) return [];
    const start = starts[box.open.map[1]], end = starts[box.close.map[0]];
    if (start === undefined || end === undefined) return [];
    const interior = source.slice(start, end);
    // Keep a blank line on either side of the synthetic paragraph.
    if (!/^(?:[ \t]*\n){3,}$/.test(interior)) return [];
    return [start + /^[ \t]*\n/.exec(interior)![0].length];
  });
}

function withoutEmptyBoxShells(tokens: Token[], source: string, positions: number[]): Token[] {
  const lines = new Set(positions.map(position => source.slice(0, position).split('\n').length - 1));
  return tokens.filter((token, index) => {
    const start = token.type === 'paragraph_open' ? index : token.type === 'inline' ? index - 1 : token.type === 'paragraph_close' ? index - 2 : -1;
    if (start < 0) return true;
    const open = tokens[start], inline = tokens[start + 1], close = tokens[start + 2];
    return !(open?.type === 'paragraph_open' && open.map && lines.has(open.map[0]) && inline?.type === 'inline' &&
      inline.content === '' && !(inline.children ?? []).some(child => child.type !== 'text' || child.content) && close?.type === 'paragraph_close');
  });
}

function withoutEmptyTableInlines(tokens: Token[]): Token[] {
  return tokens.filter((token, index) => !(['inline', 'marpit_hidden_inline'].includes(token.type) && !token.content &&
    ['th_open', 'td_open'].includes(tokens[index - 1]?.type) &&
    !token.children?.some(child => child.type !== 'text' || child.content)));
}

function hasTableContainer(stack: Token[]): boolean {
  const allowed = new Set(['marpit_containers_open', 'marpit_inline_svg_open', 'marpit_inline_svg_content_open',
    'marpit_slide_open', 'table_open', 'thead_open', 'tbody_open', 'tr_open', 'th_open', 'td_open']);
  return stack.some(token => !allowed.has(token.type));
}
