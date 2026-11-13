import { replaceRange, type Cursor, type SourceEdit } from '../document/model';
import { joinEols, type Eol } from '../document/eol';
import { applySlideRanges, collectSlideSources, planSlideOperation, slideReason, type SlideOperation, type SlideOperationResult } from './slides';
import { renderedSlideSignatures, validateSlideRendering } from './slideValidation';
import { mapBlockLines, sourceRange, tableCells } from './blocks';
import type { MarpLike, Markdown, Token } from './markdown-types';
import { getSegments, installTracking } from './tracking';
import { planNewline, type NewlineKind } from './newline';
import { emptyItemPositions, tokenSignature, withoutEmptyItemShells } from './empty';
import { captureLists, planListIndent, type ListSnapshot, type ListIndentDirection } from './listIndent';
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
  applyTableBreakDeletion(text: string, runId: string, direction: 'backward' | 'forward'): NewlineResult;
  applyNewline(text: string, runId: string, offset: number, kind: NewlineKind): NewlineResult;
  applyListIndent(text: string, runId: string, offset: number, direction: ListIndentDirection, endRunId?: string): ListIndentResult;
  cancelDraft(text: string): NewlineResult;
  /** Commit pending text input/IME and finish drafts before calling. Indices are zero-based. */
  applySlideOperation(text: string, operation: SlideOperation, eols: readonly Eol[]): SlideOperationResult;
}

export type ListIndentResult = (Extract<EditResult<SourceEdit[]>, { ok: true }> & { cursor: Cursor }) | Extract<EditResult, { ok: false }>;

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
  const tableEmptyPositions = new WeakMap<Analysis, number[]>();
  const listSnapshots = new WeakMap<Analysis, ListSnapshot>();
  let emptyPositions: number[] = [];
  wrapRenderers(md);

  md.core.ruler.before('marpit_slide', 'sm_slide_sources', state => {
    if (pending && !emptyPositions.length) {
      pending.slideSources = collectSlideSources(state.src, state.tokens, md);
      tableEmptyPositions.set(pending, findEmptyTableCells(state.src, state.tokens));
    }
  });

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
      listSnapshots.set(analysis, captureLists(text, analysisTokens.get(analysis) ?? [], token => tokenRuns.get(token)));
      if (!probes) {
        const actual = analysisTokens.get(analysis) ?? [];
        const positions = [...emptyItemPositions(text, actual), ...(tableEmptyPositions.get(analysis) ?? [])];
        if (extraEmpty !== undefined) positions.push(extraEmpty);
        if (positions.length) {
          const editable = renderAnalysis(text, reuse, undefined, [...new Set(positions)].sort((a, b) => a - b));
          // Permanent empty items may gain only their editable paragraph shell.
          if (extraEmpty === undefined && tokenSignature(withoutEmptyTableInlines(withoutEmptyItemShells(actual)), shape) !==
              tokenSignature(withoutEmptyTableInlines(withoutEmptyItemShells(analysisTokens.get(editable) ?? [])), shape)) {
            current = analysis; return analysis;
          }
          rawTokens.set(editable, actual);
          editable.slideSources = analysis.slideSources;
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

  const engine = { analyze, applyRunEdit, applyTableBreakDeletion, applyNewline, applyListIndent, cancelDraft, applySlideOperation };
  engines.set(marp, engine);
  return engine;
}

function collect(source: string, tokens: Token[], analysis: Analysis, revision: number, reuse?: Analysis): void {
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
