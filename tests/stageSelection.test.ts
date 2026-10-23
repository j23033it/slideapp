// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StageEditor } from '../src/app/stageEditor'
import { DocumentModel } from '../src/document'
import { createEngine } from '../src/editing'
import { splitRenderedSlides } from '../src/marp/renderer'
import type { RenderedDeck } from '../src/marp/renderer'
import type { SlideSurface } from '../src/marp/surface'
import { nativeShadowSelection } from './nativeShadowSelection'

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
  const events: string[] = []
  const editor = new StageEditor({ root, update(next: RenderedDeck, current: number) { root.innerHTML = next.slides[current] ?? '' } } as unknown as SlideSurface, engine, {
    latest: () => ({ analysis, deck }),
    onBegin(label) { events.push('begin:' + label) },
    onEnd() { events.push('end') },
    onNotice(code) { notices.push(code) },
    onCommit(result, cursors) { model.edit(result.edit, cursors); analysis = result.analysis; deck = deckOf(analysis) },
    onCrossRun(result, cursor, before) {
      model.edit(result.edit, { before, after: cursor }); analysis = result.analysis; deck = deckOf(analysis)
      editor.render(deck, analysis, 0, { seq: ++seq, cursor })
    },
    onHistory() {},
  })
  editor.render(deck, analysis, 0)
  const run = (text: string) => [...root.querySelectorAll<HTMLElement>('[data-sm-run]')].find(node => node.textContent === text)!
  function click(target: HTMLElement) {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, button: 0 }))
  }
  function caret(target: HTMLElement, offset: number) {
    const node = target.firstChild ?? target
    document.getSelection()!.setBaseAndExtent(node, offset, node, offset)
  }
  return { model, root, editor, run, click, caret, notices, events }
}

afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges(); vi.restoreAllMocks(); Reflect.deleteProperty(document, 'caretPositionFromPoint') })

describe('selection survives the click that ends a drag', () => {
  it.each([false, true])('preserves a native drag when document selection is collapsed (editing: %s)', editing => {
    const s = setup('alpha **beta**')
    try {
      const alpha = s.run('alpha '), beta = s.run('beta')
      if (editing) s.click(alpha)
      s.caret(alpha, 1)
      const scoped = nativeShadowSelection(s.root)
      alpha.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }))
      scoped.setBaseAndExtent(alpha.firstChild!, 1, beta.firstChild!, 3)
      document.dispatchEvent(new Event('selectionchange'))
      expect(document.getSelection()!.isCollapsed).toBe(true)
      expect(scoped.isCollapsed).toBe(false)
      const before = s.events.length
      s.click(beta)
      expect(scoped.anchorNode).toBe(alpha.firstChild)
      expect(scoped.anchorOffset).toBe(1)
      expect(scoped.focusNode).toBe(beta.firstChild)
      expect(scoped.focusOffset).toBe(3)
      expect(s.events).toHaveLength(before)
      expect(s.model.state).toBe('clean')
      const copy = new Event('copy', { bubbles: true, composed: true, cancelable: true })
      beta.dispatchEvent(copy)
      expect(copy.defaultPrevented).toBe(false)
    } finally { s.editor.dispose() }
  })
  it('keeps a multi-run selection inside one paragraph while editing', () => {
    const s = setup('alpha **beta** gamma')
    try {
      const alpha = s.run('alpha ')
      s.click(alpha)
      s.caret(s.run('alpha '), 2)
      const freshAlpha = s.run('alpha ')
      const beta = s.run('beta')
      document.getSelection()!.setBaseAndExtent(freshAlpha.firstChild!, 2, beta.firstChild!, 2)
      s.click(beta)
      const selection = document.getSelection()!
      expect(selection.isCollapsed).toBe(false)
      expect(selection.anchorNode?.textContent).toBe('alpha ')
      expect(selection.anchorOffset).toBe(2)
      expect(selection.focusNode?.textContent).toBe('beta')
      expect(selection.focusOffset).toBe(2)
      expect(s.model.text).toBe('alpha **beta** gamma')
      expect(s.notices).toEqual([])
    } finally { s.editor.dispose() }
  })

  it('keeps a selection that spans blocks from a non-editing state and starts no edit', () => {
    const s = setup('alpha\n\nbeta')
    try {
      const alpha = s.run('alpha')
      const before = s.events.length
      document.getSelection()!.setBaseAndExtent(alpha.firstChild!, 2, s.run('beta').firstChild!, 2)
      s.click(s.run('beta'))
      const selection = document.getSelection()!
      expect(selection.isCollapsed).toBe(false)
      expect(selection.anchorNode?.textContent).toBe('alpha')
      expect(selection.focusNode?.textContent).toBe('beta')
      expect(s.model.text).toBe('alpha\n\nbeta')
      expect(s.events.slice(before)).toEqual([])
      expect(s.notices).toEqual([])
    } finally { s.editor.dispose() }
  })

  it('keeps a selection that spans blocks while another block is being edited', () => {
    const s = setup('alpha\n\nbeta\ngamma')
    try {
      s.click(s.run('gamma'))
      s.caret(s.run('gamma'), 1)
      document.getSelection()!.setBaseAndExtent(s.run('alpha').firstChild!, 3, s.run('beta').firstChild!, 1)
      s.click(s.run('beta'))
      const selection = document.getSelection()!
      expect(selection.isCollapsed).toBe(false)
      expect(selection.anchorNode?.textContent).toBe('alpha')
      expect(selection.focusNode?.textContent).toBe('beta')
      expect(s.model.text).toBe('alpha\n\nbeta\ngamma')
      expect(s.notices).toEqual([])
    } finally { s.editor.dispose() }
  })

  it('keeps a partial selection inside one run while editing', () => {
    const s = setup('abcdef')
    try {
      const run = s.run('abcdef')
      s.click(run)
      document.getSelection()!.setBaseAndExtent(run.firstChild!, 1, run.firstChild!, 4)
      s.click(s.run('abcdef'))
      const selection = document.getSelection()!
      expect(selection.isCollapsed).toBe(false)
      expect(selection.anchorOffset).toBe(1)
      expect(selection.focusOffset).toBe(4)
      expect(s.model.text).toBe('abcdef')
    } finally { s.editor.dispose() }
  })

  it('still starts editing on an ordinary click', () => {
    const s = setup('abc\n\ndef')
    try {
      s.click(s.run('abc'))
      expect(s.events).toEqual(['begin:編集: 段落'])
      const selection = document.getSelection()!
      expect(selection.isCollapsed).toBe(true)
      expect(s.model.text).toBe('abc\n\ndef')
    } finally { s.editor.dispose() }
  })

  it.each(['same run', 'other run', 'other block'])('uses a normal click with an old selection: %s', place => {
    const s = setup('alpha **beta**\n\ngamma')
    try {
      const alpha = s.run('alpha ')
      document.getSelection()!.setBaseAndExtent(alpha.firstChild!, 1, alpha.firstChild!, 4)
      const target = s.run(place === 'same run' ? 'alpha ' : place === 'other run' ? 'beta' : 'gamma')
      // Some editing-host transitions leave the old range visible until our click handler runs.
      target.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }))
      Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: vi.fn(() => ({ offsetNode: target.firstChild!, offset: 1 })) })
      s.click(target)
      expect(document.getSelection()!.isCollapsed).toBe(true)
      expect(document.getSelection()!.focusNode).toBe(target.firstChild)
      expect(document.getSelection()!.focusOffset).toBe(1)
      expect(s.model.text).toBe('alpha **beta**\n\ngamma')
    } finally { s.editor.dispose() }
  })

  it('keeps a newly dragged range and does not intercept Ctrl+C or copy', () => {
    const s = setup('alpha **beta**')
    try {
      const alpha = s.run('alpha '), beta = s.run('beta')
      s.caret(alpha, 1)
      alpha.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }))
      document.getSelection()!.setBaseAndExtent(alpha.firstChild!, 1, beta.firstChild!, 3)
      s.click(beta)
      expect(document.getSelection()!.isCollapsed).toBe(false)
      const key = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, composed: true, cancelable: true })
      beta.dispatchEvent(key)
      const copy = new Event('copy', { bubbles: true, composed: true, cancelable: true })
      beta.dispatchEvent(copy)
      expect(key.defaultPrevented).toBe(false)
      expect(copy.defaultPrevented).toBe(false)
      expect(document.getSelection()!.anchorOffset).toBe(1)
      expect(document.getSelection()!.focusOffset).toBe(3)
      expect(s.model.state).toBe('clean')
    } finally { s.editor.dispose() }
  })

  it('preserves a drag ending in slide whitespace', () => {
    const s = setup('alpha\n\nbeta')
    try {
      const alpha = s.run('alpha'), beta = s.run('beta')
      s.caret(alpha, 1)
      alpha.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }))
      document.getSelection()!.setBaseAndExtent(alpha.firstChild!, 1, beta.firstChild!, 2)
      s.click(beta.closest('section')!)
      expect(document.getSelection()!.isCollapsed).toBe(false)
      expect(s.events).toEqual([])
      expect(s.model.state).toBe('clean')
    } finally { s.editor.dispose() }
  })

  it('preserves a double-click selection even when it matches the previous range', () => {
    const s = setup('alpha beta')
    try {
      const run = s.run('alpha beta')
      document.getSelection()!.setBaseAndExtent(run.firstChild!, 0, run.firstChild!, 5)
      run.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }))
      run.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, detail: 2 }))
      expect(document.getSelection()!.isCollapsed).toBe(false)
      expect(s.events).toEqual([])
    } finally { s.editor.dispose() }
  })

  it('does not change the file when a selection is dragged only', () => {
    const s = setup('alpha **beta**')
    try {
      document.getSelection()!.setBaseAndExtent(s.run('alpha ').firstChild!, 0, s.run('beta').firstChild!, 4)
      s.click(s.run('beta'))
      expect(s.model.text).toBe('alpha **beta**')
      expect(s.model.canUndo).toBe(false)
      expect(s.model.state).toBe('clean')
    } finally { s.editor.dispose() }
  })
})
