// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { describe, expect, it } from 'vitest'

import { createEngine } from '../src/editing'
import type { Analysis } from '../src/editing'
import type { RenderedDeck } from '../src/marp/renderer'
import type { SlideSurface } from '../src/marp/surface'
import { StageEditor } from '../src/app/stageEditor'

describe('StageEditor IME composition', () => {
  it('compositionendのcommitが終わるまで終了操作を保留する', async () => {
    const engine = createEngine(new Marp({ script: false, math: 'mathjax' }))
    let analysis: Analysis = engine.analyze('First')
    let deck = { slides: [analysis.html] } as unknown as RenderedDeck
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const surface = {
      root,
      update(nextDeck: RenderedDeck, current: number) {
        root.innerHTML = nextDeck.slides[current] ?? ''
      },
    } as unknown as SlideSurface
    const order: string[] = []
    const editor = new StageEditor(surface, engine, {
      latest: () => ({ analysis, deck }),
      onBegin: () => {},
      onEnd: () => order.push('end'),
      onNotice: () => {},
      onCommit: (result) => {
        analysis = result.analysis
        deck = { slides: [analysis.html] } as unknown as RenderedDeck
        order.push('commit')
      },
      onCrossRun: () => {},
      onHistory: () => {},
    })

    try {
      editor.render(deck, analysis, 0)
      const run = root.querySelector<HTMLElement>('[data-sm-run]')
      expect(run).not.toBeNull()
      run!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, button: 0 }))
      run!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true }))
      expect(editor.isComposing()).toBe(true)

      editor.deferWhileComposing(() => {
        order.push('deferred')
        editor.endEditing()
      })
      editor.endEditing()
      expect(order).toEqual([])

      run!.textContent = 'Second'
      run!.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, isComposing: true }))
      run!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true }))
      await Promise.resolve()

      expect(order).toEqual(['commit', 'deferred', 'end'])
      expect(analysis.text).toBe('Second')
    } finally {
      editor.dispose()
    }
  })
})
