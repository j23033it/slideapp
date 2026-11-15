// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { describe, expect, it } from 'vitest'
import { DocumentModel } from '../src/document'
import { createEngine } from '../src/editing'
import { StageEditor } from '../src/app/stageEditor'
import { splitRenderedSlides, type RenderedDeck } from '../src/marp/renderer'
import type { SlideSurface } from '../src/marp/surface'

describe('element selection', () => {
  it('selects the enclosing list on Escape, deletes it, and restores it with one undo', () => {
    const raw = '# Title\n\n- one\n- two\n\nend'
    const model = new DocumentModel(raw)
    const engine = createEngine(new Marp({ script: false }))
    let analysis = engine.analyze(model.text)
    const deckOf = () => ({ slides: splitRenderedSlides(analysis.html).slides }) as RenderedDeck
    let deck = deckOf()
    const root = document.createElement('div').attachShadow({ mode: 'open' })
    const editor = new StageEditor({ root, update(next: RenderedDeck) { root.innerHTML = next.slides[0] } } as unknown as SlideSurface, engine, {
      latest: () => ({ analysis, deck }), onBegin() {}, onEnd() {}, onNotice() {}, onHistory() {},
      onCommit(result, cursor) { model.edit(result.edit, cursor); analysis = result.analysis; deck = deckOf() },
      onCrossRun() {},
      onElementDelete(id) {
        const result = engine.applyElementOperation(model.text, { kind: 'delete', elementId: id }, model.eols)
        if (!result.ok) return false
        model.editTransaction([result.edit]); analysis = result.analysis; deck = deckOf(); return true
      },
    })
    try {
      editor.render(deck, analysis, 0)
      const run = [...root.querySelectorAll<HTMLElement>('[data-sm-run]')].find(el => el.textContent === 'one')!
      run.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, button: 0 }))
      document.getSelection()!.setBaseAndExtent(run.firstChild!, 1, run.firstChild!, 1)
      run.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true }))
      const selected = root.querySelector<HTMLElement>('[data-sm-selected]')!
      expect(selected.tagName.toLowerCase()).toBe('ul')
      selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, composed: true, cancelable: true }))
      expect(model.text).toBe('# Title\n\nend')
      model.undo(); expect(model.text).toBe(raw); expect(model.canUndo).toBe(false)
    } finally { editor.dispose() }
  })
})

