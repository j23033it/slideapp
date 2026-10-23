import type { EditingEngine } from '../engine';
import { reason, type Analysis, type EditResult, type ReadonlyReason } from '../types';

function runElement(node: Node | null): HTMLElement | null {
  return (node?.nodeType === 1 ? node as Element : node?.parentElement)?.closest<HTMLElement>('[data-sm-run]') ?? null;
}

interface SelectionPoint { runId: string; offset: number }
interface RunSelection { anchor: SelectionPoint; focus: SelectionPoint }

function captureSelection(root: HTMLElement): RunSelection | undefined {
  const selection = root.ownerDocument.getSelection();
  function point(node: Node | null, offset: number): SelectionPoint | undefined {
    const run = runElement(node);
    if (!node || !run || !root.contains(run)) return;
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(run); range.setEnd(node, offset);
    return { runId: run.dataset.smRun!, offset: range.toString().length };
  }
  const anchor = point(selection?.anchorNode ?? null, selection?.anchorOffset ?? 0);
  const focus = point(selection?.focusNode ?? null, selection?.focusOffset ?? 0);
  return anchor && focus ? { anchor, focus } : undefined;
}

function restoreSelection(root: HTMLElement, saved: RunSelection): void {
  function point(savedPoint: SelectionPoint): { node: Node; offset: number } | undefined {
    const run = root.querySelector<HTMLElement>(`[data-sm-run="${savedPoint.runId}"]`);
    if (!run) return;
    const walker = root.ownerDocument.createTreeWalker(run, 4 /* SHOW_TEXT */);
    let offset = Math.min(savedPoint.offset, run.textContent?.length ?? 0);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (offset <= length) return { node, offset };
      offset -= length;
    }
    return { node: run, offset: 0 };
  }
  const anchor = point(saved.anchor), focus = point(saved.focus);
  if (anchor && focus) root.ownerDocument.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
}

export function verifyRenderedRuns(root: ParentNode, analysis: Analysis): void {
  for (const run of analysis.runs) {
    const nodes = root.querySelectorAll(`[data-sm-run="${run.id}"]`);
    if (nodes.length !== 1 || nodes[0].textContent !== run.text) {
      run.editable = false; run.reason = reason('dom-mismatch', 'Rendered DOM text does not match the source run');
      analysis.readonly.push({ runId: run.id, blockId: run.blockId, tokenType: 'text', reason: run.reason });
    }
  }
  for (const block of analysis.blocks) block.editable = block.runs.some(id => analysis.runs.some(r => r.id === id && r.editable));
}

export function plainPaste(text: string): string { return text.replace(/\r\n|\r|\n/g, ' ').replace(/\0/g, ''); }

export function inputGuard(event: Pick<InputEvent, 'inputType'>, selection: Selection | null, root: HTMLElement): ReadonlyReason | undefined {
  if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') return reason('newline', 'New paragraphs are not supported');
  if (event.inputType.startsWith('format')) return reason('format', 'Formatting changes are not supported');
  if (event.inputType.startsWith('history')) return reason('history', 'Use document history instead of browser history');
  if (!/^(insertText|insertCompositionText|insertFromComposition|insertFromPaste|deleteContentBackward|deleteContentForward|deleteByCut)$/.test(event.inputType)) {
    return reason('unsupported-input', 'This browser input operation is not supported');
  }
  if (!selection || selection.rangeCount !== 1) return reason('cross-run', 'Select one range inside an editable run');
  const selectedRange = selection.getRangeAt(0);
  const start = runElement(selectedRange.startContainer), end = runElement(selectedRange.endContainer);
  if (!start || start !== end || !root.contains(start) || start.getAttribute('contenteditable') === 'false') {
    return reason('cross-run', 'Selection must remain inside one editable run');
  }
  // Browsers may merge adjacent inline elements at a boundary. Leave navigation/deletion to the host.
  if (selection?.isCollapsed && event.inputType.startsWith('deleteContent')) {
    const range = start.ownerDocument.createRange();
    range.selectNodeContents(start);
    range.setEnd(selectedRange.startContainer, selectedRange.startOffset);
    const offset = range.toString().length;
    if ((event.inputType.endsWith('Backward') && offset === 0) ||
        (event.inputType.endsWith('Forward') && offset === (start.textContent?.length ?? 0))) {
      return reason('cross-run', 'Boundary deletion requires an adjacent-run action');
    }
  }
}

export interface DomEditingOptions {
  analysis: Analysis;
  onCommit(result: Extract<EditResult, { ok: true }>): void;
  onReject(reason: ReadonlyReason): void;
  onHistory?(direction: 'undo' | 'redo'): void;
  onFinish?(): void;
}

/** Small DOM adapter. The host owns file state, undo/redo, click caret placement and final rerender. */
export function bindEditing(root: HTMLElement, engine: EditingEngine, options: DomEditingOptions) {
  let analysis = options.analysis;
  let active: HTMLElement | null = null;
  let block: HTMLElement | null = null;
  let snapshot = '';
  let composing = false;
  // A late isComposing input after compositionend belongs to the ended session.
  let compositionEnded = false;
  let provisionalInput = false;
  let enabledBlock: HTMLElement | null = null;
  const blockSnapshots = new Map<HTMLElement, string>();
  let beforeSelection: RunSelection | undefined;
  const selection = () => root.ownerDocument.getSelection();
  verifyRenderedRuns(root, analysis);

  function refreshSnapshots(): void {
    const container = enabledBlock ?? block;
    blockSnapshots.clear();
    if (!container) return;
    blockSnapshots.set(container, container.innerHTML);
    for (const nested of container.querySelectorAll<HTMLElement>('[data-sm-block]')) blockSnapshots.set(nested, nested.innerHTML);
  }

  function prepare(): void {
    if (!block) return;
    block.setAttribute('contenteditable', 'true');
    for (const node of block.querySelectorAll<HTMLElement>('*')) {
      const id = node.dataset.smRun;
      const run = analysis.runs.find(run => run.id === id);
      if (run) {
        if (run.editable) node.removeAttribute('contenteditable');
        else node.setAttribute('contenteditable', 'false');
      } else {
        const hasEditableRun = [...node.querySelectorAll<HTMLElement>('[data-sm-run]')]
          .some(element => analysis.runs.some(run => run.id === element.dataset.smRun && run.editable));
        if (hasEditableRun) node.removeAttribute('contenteditable');
        else node.setAttribute('contenteditable', 'false');
      }
    }
  }
  function begin(run: HTMLElement, provisional = false): boolean {
    const id = run.dataset.smRun;
    let entry = analysis.runs.find(r => r.id === id);
    if (!root.contains(run) || !entry?.editable) { options.onReject(entry?.reason ?? reason('ambiguous-source', 'Run is not editable')); return false; }
    let nextBlock = run.closest<HTMLElement>('[data-sm-block]');
    if (composing || provisional) {
      // Do not toggle attributes, verify provisional text, or snapshot mutated
      // markup during IME. Nested blocks inherit the already-enabled container.
      const saved = nextBlock ? blockSnapshots.get(nextBlock) : undefined;
      if (!nextBlock || saved === undefined) { options.onReject(reason('cross-run', 'Finish composition before switching blocks')); return false; }
      active = run; block = nextBlock; snapshot = saved;
      return true;
    }
    if (active !== run && block !== nextBlock) {
      const savedSelection = captureSelection(root);
      finish();
      verifyRenderedRuns(root, analysis);
      const currentRun = root.querySelector<HTMLElement>(`[data-sm-run="${id}"]`);
      entry = analysis.runs.find(r => r.id === id);
      if (!currentRun || !entry?.editable) {
        options.onReject(entry?.reason ?? reason('dom-mismatch', 'Run is missing after finishing the previous edit'));
        return false;
      }
      const replaced = run !== currentRun;
      run = currentRun;
      nextBlock = run.closest<HTMLElement>('[data-sm-block]');
      if (replaced && savedSelection) {
        nextBlock?.setAttribute('contenteditable', 'true');
        nextBlock?.focus(); restoreSelection(root, savedSelection);
      }
    }
    active = run;
    block = nextBlock;
    if (!block) { active = null; options.onReject(reason('dom-mismatch', 'Editable block is missing')); return false; }
    prepare(); snapshot = block.innerHTML;
    enabledBlock = block;
    refreshSnapshots();
    return true;
  }
  function deactivate(): void {
    block?.removeAttribute('contenteditable');
    enabledBlock?.removeAttribute('contenteditable');
    enabledBlock = null; blockSnapshots.clear();
    active = null; block = null; beforeSelection = undefined;
  }
  function finish(): void {
    if (!active) return;
    settleComposition();
    deactivate();
    options.onFinish?.();
  }
  function reject(why: ReadonlyReason): void {
    if (block) {
      const id = active?.dataset.smRun;
      block.innerHTML = snapshot;
      active = id ? block.querySelector(`[data-sm-run="${id}"]`) : null;
      if (beforeSelection) { block.focus(); restoreSelection(root, beforeSelection); }
    }
    beforeSelection = undefined;
    options.onReject(why);
  }
  function commit(): void {
    if (!active || composing) return;
    // A text run must remain text-only. Do not accept browser-inserted markup.
    if (active.children.length) { reject(reason('dom-mismatch', 'Browser inserted markup into a text run')); return; }
    if (!block?.contains(active)) { reject(reason('dom-mismatch', 'Browser removed the active run')); return; }
    const original = analysis.runs.find(run => run.id === active!.dataset.smRun);
    const clone = block.cloneNode(true) as HTMLElement;
    const clonedRun = clone.querySelector<HTMLElement>(`[data-sm-run="${active.dataset.smRun}"]`);
    if (!original || !clonedRun) { reject(reason('dom-mismatch', 'Run is missing from the current block')); return; }
    clonedRun.textContent = original.text;
    if (clone.innerHTML !== snapshot) { reject(reason('dom-mismatch', 'Browser changed content outside the active run')); return; }
    if (active.textContent === original.text) { beforeSelection = undefined; return; }
    const result = engine.applyRunEdit(analysis.text, active.dataset.smRun!, active.textContent ?? '');
    if (!result.ok) { reject(result.reason); return; }
    // Rebind the existing DOM without rerendering (validated edits retain IDs).
    for (let i = 0; i < analysis.runs.length; i++) {
      root.querySelector<HTMLElement>(`[data-sm-run="${analysis.runs[i].id}"]`)?.setAttribute('data-sm-run', result.analysis.runs[i].id);
    }
    for (let i = 0; i < analysis.blocks.length; i++) {
      root.querySelector<HTMLElement>(`[data-sm-block="${analysis.blocks[i].id}"]`)?.setAttribute('data-sm-block', result.analysis.blocks[i].id);
    }
    analysis = result.analysis;
    if (active.hasAttribute('data-sm-empty')) {
      active.removeAttribute('data-sm-empty'); active.removeAttribute('style');
    }
    verifyRenderedRuns(root, analysis); prepare(); snapshot = block?.innerHTML ?? '';
    refreshSnapshots();
    beforeSelection = undefined;
    options.onCommit(result);
  }
  function beforeinput(event: InputEvent): void {
    if (event.isComposing && !compositionEnded) provisionalInput = true;
    const why = inputGuard(event, selection(), root);
    if (why) { event.preventDefault(); options.onReject(why); return; }
    const selected = runElement(selection()?.getRangeAt(0).startContainer ?? null);
    if (selected !== active && selected && !begin(selected, event.isComposing && !compositionEnded)) { event.preventDefault(); return; }
    if (!composing || !beforeSelection) beforeSelection = captureSelection(root);
  }
  function paste(event: ClipboardEvent): void {
    event.preventDefault();
    if (composing || provisionalInput) { options.onReject(reason('unsupported-input', 'Finish composition before pasting')); return; }
    const why = inputGuard({ inputType: 'insertFromPaste' }, selection(), root);
    if (why) { options.onReject(why); return; }
    const currentSelection = selection();
    if (!event.clipboardData || !currentSelection?.rangeCount) return;
    const selected = runElement(currentSelection.getRangeAt(0).startContainer);
    if (selected !== active && selected && !begin(selected)) return;
    beforeSelection = captureSelection(root);
    const range = currentSelection.getRangeAt(0);
    range.deleteContents();
    const node = root.ownerDocument.createTextNode(plainPaste(event.clipboardData.getData('text/plain')));
    range.insertNode(node); range.setStartAfter(node); range.collapse(true);
    currentSelection.removeAllRanges(); currentSelection.addRange(range);
    commit();
  }
  function keydown(event: KeyboardEvent): void {
    if (event.isComposing || event.keyCode === 229) return;
    settleComposition();
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); options.onHistory?.(event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo');
    } else if (event.key === 'Escape') { event.preventDefault(); finish(); }
  }
  function settleComposition(): void {
    if (composing || provisionalInput) compositionEnded = true;
    composing = false; provisionalInput = false; commit();
  }
  const onInput = (event: Event) => {
    if ((event as InputEvent).isComposing && !compositionEnded) { provisionalInput = true; return; }
    commit();
  };
  const onCompositionStart = () => { composing = true; compositionEnded = false; };
  const onCompositionEnd = () => { compositionEnded = true; settleComposition(); };
  const onBlur = () => { if (composing || provisionalInput) settleComposition(); };
  root.addEventListener('beforeinput', beforeinput);
  root.addEventListener('input', onInput);
  root.addEventListener('paste', paste);
  root.addEventListener('keydown', keydown);
  root.addEventListener('compositionstart', onCompositionStart);
  root.addEventListener('compositionend', onCompositionEnd);
  root.addEventListener('blur', onBlur, true);
  return { begin, finish, settleComposition, getAnalysis: () => analysis, dispose() {
    finish();
    root.removeEventListener('beforeinput', beforeinput); root.removeEventListener('input', onInput);
    root.removeEventListener('paste', paste); root.removeEventListener('keydown', keydown);
    root.removeEventListener('compositionstart', onCompositionStart); root.removeEventListener('compositionend', onCompositionEnd);
    root.removeEventListener('blur', onBlur, true);
  } };
}
