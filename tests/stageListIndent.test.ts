// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { afterEach, describe, expect, it } from 'vitest'
import { StageEditor } from '../src/app/stageEditor'
import { DocumentModel } from '../src/document'
import { createEngine, type ReadonlyCode } from '../src/editing'
import type { RenderedDeck } from '../src/marp/renderer'
import type { SlideSurface } from '../src/marp/surface'

afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges() })

function fixture(source = '- first\n- target') {
  const model = new DocumentModel(source), engine = createEngine(new Marp({ script: false }))
  let analysis = engine.analyze(model.text), deck = { slides: [analysis.html] } as RenderedDeck
  const host = document.createElement('div'); document.body.append(host)
  const root = host.attachShadow({ mode: 'open' }), notices: ReadonlyCode[] = []
  let seq = 0
  const editor = new StageEditor({ root, update(next: RenderedDeck) { root.innerHTML = next.slides[0] } } as unknown as SlideSurface, engine, {
    latest: () => ({ analysis, deck }), onBegin() {}, onEnd() {},
    onNotice(code) { notices.push(code) },
    onCommit(result, cursors) { model.edit(result.edit, cursors); analysis = result.analysis; deck = { slides: [analysis.html] } as RenderedDeck },
    onCrossRun(result, cursor, before) {
      model.edit(result.edit, { before, after: cursor })
      analysis = result.analysis; deck = { slides: [analysis.html] } as RenderedDeck
      editor.render(deck, analysis, 0, { seq: ++seq, cursor })
    },
    onHistory(direction) { model[direction]() },
  })
  editor.render(deck, analysis, 0)
  const run = (label = 'target') => [...root.querySelectorAll<HTMLElement>('[data-sm-run]')].find(run => run.textContent === label)!
  const begin = (label = 'target', start = 2, end = start) => {
    const element = run(label)
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    document.getSelection()!.setBaseAndExtent(element.firstChild!, start, element.firstChild!, end)
    return element
  }
  const tab = (element: HTMLElement, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, composed: true, cancelable: true, ...options })
    element.dispatchEvent(event)
    return event
  }
  return { model, root, editor, notices, run, begin, tab }
}

describe('StageEditor Tab hierarchy changes', () => {
  it.each([false, true])('moves an item with a caret/selection (%s), restores position and undoes once', selected => {
    const f = fixture()
    try {
      const event = f.tab(f.begin('target', 2, selected ? 5 : 2))
      expect(event.defaultPrevented).toBe(true)
      expect(f.model.text).toBe('- first\n  - target')
      expect(document.getSelection()?.anchorNode?.textContent).toBe('target')
      expect(document.getSelection()?.anchorOffset).toBe(2)
      expect(f.notices).toEqual([])
      f.model.undo(); expect(f.model.text).toBe('- first\n- target')
    } finally { f.editor.dispose() }
  })

  it('uses Shift+Tab to outdent and retains following siblings at the same depth', () => {
    const f = fixture('- first\n  - target\n  - later')
    try {
      expect(f.tab(f.begin(), { shiftKey: true }).defaultPrevented).toBe(true)
      expect(f.model.text).toBe('- first\n- target\n  - later')
      expect(f.notices).toEqual([])
    } finally { f.editor.dispose() }
  })

  it('commits retained DOM text before changing hierarchy', () => {
    const f = fixture()
    try {
      const element = f.begin()
      element.firstChild!.textContent = 'taXrget'
      document.getSelection()!.setBaseAndExtent(element.firstChild!, 3, element.firstChild!, 3)
      f.tab(element)
      expect(f.model.text).toBe('- first\n  - taXrget')
      expect(document.getSelection()?.anchorOffset).toBe(3)
      f.model.undo(); expect(f.model.text).toBe('- first\n- taXrget')
    } finally { f.editor.dispose() }
  })

  it.each([
    ['# target', false, 'list-indent-target'], ['target', false, 'list-indent-target'],
    ['- target', false, 'list-indent-first'], ['- target', true, 'list-indent-top'],
  ] as const)('prevents focus movement and reports rejection: %s', (source, shiftKey, code) => {
    const f = fixture(source)
    try {
      expect(f.tab(f.begin(), { shiftKey }).defaultPrevented).toBe(true)
      expect(f.model.text).toBe(source)
      expect(f.notices).toEqual([code])
    } finally { f.editor.dispose() }
  })

  it('accepts a selection across decorations within the same item', () => {
    const f = fixture('- first\n- **target** suffix')
    try {
      const element = f.begin('target')
      const end = f.run(' suffix')
      document.getSelection()!.setBaseAndExtent(element.firstChild!, 1, end.firstChild!, 3)
      f.tab(element)
      expect(f.model.text).toBe('- first\n  - **target** suffix')
      expect(f.notices).toEqual([])
    } finally { f.editor.dispose() }
  })

  it('rejects a selection crossing into another item', () => {
    const f = fixture()
    try {
      const element = f.begin('first')
      document.getSelection()!.setBaseAndExtent(element.firstChild!, 1, f.run().firstChild!, 3)
      f.tab(element)
      expect(f.model.text).toBe('- first\n- target')
      expect(f.notices).toEqual(['list-indent-target'])
    } finally { f.editor.dispose() }
  })

  it.each(['composition', 'flag', 'keyCode', 'provisional'])('does not change hierarchy during IME (%s)', mode => {
    const f = fixture()
    try {
      const element = f.begin()
      if (mode === 'composition') element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      if (mode === 'provisional') element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }))
      expect(f.tab(element, { isComposing: mode === 'flag', keyCode: mode === 'keyCode' ? 229 : 0 }).defaultPrevented).toBe(true)
      expect(f.model.text).toBe('- first\n- target')
      expect(f.notices).toEqual([])
    } finally { f.editor.dispose() }
  })

  it('keeps ordinary Tab navigation when no editor is active', () => {
    const f = fixture()
    try { expect(f.tab(f.run()).defaultPrevented).toBe(false) }
    finally { f.editor.dispose() }
  })
})
