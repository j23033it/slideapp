// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { afterEach, describe, expect, it } from 'vitest'
import { StageEditor } from '../src/app/stageEditor'
import { DocumentModel } from '../src/document'
import { createEngine } from '../src/editing'
import { splitRenderedSlides, type RenderedDeck } from '../src/marp/renderer'
import type { SlideSurface } from '../src/marp/surface'

function fixture() {
  const model = new DocumentModel('hello'), engine = createEngine(new Marp({ script: false }))
  let analysis = engine.analyze(model.text)
  const deckOf = () => ({ slides: splitRenderedSlides(analysis.html).slides }) as RenderedDeck
  let deck = deckOf(), seq = 0
  const host = document.createElement('div'); document.body.append(host)
  const root = host.attachShadow({ mode: 'open' }), notices: string[] = []
  const editor = new StageEditor({ root, update(next: RenderedDeck) { root.innerHTML = next.slides[0] } } as unknown as SlideSurface, engine, {
    latest: () => ({ analysis, deck }), onBegin() {}, onEnd() {}, canBold: () => true,
    onNotice(code) { notices.push(code) },
    onCommit(result, cursors) { model.edit(result.edit, cursors); analysis = result.analysis; deck = deckOf() },
    onCrossRun(result, cursor, before, selectionEnd) {
      if (result.separateHistory) model.breakHistoryGroup()
      model.edit(result.edit, { before, after: cursor })
      if (result.separateHistory) model.breakHistoryGroup()
      analysis = result.analysis; deck = deckOf()
      editor.render(deck, analysis, 0, { seq: ++seq, cursor, selectionEnd })
    },
    onElementBold(result) { model.edit(result.edit); analysis = result.analysis; deck = deckOf(); editor.render(deck, analysis, 0) },
    onHistory(direction) { model[direction]() },
  })
  editor.render(deck, analysis, 0)
  const run = () => root.querySelector<HTMLElement>('[data-sm-run]')!
  const key = (target: HTMLElement, key: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...extra })
    target.dispatchEvent(event); return event
  }
  const begin = () => {
    const element = run()
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    return run()
  }
  const select = (element: HTMLElement, start: number, end: number) =>
    document.getSelection()!.setBaseAndExtent(element.firstChild!, start, element.firstChild!, end)
  return { model, root, editor, notices, run, key, begin, select }
}

afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges() })

describe('StageEditor bold with retained DOM input', () => {
  it.each(['keyboard', 'button'] as const)('commits before formatting and undoes each action separately (%s)', action => {
    const f = fixture()
    try {
      const run = f.begin()
      run.firstChild!.textContent = 'hXello'
      f.select(run, 0, 5)
      if (action === 'keyboard') expect(f.key(run, 'b', { ctrlKey: true }).defaultPrevented).toBe(true)
      else f.editor.toggleBold() // The toolbar prevents mousedown from moving focus.
      expect(f.model.text).toBe('**hXell**o')
      expect(document.getSelection()?.toString()).toBe('hXell')
      expect(f.notices).toEqual([])
      f.model.undo(); expect(f.model.text).toBe('hXello')
      f.model.undo(); expect(f.model.text).toBe('hello')
    } finally { f.editor.dispose() }
  })

  it('stops formatting and reports a rejected pending edit', () => {
    const f = fixture()
    try {
      const run = f.begin()
      run.firstChild!.textContent = 'h\nello'
      f.select(run, 0, 5)
      f.key(run, 'b', { ctrlKey: true })
      expect(f.model.text).toBe('hello')
      expect(f.notices).toEqual(['newline'])
      expect(f.run().textContent).toBe('hello')
    } finally { f.editor.dispose() }
  })

  it.each(['keyboard', 'button'] as const)('formats the selected element after its retained text is committed (%s)', action => {
    const f = fixture()
    try {
      const run = f.begin()
      run.firstChild!.textContent = 'hXello'
      f.select(run, 2, 2)
      f.key(run, 'Escape')
      const selected = f.root.querySelector<HTMLElement>('[data-sm-selected]')!
      expect(selected).toBeTruthy()
      expect(f.model.text).toBe('hXello')
      if (action === 'keyboard') f.key(selected, 'b', { ctrlKey: true })
      else f.editor.toggleBold()
      expect(f.model.text).toBe('**hXello**')
      expect(f.root.querySelector('[data-sm-selected]')).toBeTruthy()
      expect(f.notices).toEqual([])
      f.model.undo(); expect(f.model.text).toBe('hXello')
      f.model.undo(); expect(f.model.text).toBe('hello')
    } finally { f.editor.dispose() }
  })

  it.each(['composition', 'flag', 'keyCode', 'provisional'] as const)('ignores Ctrl+B during IME (%s)', mode => {
    const f = fixture()
    try {
      const run = f.begin()
      f.select(run, 0, 5)
      if (mode === 'composition') run.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      if (mode === 'provisional') run.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
      f.key(run, 'b', { ctrlKey: true, isComposing: mode === 'flag', keyCode: mode === 'keyCode' ? 229 : 0 })
      expect(f.model.text).toBe('hello')
      expect(f.notices).toEqual([])
    } finally { f.editor.dispose() }
  })
})
