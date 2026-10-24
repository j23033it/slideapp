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
  it.each(['ArrowUp', 'ArrowLeft', 'Home', 'End', 'Tab', 'selectionchange', 'beforeinput'])('leaving an empty line through %s cancels the draft and permits typing at the restored caret', movement => {
    const source = '# untouched\n\nA'
    const s = setup(source, eol)
    try {
      const empty = s.enter('A', true)
      if (movement !== 'selectionchange' && movement !== 'beforeinput') s.key(empty, movement)
      const original = s.run('A')
      document.getSelection()!.setBaseAndExtent(original.firstChild!, 1, original.firstChild!, 1)
      if (movement !== 'beforeinput') document.dispatchEvent(new Event('selectionchange'))
      // The event and its DOM mutation must target the fresh run after rollback.
      let target = s.run('A')
      if (movement === 'beforeinput') {
        const event = new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: 'B' })
        target.dispatchEvent(event)
        if (!event.defaultPrevented) {
          target = s.run('A'); target.textContent = 'AB'
          document.getSelection()!.setBaseAndExtent(target.firstChild!, 2, target.firstChild!, 2)
          target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: 'B' }))
        } else target = s.run('AB')
      } else {
        expect(document.getSelection()?.anchorNode).toBe(target.firstChild)
        expect(document.getSelection()?.anchorOffset).toBe(1)
        s.type(target, 'AB')
      }
      // Tab is now consumed with a hierarchy-change notice; the explicit
      // selection move above still cancels the unfilled draft as before.
      expect(s.notices).toEqual(movement === 'Tab' ? ['list-indent-target'] : [])
      expect(s.model.serialize()).toBe((source + 'B').split('\n').join(eol))
      expect(s.model.hasBom).toBe(true)
      s.key(target, 'z', { ctrlKey: true })
      expect(s.model.serialize()).toBe(source.split('\n').join(eol)); expect(s.model.canUndo).toBe(false)
    } finally { s.editor.dispose() }
  })

  it('restores a caret after the cancelled paragraph, retaining backward selection and surrounding bytes', () => {
    const source = '# untouched\n\nA\n\nXYZ'
    const s = setup(source, eol)
    try {
      s.enter('A')
      const other = s.run('XYZ')
      document.getSelection()!.setBaseAndExtent(other.firstChild!, 2, other.firstChild!, 1)
      document.dispatchEvent(new Event('selectionchange'))
      const fresh = s.run('XYZ')
      expect(document.getSelection()?.anchorNode).toBe(fresh.firstChild)
      expect(document.getSelection()?.anchorOffset).toBe(2); expect(document.getSelection()?.focusOffset).toBe(1)
      s.type(fresh, 'X!Z')
      expect(s.model.serialize()).toBe('# untouched\n\nA\n\nX!Z'.split('\n').join(eol))
      expect(s.notices).toEqual([])
    } finally { s.editor.dispose() }
  })

  it('preserves a cross-run selection after rollback and still rejects typing across it', () => {
    const s = setup('A\n\nOther', eol)
    try {
      s.enter('A')
      document.getSelection()!.setBaseAndExtent(s.run('Other').firstChild!, 2, s.run('A').firstChild!, 0)
      document.dispatchEvent(new Event('selectionchange'))
      const event = new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: 'X' })
      s.run('A').dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true); expect(s.notices).toEqual(['cross-run'])
      expect(s.model.serialize()).toBe('A\n\nOther'.split('\n').join(eol)); expect(s.model.canUndo).toBe(false)
    } finally { s.editor.dispose() }
  })

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
      // 空ラン自身の位置を使い、表示用の文字は作らない。
      expect(empty).toBeDefined()
      const anchor = document.getSelection()?.anchorNode
      expect(anchor).toBe(empty)
      expect(empty.contains(anchor ?? null)).toBe(true)
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
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(s.editor.isComposing()).toBe(false); expect(saved).toBe('A\n\n日本語')
    expect(s.notices).toEqual([])
  } finally { s.editor.dispose() }
})
