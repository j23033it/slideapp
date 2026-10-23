// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { afterEach, describe, expect, it } from 'vitest'
import { StageEditor } from '../src/app/stageEditor'
import { DocumentModel } from '../src/document'
import { createEngine } from '../src/editing'
import type { RenderedDeck } from '../src/marp/renderer'
import type { SlideSurface } from '../src/marp/surface'

afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges() })

describe('StageEditor newline input', () => {
  it.each([
    ['keydown', false, '- ab\n- cd'], ['keydown', true, '- ab\n  cd'],
    ['beforeinput', false, '- ab\n- cd'], ['beforeinput', true, '- ab\n  cd'],
  ] as const)('%s (shift %s) rerenders and restores the new-line caret', (type, shift, expected) => {
    const model = new DocumentModel('- abcd')
    const engine = createEngine(new Marp({ script: false }))
    let analysis = engine.analyze(model.text)
    let deck = { slides: [analysis.html] } as RenderedDeck
    const host = document.createElement('div'); document.body.append(host)
    const root = host.attachShadow({ mode: 'open' })
    let focusSeq = 0
    const editor = new StageEditor({ root, update(next: RenderedDeck) { root.innerHTML = next.slides[0] } } as unknown as SlideSurface, engine, {
      latest: () => ({ analysis, deck }), onBegin() {}, onEnd() {}, onHistory() {},
      onNotice(code) { throw new Error(code) },
      onCommit(result, cursors) { model.edit(result.edit, cursors); analysis = result.analysis; deck = { slides: [analysis.html] } as RenderedDeck },
      onCrossRun(result, cursor, before) {
        model.edit(result.edit, { before, after: cursor })
        analysis = result.analysis; deck = { slides: [analysis.html] } as RenderedDeck
        editor.render(deck, analysis, 0, { seq: ++focusSeq, cursor })
      },
    })
    try {
      editor.render(deck, analysis, 0)
      const run = root.querySelector<HTMLElement>('[data-sm-run]')!
      run.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
      document.getSelection()!.setBaseAndExtent(run.firstChild!, 2, run.firstChild!, 2)
      const event = type === 'keydown'
        ? new KeyboardEvent(type, { key: 'Enter', shiftKey: shift, bubbles: true, composed: true, cancelable: true })
        : new InputEvent(type, { inputType: shift ? 'insertLineBreak' : 'insertParagraph', bubbles: true, composed: true, cancelable: true })
      run.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true); expect(model.text).toBe(expected)
      expect(document.getSelection()?.anchorNode?.textContent).toBe('cd')
      expect(document.getSelection()?.anchorOffset).toBe(0)
      const before = model.undo()!
      expect(model.text).toBe('- abcd'); expect(before.offset).toBe(2)
    } finally { editor.dispose() }
  })
})
