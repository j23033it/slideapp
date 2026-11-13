// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { afterEach, describe, expect, it } from 'vitest'
import { StageEditor } from '../src/app/stageEditor'
import { DocumentModel } from '../src/document'
import { createEngine, type ReadonlyCode } from '../src/editing'
import type { RenderedDeck } from '../src/marp/renderer'
import type { SlideSurface } from '../src/marp/surface'

afterEach(() => { document.body.innerHTML = ''; document.getSelection()?.removeAllRanges() })
function fixture(source = '| 表 |\n|---|\n| 前<br>後 |') {
  const model = new DocumentModel(source), engine = createEngine(new Marp({ script: false }))
  let analysis = engine.analyze(model.text), deck = { slides: [analysis.html] } as RenderedDeck, seq = 0
  const host = document.createElement('div'); document.body.append(host)
  const root = host.attachShadow({ mode: 'open' }), notices: ReadonlyCode[] = []
  const editor = new StageEditor({ root, update(next: RenderedDeck) { root.innerHTML = next.slides[0] } } as unknown as SlideSurface, engine, {
    latest: () => ({ analysis, deck }), onBegin() {}, onEnd() {}, onNotice(code) { notices.push(code) },
    onCommit(result, cursors) { model.edit(result.edit, cursors); analysis = result.analysis; deck = { slides: [analysis.html] } as RenderedDeck },
    onCrossRun(result, cursor, before) {
      if (result.separateHistory) model.breakHistoryGroup()
      model.edit(result.edit, { before, after: cursor })
      if (result.separateHistory) model.breakHistoryGroup()
      analysis = result.analysis; deck = { slides: [analysis.html] } as RenderedDeck
      editor.render(deck, analysis, 0, { seq: ++seq, cursor })
    }, onHistory(direction) { model[direction]() },
  })
  editor.render(deck, analysis, 0)
  const run = (label: string) => [...root.querySelectorAll<HTMLElement>('[data-sm-run]')].find(run => run.textContent === label)!
  const begin = (label: string, offset: number) => {
    const element = run(label); element.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    const node = element.firstChild ?? element; document.getSelection()!.setBaseAndExtent(node, offset, node, offset)
    return element
  }
  return { model, editor, root, notices, run, begin }
}
describe('table cell stage operations', () => {
  it.each(['Tab', 'Enter'] as const)('rejects %s within a cell', key => {
    const f = fixture()
    try {
      const element = f.begin('前', 1)
      const event = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, shiftKey: true })
      element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(f.notices).toEqual(['table-input'])
      expect(f.model.text).toBe('| 表 |\n|---|\n| 前<br>後 |')
    } finally { f.editor.dispose() }
  })
  it('rejects pipe input and restores the cell text', () => {
    const f = fixture()
    try {
      const element = f.begin('前', 1)
      element.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, cancelable: true, inputType: 'insertText', data: '|' }))
      element.textContent = '前|'
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: '|' }))
      expect(f.model.text).toBe('| 表 |\n|---|\n| 前<br>後 |')
      expect(f.run('前')).toBeDefined()
      expect(f.notices).toEqual(['table-input'])
    } finally { f.editor.dispose() }
  })
  it('deletes a break as a separate history entry and restores the caret', () => {
    const f = fixture()
    try {
      const element = f.begin('後', 0)
      const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, composed: true, cancelable: true })
      element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(f.model.text).toBe('| 表 |\n|---|\n| 前後 |')
      expect(document.getSelection()?.anchorOffset).toBe(1)
      f.model.undo(); expect(f.model.text).toBe('| 表 |\n|---|\n| 前<br>後 |')
    } finally { f.editor.dispose() }
  })
  it('rerenders a deleted run as an editable empty cell', () => {
    const f = fixture('| 表 |\n|---|\n| 内容 |')
    try {
      const element = f.begin('内容', 2)
      element.textContent = ''
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }))
      expect(f.model.text).toBe('| 表 |\n|---|\n|  |')
      expect(f.root.querySelector('[data-sm-empty]')).not.toBeNull()
      expect(f.notices).toEqual([])
    } finally { f.editor.dispose() }
  })
  it.each([
    ['a<br>', 'a', 1, 'Delete', 'a', 'a', 1],
    ['<br>a', 'a', 0, 'Backspace', 'a', 'a', 0],
    ['a<br><br>b', 'b', 0, 'Backspace', 'a<br>b', 'b', 0],
    ['a<br><br>b', 'a', 1, 'Delete', 'a<br>b', 'a', 1],
  ] as const)('deletes the adjacent break through the keyboard in %s', (cell, label, offset, key, expected, caret, caretOffset) => {
    const original = `| 表 |\n|---|\n| ${cell} |`, f = fixture(original)
    try {
      const element = f.begin(label, offset)
      const event = new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true })
      element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(f.notices).toEqual([])
      expect(f.model.text).toBe(`| 表 |\n|---|\n| ${expected} |`)
      expect(document.getSelection()?.anchorNode?.parentElement?.textContent).toBe(caret)
      expect(document.getSelection()?.anchorOffset).toBe(caretOffset)
      f.model.undo(); expect(f.model.text).toBe(original)
    } finally { f.editor.dispose() }
  })
  it('deletes the trailing break after the following run is emptied', () => {
    const original = '| 表 |\n|---|\n| 前<br>後 |', f = fixture(original)
    try {
      const element = f.begin('後', 1)
      element.textContent = ''
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }))
      expect(f.model.text).toBe('| 表 |\n|---|\n| 前<br> |')
      const before = f.model.text
      f.run('前').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, composed: true, cancelable: true }))
      expect(f.model.text).toBe('| 表 |\n|---|\n| 前 |')
      expect(document.getSelection()?.anchorOffset).toBe(1)
      f.model.undo(); expect(f.model.text).toBe(before)
    } finally { f.editor.dispose() }
  })
  it.each([['a<br>', 'Delete'], ['<br>a', 'Backspace']] as const)('deletes a break beside a zero-length run: %s', (cell, key) => {
    const f = fixture(`| 表 |\n|---|\n| ${cell} |`)
    try {
      const element = f.begin('a', 1)
      element.textContent = ''
      element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }))
      const before = f.model.text
      const empty = f.root.querySelector<HTMLElement>('[data-sm-empty]')!
      expect(empty).not.toBeNull()
      empty.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true }))
      expect(f.model.text).toBe('| 表 |\n|---|\n|  |')
      expect(document.getSelection()?.anchorOffset).toBe(0)
      f.model.undo(); expect(f.model.text).toBe(before)
    } finally { f.editor.dispose() }
  })

})
