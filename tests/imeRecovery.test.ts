// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StageEditor } from '../src/app/stageEditor'
import { DocumentModel } from '../src/document'
import { createEngine } from '../src/editing'
import type { RenderedDeck } from '../src/marp/renderer'
import type { SlideSurface } from '../src/marp/surface'

function setup(source = '日本語') {
  const engine = createEngine(new Marp({ script: false }))
  const model = new DocumentModel(source)
  let analysis = engine.analyze(model.text)
  let deck = { slides: [analysis.html] } as RenderedDeck
  const host = document.createElement('div')
  document.body.append(host)
  const root = host.attachShadow({ mode: 'open' })
  let crossRuns = 0
  const editor = new StageEditor({ root, update: (next: RenderedDeck) => { root.innerHTML = next.slides[0] } } as unknown as SlideSurface, engine, {
    latest: () => ({ analysis, deck }), onBegin() {}, onEnd() {}, onNotice() {}, onHistory() {},
    onCrossRun(result, after, before) {
      crossRuns++; model.edit(result.edit, { before, after }); analysis = result.analysis; deck = { slides: [analysis.html] } as RenderedDeck
    },
    onCommit(result, cursors) {
      model.edit(result.edit, cursors)
      analysis = result.analysis
      deck = { slides: [analysis.html] } as RenderedDeck
    },
  })
  editor.render(deck, analysis, 0)
  const run = root.querySelector<HTMLElement>('[data-sm-run]')!
  run.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
  const send = (type: string, init: InputEventInit = {}) => run.dispatchEvent(new InputEvent(type, { bubbles: true, composed: true, cancelable: true, ...init }))
  const start = () => run.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, composed: true }))
  const end = () => run.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, composed: true }))
  const key = (key: string, init: KeyboardEventInit = {}) => run.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, composed: true, key, ...init }))
  function select(offset: number) {
    document.getSelection()!.setBaseAndExtent(run.firstChild!, offset, run.firstChild!, offset)
  }
  return { editor, model, run, send, start, end, key, select, crossRuns: () => crossRuns }
}

const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0))

afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges() })

describe('compositionend save settlement task', () => {
  it.each([false, true])('retains final input after a microtask checkpoint (isComposing: %s)', async isComposing => {
    const s = setup()
    try {
      s.start(); s.run.textContent = '日本語途中'; s.send('input', { isComposing: true })
      const save = vi.fn(() => { s.editor.endEditing(); return s.model.serialize() })
      expect(s.editor.deferWhileComposing(save)).toBe(true)
      s.end(); await Promise.resolve()
      expect(save).not.toHaveBeenCalled()
      expect(s.run.isConnected).toBe(true)
      s.run.textContent = '日本語確定'
      s.send('input', { inputType: 'insertFromComposition', isComposing })
      await nextTask()
      expect(save).toHaveReturnedWith('日本語確定')
      expect(save).toHaveBeenCalledTimes(1)
      expect(s.editor.isComposing()).toBe(false)
    } finally { s.editor.dispose() }
  })

  it.each(['s', 'blur'])('%s while settling cannot release a save before final input', async action => {
    const s = setup()
    try {
      s.start(); s.run.textContent = '日本語途中'; s.send('input', { isComposing: true })
      const save = vi.fn(() => { s.editor.endEditing(); return s.model.serialize() })
      s.editor.deferWhileComposing(save)
      s.end(); await Promise.resolve()
      if (action === 'blur') s.run.closest('[data-sm-block]')!.dispatchEvent(new FocusEvent('blur', { composed: true }))
      else s.key('s', { ctrlKey: true })
      expect(save).not.toHaveBeenCalled()
      expect(s.editor.isComposing()).toBe(true)
      s.run.textContent = '日本語確定'; s.send('input', { inputType: 'insertFromComposition' })
      await nextTask()
      expect(save).toHaveReturnedWith('日本語確定')
      expect(save).toHaveBeenCalledTimes(1)
    } finally { s.editor.dispose() }
  })

  it('settles retained DOM and releases a save without a final input event', async () => {
    const s = setup()
    try {
      s.start(); s.run.textContent = '日本語途中'; s.send('input', { isComposing: true })
      const save = vi.fn(() => s.model.serialize())
      s.editor.deferWhileComposing(save)
      s.end(); await Promise.resolve()
      expect(save).not.toHaveBeenCalled()
      // No input event: the task must still inspect the retained DOM.
      s.run.textContent = '日本語確定'
      await nextTask()
      expect(save).toHaveReturnedWith('日本語確定')
      expect(save).toHaveBeenCalledTimes(1)
      expect(s.editor.isComposing()).toBe(false)
    } finally { s.editor.dispose() }
  })

  it('a new composition cancels the old timer and carries save waiters forward', async () => {
    const s = setup()
    vi.useFakeTimers()
    try {
      s.start(); s.run.textContent = '日本語途中'; s.send('input', { isComposing: true })
      const save = vi.fn(() => s.model.serialize())
      s.editor.deferWhileComposing(save)
      s.end()
      expect(vi.getTimerCount()).toBe(1)
      s.start()
      expect(vi.getTimerCount()).toBe(0)
      await vi.runAllTimersAsync()
      expect(save).not.toHaveBeenCalled()
      expect(s.editor.isComposing()).toBe(true)
      s.run.textContent = '日本語再開'; s.send('input', { isComposing: true }); s.end()
      await vi.runAllTimersAsync()
      expect(save).toHaveReturnedWith('日本語再開')
      expect(save).toHaveBeenCalledTimes(1)
    } finally { s.editor.dispose(); vi.useRealTimers() }
  })

  it('dispose cancels the completion timer without running deferred saves', async () => {
    const s = setup()
    vi.useFakeTimers()
    try {
      s.start()
      const save = vi.fn()
      s.editor.deferWhileComposing(save)
      s.end()
      expect(vi.getTimerCount()).toBe(1)
      s.editor.dispose()
      expect(vi.getTimerCount()).toBe(0)
      await vi.runAllTimersAsync()
      expect(save).not.toHaveBeenCalled()
    } finally { s.editor.dispose(); vi.useRealTimers() }
  })
})

describe('WebView2 composition recovery', () => {
  it.each(['beforeinput', 'input'])('an ordinary Enter after a provisional %s without compositionstart only confirms text, including a replay', input => {
    const s = setup('AB')
    try {
      s.select(1)
      if (input === 'beforeinput') s.send('beforeinput', { isComposing: true, inputType: 'insertCompositionText' })
      s.run.textContent = 'A日本語B'; s.select(4)
      if (input === 'input') s.send('input', { isComposing: true, inputType: 'insertCompositionText' })
      s.key('Enter'); s.key('Enter'); s.send('beforeinput', { inputType: 'insertParagraph' })
      expect(s.model.text).toBe('A日本語B'); expect(s.crossRuns()).toBe(0)
    } finally { s.editor.dispose() }
  })

  it('a replayed Enter after ordinary-Enter recovery from a missing compositionend only confirms', () => {
    const s = setup('AB')
    try {
      s.start(); s.run.textContent = 'A日本語B'; s.send('input', { isComposing: true }); s.select(4)
      s.key('Enter'); s.key('Enter'); s.send('beforeinput', { inputType: 'insertParagraph' })
      expect(s.model.text).toBe('A日本語B'); expect(s.crossRuns()).toBe(0)
    } finally { s.editor.dispose() }
  })

  it.each(['Backspace', 'blur', 'finish', 'input', 'beforeinput'])('the %s fallback completion also suppresses a replayed confirmation Enter', action => {
    const s = setup('AB')
    try {
      s.select(1); s.run.textContent = 'A日本語B'; s.send('input', { isComposing: true }); s.select(4)
      if (action === 'blur') s.run.closest('[data-sm-block]')!.dispatchEvent(new FocusEvent('blur', { composed: true }))
      else if (action === 'finish') s.editor.endEditing()
      else if (action === 'input') s.send('input', { isComposing: false, inputType: 'insertFromComposition' })
      else if (action === 'beforeinput') s.send('beforeinput', { inputType: 'insertParagraph' })
      else s.key(action)
      s.key('Enter')
      expect(s.model.text).toBe('A日本語B'); expect(s.crossRuns()).toBe(0)
    } finally { s.editor.dispose() }
  })

  it.each(['input', 'beforeinput'])('late composing %s after compositionend cannot block deletion or saving', async late => {
    const s = setup()
    try {
      s.start(); s.run.textContent = '日本語入力'
      s.send('input', { isComposing: true, inputType: 'insertCompositionText' }); s.end()
      s.send(late, { isComposing: true, inputType: 'insertCompositionText' })
      await nextTask()
      expect(s.editor.isComposing()).toBe(false)
      for (const [key, inputType, text] of [['Backspace', 'deleteContentBackward', '日本語入'], ['Delete', 'deleteContentForward', '日本語']] as const) {
        s.select(3); s.key(key)
        s.send('beforeinput', { inputType }); s.run.textContent = text; s.send('input', { inputType })
        expect(s.model.text).toBe(text)
      }
      s.key('s', { ctrlKey: true })
      let saved = ''
      const save = () => { saved = s.model.serialize(); s.model.markSaved('saved') }
      if (!s.editor.deferWhileComposing(save)) save()
      expect(saved).toBe('日本語'); expect(s.model.state).toBe('clean')
    } finally { s.editor.dispose() }
  })

  it.each(['Backspace', 'Delete', 's', 'blur', 'finish', 'click'])('missing compositionend recovers at %s and saves the provisional text before releasing waiters', action => {
    const s = setup()
    try {
      s.start(); s.run.textContent = '日本語確定'
      s.send('input', { isComposing: true, inputType: 'insertCompositionText' })
      let saved = ''
      expect(s.editor.deferWhileComposing(() => { saved = s.model.serialize() })).toBe(true)
      if (action === 'blur') s.run.closest('[data-sm-block]')!.dispatchEvent(new FocusEvent('blur', { composed: true }))
      else if (action === 'finish') s.editor.endEditing()
      else if (action === 'click') s.run.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
      else s.key(action, { ctrlKey: action === 's' })
      expect(s.editor.isComposing()).toBe(false)
      expect(saved).toBe('日本語確定'); expect(s.model.text).toBe('日本語確定')
    } finally { s.editor.dispose() }
  })

  it.each([{ isComposing: true }, { keyCode: 229 }])('IME confirmation Enter stays pending: %j', async init => {
    const s = setup()
    try {
      s.start(); s.run.textContent = '日本語確定'; s.send('input', { isComposing: true })
      s.key('Enter', init)
      expect(s.editor.isComposing()).toBe(true); expect(s.model.text).toBe('日本語')
      s.end(); await nextTask(); expect(s.model.text).toBe('日本語確定'); expect(s.editor.isComposing()).toBe(false)
    } finally { s.editor.dispose() }
  })

  it('compositionend followed immediately by compositionstart carries save waiters into the new composition', async () => {
    const s = setup()
    try {
      s.start(); s.run.textContent = '日本語確定'; s.send('input', { isComposing: true })
      let saved = ''
      s.editor.deferWhileComposing(() => { saved = s.model.serialize() })
      s.end(); s.start(); await nextTask()
      expect(s.editor.isComposing()).toBe(true); expect(saved).toBe('')
      s.run.textContent = '日本語再開'; s.send('input', { isComposing: true }); s.end(); await nextTask()
      expect(saved).toBe('日本語再開')
    } finally { s.editor.dispose() }
  })

  it('a replayed ordinary Enter immediately after confirmation does not insert a paragraph', async () => {
    const s = setup()
    try {
      s.start(); s.select(1); s.run.textContent = '日本語確定'; s.send('input', { isComposing: true })
      s.end(); await nextTask(); s.select(1)
      s.key('ArrowRight'); s.key('Enter'); s.send('beforeinput', { inputType: 'insertParagraph' })
      expect(s.crossRuns()).toBe(0); expect(s.model.text).toBe('日本語確定')
    } finally { s.editor.dispose() }
  })

  it('ordinary Enter with a missing compositionend settles the text without creating a paragraph', () => {
    const s = setup()
    try {
      s.start(); s.select(1); s.run.textContent = '日本語確定'; s.send('input', { isComposing: true }); s.select(1)
      s.key('Enter')
      expect(s.editor.isComposing()).toBe(false); expect(s.model.text).toBe('日本語確定'); expect(s.crossRuns()).toBe(0)
    } finally { s.editor.dispose() }
  })

  it('save waiters see a late final input before the completion microtask', async () => {
    const s = setup()
    try {
      s.start(); s.run.textContent = '日本語途中'; s.send('input', { isComposing: true })
      const saved = new Promise<string>(resolve => s.editor.deferWhileComposing(() => resolve(s.model.serialize())))
      s.end(); s.run.textContent = '日本語確定'; s.send('input', { isComposing: true, inputType: 'insertFromComposition' })
      expect(await saved).toBe('日本語確定'); expect(s.editor.isComposing()).toBe(false)
    } finally { s.editor.dispose() }
  })

  it('allows a deliberate Enter after the bounded replay window expires', async () => {
    const s = setup()
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    try {
      s.start(); s.end(); await nextTask(); s.select(1)
      now.mockReturnValue(1101); s.key('Enter')
      expect(s.crossRuns()).toBe(1)
    } finally { now.mockRestore(); s.editor.dispose() }
  })
})
