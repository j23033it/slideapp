// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../src/editing';
import { bindEditing, inputGuard, plainPaste, verifyRenderedRuns } from '../src/editing/dom';

function setup(source = 'left **bold** `code` right') {
  const engine = createEngine(new Marp({ script: false, inlineSVG: false }));
  const analysis = engine.analyze(source);
  const root = document.createElement('div');
  root.innerHTML = analysis.html; document.body.append(root);
  const onCommit = vi.fn(), onReject = vi.fn(), onHistory = vi.fn(), onFinish = vi.fn();
  const adapter = bindEditing(root, engine, { analysis, onCommit, onReject, onHistory, onFinish });
  const run = (text: string) => [...root.querySelectorAll<HTMLElement>('[data-sm-run]')].find(e => e.textContent === text)!;
  return { root, analysis, engine, adapter, run, onCommit, onReject, onHistory, onFinish };
}
function select(element: HTMLElement, start: number, end = start): void {
  const range = document.createRange();
  range.setStart(element.firstChild!, start); range.setEnd(element.firstChild!, end);
  const selection = document.getSelection()!;
  selection.removeAllRanges(); selection.addRange(range);
}
afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges(); });

describe('DOM editing boundary', () => {
  it('starts the current second block after the host rerenders on finish', () => {
    const { root, run, adapter, onFinish, onCommit } = setup('first\n\nsecond');
    onFinish.mockImplementation(() => { root.innerHTML = adapter.getAnalysis().html; });
    adapter.begin(run('first'));
    const staleSecond = run('second');
    expect(adapter.begin(staleSecond)).toBe(true);
    expect(root.contains(staleSecond)).toBe(false);
    const second = run('second');
    expect(root.querySelectorAll('[data-sm-block][contenteditable="true"]')).toHaveLength(1);
    expect(second.closest('[data-sm-block]')?.getAttribute('contenteditable')).toBe('true');
    select(second, 6);
    second.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' }));
    second.textContent = 'second!';
    second.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    expect(onCommit.mock.lastCall?.[0].newText).toBe('first\n\nsecond!');
    adapter.dispose();
  });
  it.each([true, false])('keeps composition pending when beforeinput switches from parent to child (compositionstart: %s)', startsComposition => {
    const { root, run, adapter, onCommit, onFinish, onReject } = setup('- parent\n  - child');
    const parent = run('parent'), child = run('child');
    adapter.begin(parent); select(parent, 6);
    child.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    select(child, 5);
    if (startsComposition) child.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertCompositionText', isComposing: true });
    child.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);
    child.textContent = 'childに';
    child.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', isComposing: true }));
    expect(onCommit).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
    expect(root.contains(child)).toBe(true);
    child.textContent = 'child日本語';
    child.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    child.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromComposition' }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.lastCall?.[0].newText).toBe('- parent\n  - child日本語');
    expect(onReject).not.toHaveBeenCalled();
    adapter.dispose();
  });
  it('honors isComposing on input even when compositionstart was not delivered', () => {
    const { run, adapter, onCommit } = setup('text');
    const target = run('text'); adapter.begin(target); select(target, 4);
    target.textContent = 'textに';
    target.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    expect(onCommit).not.toHaveBeenCalled();
    target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
  it('freezes HTML contents and rejects input inside their run', () => {
    const { run, adapter, onReject, onCommit } = setup('before <b>HTML</b> after');
    adapter.begin(run('before '));
    const html = run('HTML');
    expect(html.getAttribute('contenteditable')).toBe('false');
    expect(html.closest('b')?.getAttribute('contenteditable')).toBe('false');
    select(html, 2);
    const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText' });
    html.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    expect(adapter.begin(html)).toBe(false);
    expect(onReject.mock.lastCall?.[0].code).toBe('html');
    expect(onCommit).not.toHaveBeenCalled();
    adapter.dispose();
  });
  it.each(['empty', 'markup'])('restores selection and focus after rejecting %s input', change => {
    const { root, run, adapter, onReject, onCommit } = setup('before **bold** after');
    const target = run('bold'); adapter.begin(target);
    const block = target.closest<HTMLElement>('[data-sm-block]')!;
    const start = change === 'empty' ? 0 : 1, end = change === 'empty' ? 4 : 3;
    const inputType = change === 'empty' ? 'deleteByCut' : 'insertText';
    block.focus(); select(target, start, end);
    const snapshot = block.innerHTML;
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType }));
    if (change === 'empty') target.textContent = '';
    else target.innerHTML = '<i>changed</i>';
    // Match the browser moving selection out of the nodes replaced by innerHTML.
    document.getSelection()!.selectAllChildren(document.body);
    document.getSelection()!.collapseToStart();
    block.blur();
    expect(document.activeElement).not.toBe(block);
    target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
    const restored = run('bold');
    expect(root.contains(target)).toBe(false);
    expect(block.innerHTML).toBe(snapshot);
    expect(document.activeElement).toBe(block);
    expect(document.getSelection()!.anchorNode).toBe(restored.firstChild);
    expect(document.getSelection()!.anchorOffset).toBe(start);
    expect(document.getSelection()!.focusNode).toBe(restored.firstChild);
    expect(document.getSelection()!.focusOffset).toBe(end);
    expect(document.getSelection()!.toString()).toBe('bold'.slice(start, end));
    expect(onCommit).not.toHaveBeenCalled(); expect(onReject).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
  it('verifies rendered text and freezes read-only inline islands', () => {
    const { root, analysis, run, adapter } = setup();
    expect(adapter.begin(run('left '))).toBe(true);
    expect(root.querySelector('code')?.getAttribute('contenteditable')).toBe('false');
    const bold = run('bold');
    bold.textContent = 'different'; verifyRenderedRuns(root, analysis);
    expect(analysis.runs.find(r => r.text === 'bold')).toMatchObject({ editable: false, reason: { code: 'dom-mismatch' } });
    adapter.dispose();
  });
  it('accepts text input, retains the DOM element and permits the next edit', () => {
    const { root, run, adapter, onCommit, onReject } = setup();
    const target = run('bold'); adapter.begin(target); select(target, 4);
    const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: '!' });
    target.dispatchEvent(before); expect(before.defaultPrevented).toBe(false);
    target.textContent = 'bold!'; target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    expect(onReject).not.toHaveBeenCalled();
    expect(onCommit.mock.lastCall?.[0].newText).toBe('left **bold!** `code` right');
    expect(root.contains(target)).toBe(true);
    expect(adapter.getAnalysis().runs.find(r => r.text === 'bold!')?.id).toBe(target.dataset.smRun);
    target.textContent = 'bold!!'; target.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(2);
    adapter.dispose();
  });
  it('waits until IME composition ends', () => {
    const { run, adapter, onCommit } = setup('日本語');
    const target = run('日本語'); adapter.begin(target);
    target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    target.textContent = '日本語入力'; target.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    expect(onCommit).not.toHaveBeenCalled();
    target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.lastCall?.[0].newText).toBe('日本語入力');
    adapter.dispose();
  });
  it('blocks cross-run selections, Enter, formatting, native history and boundary deletion', () => {
    const { root, run, adapter, onReject } = setup();
    const left = run('left '), bold = run('bold'); adapter.begin(left); select(left, 1);
    for (const inputType of ['insertParagraph', 'insertLineBreak', 'formatBold', 'historyUndo', 'insertFromDrop']) {
      const event = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
      left.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    }
    const range = document.createRange(); range.setStart(left.firstChild!, 1); range.setEnd(bold.firstChild!, 2);
    document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range);
    expect(inputGuard({ inputType: 'insertText' }, document.getSelection(), root)?.code).toBe('cross-run');
    select(left, 0);
    expect(inputGuard({ inputType: 'deleteContentBackward' }, document.getSelection(), root)?.code).toBe('cross-run');
    expect(onReject).toHaveBeenCalledTimes(5);
    adapter.dispose();
  });
  it('pastes plain text with line breaks flattened', () => {
    const { run, adapter, onCommit } = setup('hello');
    const target = run('hello'); adapter.begin(target); select(target, 0, 5);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: (type: string) => type === 'text/plain' ? 'one\r\ntwo\nthree' : '<b>HTML</b>' } });
    target.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(onCommit.mock.lastCall?.[0].newText).toBe('one two three');
    expect(target.children.length).toBe(0);
    expect(plainPaste('a\rb\0')).toBe('a b');
    adapter.dispose();
  });
  it('restores the block on invalid input and unexpected browser markup', () => {
    const { root, run, adapter, onReject, onCommit } = setup();
    let target = run('bold'); adapter.begin(target);
    const snapshot = target.closest('[data-sm-block]')!.innerHTML;
    target.textContent = ''; target.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(onCommit).not.toHaveBeenCalled(); expect(onReject).toHaveBeenCalled();
    expect(root.querySelector('[data-sm-block]')!.innerHTML).toBe(snapshot);
    target = run('bold'); target.innerHTML = '<i>changed</i>';
    target.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(root.querySelector('[data-sm-block]')!.innerHTML).toBe(snapshot);
    target = run('bold'); root.querySelector('code')!.textContent = 'unexpected'; target.textContent = 'changed';
    target.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(root.querySelector('[data-sm-block]')!.innerHTML).toBe(snapshot);
    adapter.dispose();
  });
  it('routes history to the host and ends editing on Escape', () => {
    const { run, adapter, onHistory, onFinish } = setup();
    const target = run('bold'); adapter.begin(target);
    for (const [key, shiftKey] of [['z', false], ['y', false], ['z', true]] as const) {
      target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key, shiftKey }));
    }
    expect(onHistory.mock.calls).toEqual([['undo'], ['redo'], ['redo']]);
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    expect(target.closest('[data-sm-block]')!.hasAttribute('contenteditable')).toBe(false);
    expect(onFinish).toHaveBeenCalledTimes(1);
    adapter.dispose();
  });
});
