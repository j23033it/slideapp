// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StageEditor } from '../src/app/stageEditor'
import { DocumentModel } from '../src/document'
import { createEngine, resolveCursor } from '../src/editing'
import { splitRenderedSlides } from '../src/marp/renderer'
import type { RenderedDeck } from '../src/marp/renderer'
import type { SlideSurface } from '../src/marp/surface'

function setup(source: string) {
  const model = new DocumentModel(source)
  const engine = createEngine(new Marp({ script: false }))
  let analysis = engine.analyze(model.text)
  const deckOf = (a: typeof analysis) => ({ slides: splitRenderedSlides(a.html).slides }) as unknown as RenderedDeck
  let deck = deckOf(analysis)
  const host = document.createElement('div'); document.body.append(host)
  const root = host.attachShadow({ mode: 'open' })
  let seq = 0
  const notices: string[] = []
  const editor = new StageEditor({ root, update(next: RenderedDeck, current: number) { root.innerHTML = next.slides[current] ?? '' } } as unknown as SlideSurface, engine, {
    latest: () => ({ analysis, deck }), onBegin() {}, onEnd() {}, onNotice(code) { notices.push(code) },
    onCommit(result, cursors) {
      model.edit(result.edit, cursors); analysis = result.analysis; deck = deckOf(analysis)
    },
    onCrossRun(result, cursor, before) {
      model.edit(result.edit, { before, after: cursor }); analysis = result.analysis; deck = deckOf(analysis)
      editor.render(deck, analysis, 0, { seq: ++seq, cursor })
    },
    onHistory(direction) {
      const saved = direction === 'undo' ? model.undo() : model.redo()
      analysis = engine.analyze(model.text)
      editor.render(deckOf(analysis), analysis, 0, saved ? { seq: ++seq, cursor: resolveCursor(analysis, saved)! } : undefined)
    },
  })
  editor.render(deck, analysis, 0)
  const runs = () => [...root.querySelectorAll<HTMLElement>('[data-sm-run]')]
  const run = (text: string) => runs().find(node => node.textContent === text)!
  function click(text: string) {
    const target = run(text)
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    const fresh = run(text)
    const node = fresh.firstChild ?? fresh
    const offset = fresh.firstChild ? text.length : 0
    document.getSelection()!.setBaseAndExtent(node, offset, node, offset)
    return fresh
  }
  function key(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
    return target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, cancelable: true, key, ...init }))
  }
  function enter(text: string, shiftKey = false) { key(click(text), 'Enter', { shiftKey }); return run('') }
  function type(target: HTMLElement, value: string, composing = false) {
    const before = new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: composing ? 'insertCompositionText' : 'insertText', isComposing: composing })
    target.dispatchEvent(before)
    expect(before.defaultPrevented).toBe(false)
    target.textContent = value
    const node = target.firstChild ?? target
    document.getSelection()!.setBaseAndExtent(node, value.length, node, value.length)
    target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: composing ? 'insertCompositionText' : 'insertText', isComposing: composing }))
  }
  return { model, engine, editor, root, startsWith: () => analysis, run, runs, click, key, enter, type, notices }
}

afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges(); vi.restoreAllMocks() })

describe('paragraph-end Enter keeps a usable empty line', () => {
  it('places the caret inside a text node of the empty run', () => {
    const s = setup('# before\n\nA')
    try {
      const empty = s.enter('A')
      expect(s.model.text).toBe('# before\n\nA\n\n')
      expect(document.getSelection()?.anchorNode).not.toBe(empty)
      expect(document.getSelection()?.anchorNode?.nodeType).toBe(3)
      expect(empty.contains(document.getSelection()?.anchorNode ?? null)).toBe(true)
    } finally { s.editor.dispose() }
  })

  it('does not roll back the draft when WebView2 reports the caret on the new block', () => {
    const s = setup('# before\n\nA')
    try {
      const empty = s.enter('A')
      const block = empty.closest('[data-sm-block]')!
      // WebView2 can normalise a caret in an empty inline-block run to the block boundary.
      document.getSelection()!.setBaseAndExtent(block, 0, block, 0)
      document.dispatchEvent(new Event('selectionchange'))
      expect(s.model.text).toBe('# before\n\nA\n\n')
      expect(empty.contains(document.getSelection()!.anchorNode)).toBe(true)
      // Input must work immediately, without manually moving the caret back.
      s.type(empty, '次')
      expect(s.model.text).toBe('# before\n\nA\n\n次')
      expect(s.notices).toEqual([])
    } finally { s.editor.dispose() }
  })

  it('keeps the draft when focus moves inside the edited surface', () => {
    const s = setup('# before\n\nA')
    try {
      const empty = s.enter('A')
      const block = empty.closest('[data-sm-block]')!
      block.dispatchEvent(new FocusEvent('blur', { bubbles: true, composed: true, relatedTarget: block }))
      expect(s.model.text).toBe('# before\n\nA\n\n')
    } finally { s.editor.dispose() }
  })

  it('cancels the draft when focus moves to a different block in the same surface', () => {
    const s = setup('# before\n\nA')
    try {
      const empty = s.enter('A')
      empty.closest('[data-sm-block]')!.dispatchEvent(new FocusEvent('blur', { bubbles: true, composed: true, relatedTarget: s.run('A').closest('[data-sm-block]') }))
      expect(s.model.text).toBe('# before\n\nA')
    } finally { s.editor.dispose() }
  })

  it('does not treat a boundary of the entire slide as the empty run', () => {
    const s = setup('# before\n\nA')
    try {
      const empty = s.enter('A')
      const block = empty.closest('[data-sm-block]')!
      const parent = block.parentNode!
      const index = [...parent.childNodes].indexOf(block)
      document.getSelection()!.setBaseAndExtent(parent, index, parent, index)
      document.dispatchEvent(new Event('selectionchange'))
      expect(s.model.text).toBe('# before\n\nA')
    } finally { s.editor.dispose() }
  })

  it('cancels the draft with Backspace at the start of the empty line, restoring the caret', () => {
    const s = setup('# before\n\nAB')
    try {
      const empty = s.enter('AB')
      expect(s.model.text).toBe('# before\n\nAB\n\n')
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, composed: true, cancelable: true })
      empty.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(s.notices).toEqual([])
      expect(s.model.text).toBe('# before\n\nAB')
      expect(document.getSelection()?.anchorNode?.textContent).toBe('AB')
      expect(document.getSelection()?.anchorOffset).toBe(2)
      // A second Backspace deletes the preceding character.
      s.type(s.run('AB'), 'A')
      expect(s.model.text).toBe('# before\n\nA')
    } finally { s.editor.dispose() }
  })

  it('cancels an unfilled softbreak line with Backspace as well', () => {
    const s = setup('# before\n\nA')
    try {
      const empty = s.enter('A', true)
      expect(s.model.text).toBe('# before\n\nA\n')
      s.key(empty, 'Backspace')
      expect(s.model.text).toBe('# before\n\nA')
      expect(s.notices).toEqual([])
    } finally { s.editor.dispose() }
  })
})

describe('paragraph newline regressions', () => {
  it('still splits a paragraph in the middle', () => {
    const s = setup('# before\n\nABCD')
    try {
      const target = s.click('ABCD')
      document.getSelection()!.setBaseAndExtent(target.firstChild!, 2, target.firstChild!, 2)
      s.key(target, 'Enter')
      expect(s.model.text).toBe('# before\n\nAB\n\nCD')
      expect(document.getSelection()?.anchorNode?.textContent).toBe('CD')
    } finally { s.editor.dispose() }
  })

  it('leaves a 229 Backspace to the IME before compositionstart arrives', () => {
    const s = setup('A')
    try {
      const empty = s.enter('A')
      const event = new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 229, bubbles: true, composed: true, cancelable: true })
      empty.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(s.model.text).toBe('A\n\n')
      expect(s.notices).toEqual([])
    } finally { s.editor.dispose() }
  })

  it('still drops an IME confirmation Enter while the composition is pending', async () => {
    const s = setup('# before\n\nA')
    try {
      s.click('A')
      const run = s.run('A')
      run.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true }))
      s.type(run, 'あ', true)
      s.key(run, 'Enter', { keyCode: 229 })
      expect(s.model.text).toBe('# before\n\nA')
      run.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true }))
      await Promise.resolve()
      expect(s.model.text).toBe('# before\n\nあ')
      expect(s.editor.isComposing()).toBe(false)
    } finally { s.editor.dispose() }
  })
})

describe('IME confirmation that shortens composition text', () => {
  it.each(['immediate', 'after-final-input'])('confirms %s and then deletes with Backspace', mode => {
    const s = setup('サンプル。です')
    try {
      const target = s.click('サンプル。です')
      const text = target.firstChild as Text
      document.getSelection()!.setBaseAndExtent(text, 7, text, 7)
      text.textContent = 'サンプル。'
      document.getSelection()!.setBaseAndExtent(text, 5, text, 5)
      target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }))
      expect(s.model.text).toBe('サンプル。')

      target.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true }))
      text.textContent = 'サンプル。てん'
      document.getSelection()!.setBaseAndExtent(text, 7, text, 7)
      target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, isComposing: true, inputType: 'insertCompositionText' }))
      if (mode === 'immediate') {
        text.textContent = 'サンプル。・'
        document.getSelection()!.setBaseAndExtent(text, 6, text, 6)
      }
      target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true, data: '・' }))
      if (mode === 'after-final-input') {
        text.textContent = 'サンプル。・'
        document.getSelection()!.setBaseAndExtent(text, 6, text, 6)
      }
      target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromComposition' }))
      expect(s.model.text).toBe('サンプル。・')

      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, composed: true, cancelable: true }))
      const deletion = new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'deleteContentBackward' })
      target.dispatchEvent(deletion)
      expect(deletion.defaultPrevented).toBe(false)
      text.textContent = 'サンプル。'
      document.getSelection()!.setBaseAndExtent(text, 5, text, 5)
      target.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }))
      expect(s.model.text).toBe('サンプル。')
      expect(s.notices).toEqual([])
    } finally { s.editor.dispose() }
  })
})
