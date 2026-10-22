// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { describe, expect, it } from 'vitest'

import { createEngine } from '../src/editing'
import type { Analysis } from '../src/editing'
import type { RenderedDeck } from '../src/marp/renderer'
import type { SlideSurface } from '../src/marp/surface'
import { StageEditor } from '../src/app/stageEditor'

interface CompositionListener {
  listener: EventListenerOrEventListenerObject
  capture: boolean
}

function recordCompositionEndListeners(root: ShadowRoot): CompositionListener[] {
  const listeners: CompositionListener[] = []
  const add = root.addEventListener.bind(root)
  root.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'compositionend') {
      listeners.push({
        listener,
        capture: typeof options === 'boolean' ? options : options?.capture ?? false,
      })
    }
    add(type, listener, options)
  }) as ShadowRoot['addEventListener']
  return listeners
}

async function dispatchNativeCompositionEnd(
  root: ShadowRoot,
  target: HTMLElement,
  listeners: CompositionListener[],
): Promise<void> {
  const event = new CompositionEvent('compositionend', { bubbles: true, composed: true })
  Object.defineProperty(event, 'target', { configurable: true, value: target })
  const invoke = (listener: CompositionListener): void => {
    if (typeof listener.listener === 'function') listener.listener.call(root, event)
    else listener.listener.handleEvent(event)
  }

  // WebView2 native dispatch can checkpoint microtasks between the capture and
  // bubble callbacks. Keep that order here instead of relying on synthetic dispatch.
  listeners.filter((entry) => entry.capture).forEach(invoke)
  await Promise.resolve()
  listeners.filter((entry) => !entry.capture).forEach(invoke)
}

describe('StageEditor IME composition', () => {
  it('compositionendのcommitが終わるまで終了操作を保留する', async () => {
    const engine = createEngine(new Marp({ script: false, math: 'mathjax' }))
    let analysis: Analysis = engine.analyze('First')
    let deck = { slides: [analysis.html] } as unknown as RenderedDeck
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const compositionEndListeners = recordCompositionEndListeners(root)
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
      await dispatchNativeCompositionEnd(root, run!, compositionEndListeners)
      run!.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertFromComposition' }))

      expect(order).toEqual(['commit', 'deferred', 'end'])
      expect(analysis.text).toBe('Second')
    } finally {
      editor.dispose()
    }
  })

  it('compositionendで編集コミットがない場合もbubble処理後に予約を解放する', async () => {
    const engine = createEngine(new Marp({ script: false, math: 'mathjax' }))
    const analysis = engine.analyze('First')
    const deck = { slides: [analysis.html] } as unknown as RenderedDeck
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const compositionEndListeners = recordCompositionEndListeners(root)
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
      onCommit: () => order.push('commit'),
      onCrossRun: () => {},
      onHistory: () => {},
    })

    try {
      editor.render(deck, analysis, 0)
      const run = root.querySelector<HTMLElement>('[data-sm-run]')
      expect(run).not.toBeNull()
      run!.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, button: 0 }))
      run!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true }))
      editor.deferWhileComposing(() => {
        order.push('deferred')
        editor.endEditing()
      })

      await dispatchNativeCompositionEnd(root, run!, compositionEndListeners)

      expect(order).toEqual(['deferred', 'end'])
    } finally {
      editor.dispose()
    }
  })
})
