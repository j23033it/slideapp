// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { afterEach, describe, expect, it } from 'vitest'
import { StageEditor } from '../src/app/stageEditor'
import { DocumentModel } from '../src/document'
import { createEngine, resolveCursor } from '../src/editing'
import type { RenderedDeck } from '../src/marp/renderer'
import type { SlideSurface } from '../src/marp/surface'

function setup(source: string, eol = '\n') {
  const model = new DocumentModel(source.split('\n').join(eol), { hasBom: true })
  const engine = createEngine(new Marp({ script: false }))
  let analysis = engine.analyze(model.text)
  let deck = { slides: [analysis.html] } as RenderedDeck
  const host = document.createElement('div'); document.body.append(host)
  const root = host.attachShadow({ mode: 'open' })
  let seq = 0
  const notices: string[] = []
  function render(cursor?: { runId: string; offset: number }) {
    deck = { slides: [analysis.html] } as RenderedDeck
    editor.render(deck, analysis, 0, cursor ? { seq: ++seq, cursor } : undefined)
  }
  const editor = new StageEditor({ root, update(next: RenderedDeck) { root.innerHTML = next.slides[0] } } as unknown as SlideSurface, engine, {
    latest: () => ({ analysis, deck }), onBegin() {}, onEnd() {}, onNotice(code) { notices.push(code) },
    onCommit(result, cursors) {
      model.edit(result.edit, cursors); analysis = result.analysis; deck = { slides: [analysis.html] } as RenderedDeck
    },
    onCrossRun(result, cursor, before) {
      model.edit(result.edit, { before, after: cursor }); analysis = result.analysis; render(cursor)
    },
    onHistory(direction) {
      const saved = direction === 'undo' ? model.undo() : model.redo()
      analysis = engine.analyze(model.text)
      render(saved && resolveCursor(analysis, saved))
    },
  })
  render()
  const run = (text: string) => [...root.querySelectorAll<HTMLElement>('[data-sm-run]')].find(node => node.textContent === text)!
  function click(text: string) {
    const target = run(text)
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    const fresh = run(text)
    document.getSelection()!.setBaseAndExtent(fresh.firstChild ?? fresh, fresh.firstChild ? text.length : 0, fresh.firstChild ?? fresh, fresh.firstChild ? text.length : 0)
    return fresh
  }
  function key(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, key, ...init }))
  }
  function enter(text: string, shiftKey = false) { key(click(text), 'Enter', { shiftKey }); return run('') }
  function type(target: HTMLElement, value: string, composing = false) {
    target.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: composing ? 'insertCompositionText' : 'insertText', isComposing: composing }))
    target.textContent = value
    document.getSelection()!.setBaseAndExtent(target.firstChild!, value.length, target.firstChild!, value.length)
    target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: composing ? 'insertCompositionText' : 'insertText', isComposing: composing }))
  }
  return { model, engine, editor, root, run, click, key, enter, type, notices }
}

afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges() })

describe.each(['\n', '\r\n'])('empty target events with %j', eol => {
  it.each([
    ['# before\n\n- A', false, '# before\n\n- A\n- 次', true],
    ['- parent\n  - A', false, '- parent\n  - A\n  - 次', true],
    ['# before\n\n7) A', false, '# before\n\n7) A\n8) 次', true],
    ['# before\n\nA', false, '# before\n\nA\n\n次', false],
    ['# before\n\nA', true, '# before\n\nA\n次', false],
    ['- parent\n  - A', true, '- parent\n  - A\n    次', false],
  ] as const)('%s (shift %s) permits continued typing and undo', (source, shift, expected, persistent) => {
    const s = setup(source, eol)
    try {
      const empty = s.enter('A', shift)
      expect(empty).toBeDefined(); expect(document.getSelection()?.anchorNode).toBe(empty)
      s.type(empty, '次')
      expect(s.notices).toEqual([]); expect(s.model.serialize()).toBe(expected.split('\n').join(eol))
      s.key(empty, 'z', { ctrlKey: true })
      if (persistent) s.key(s.run(''), 'z', { ctrlKey: true })
      expect(s.model.serialize()).toBe(source.split('\n').join(eol))
    } finally { s.editor.dispose() }
  })

  it.each(['Escape', 'click', 'blur', 'endEditing', 'undo'])('cancels an unfilled paragraph at %s without a history entry', action => {
    const source = '# before\n\nA\n\nOther'
    const s = setup(source, eol)
    try {
      const empty = s.enter('A')
      expect(s.model.text).toBe('# before\n\nA\n\n\n\nOther')
      if (action === 'click') s.click('Other')
      else if (action === 'blur') empty.closest('[data-sm-block]')!.dispatchEvent(new FocusEvent('blur', { composed: true }))
      else if (action === 'endEditing') s.editor.endEditing()
      else s.key(empty, action === 'undo' ? 'z' : action, { ctrlKey: action === 'undo' })
      expect(s.model.serialize()).toBe(source.split('\n').join(eol)); expect(s.model.canUndo).toBe(false)
      expect(s.notices).toEqual([])
      const target = s.click('Other'); s.type(target, 'Other!')
      expect(s.model.text.endsWith('Other!')).toBe(true)
    } finally { s.editor.dispose() }
  })

  it.each([false, true])('Escape keeps an empty list item, while an empty line is cancelled (shift %s)', shift => {
    const source = '# before\n\n- A'
    const s = setup(source, eol)
    try {
      const empty = s.enter('A', shift)
      s.key(empty, 'Escape')
      expect(s.model.serialize()).toBe((source + (shift ? '' : '\n- ')).split('\n').join(eol))
      expect(s.model.canUndo).toBe(!shift)
      expect(s.notices).toEqual([])
    } finally { s.editor.dispose() }
  })
})

it('commits Japanese composition into an empty paragraph before releasing save waiters, retaining DOM during composition', async () => {
  const s = setup('A')
  try {
    const empty = s.enter('A')
    empty.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true }))
    s.type(empty, '日本語', true)
    expect(s.model.text).toBe('A\n\n'); expect(s.root.contains(empty)).toBe(true)
    let saved = ''
    s.editor.deferWhileComposing(() => { s.editor.endEditing(); saved = s.model.serialize() })
    empty.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true }))
    await Promise.resolve()
    expect(s.editor.isComposing()).toBe(false); expect(saved).toBe('A\n\n日本語')
    expect(s.notices).toEqual([])
  } finally { s.editor.dispose() }
})
