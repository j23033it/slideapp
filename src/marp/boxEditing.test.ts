import { describe, expect, it } from 'vitest'
import { DocumentModel } from '../document'
import { MarpRenderer } from './renderer'
import { setBoxFontSize } from '../editing/boxes'

const box = '<div data-box style="position:absolute; left:320px; top:240px; width:640px">\n\nhello\n\n- item\n\n</div>'
describe('box source mapping', () => {
  it('exposes one element while preserving editable inner text', () => {
    const renderer = new MarpRenderer(path => path)
    const { analysis } = renderer.analyze(box, null)
    const element = analysis.elementSources?.elements[0]
    expect(analysis.elementSources?.elements.map(item => item.kind)).toEqual(['box'])
    expect(analysis.html).toContain(`data-sm-element="${element?.id}"`)
    const run = analysis.runs.find(item => item.text === 'hello')!
    expect(run.editable).toBe(true)
    const edit = renderer.editing.applyRunEdit(box, run.id, 'world')
    expect(edit.ok && edit.newText).toBe(box.replace('hello', 'world'))
  })

  it('deletes a whole box as one history entry and preserves mixed line endings', () => {
    const model = new DocumentModel(`before\r\n\r\n${box.replaceAll('\n', '\r\n')}\n\nafter`, { hasBom: true })
    const original = model.serialize()
    const renderer = new MarpRenderer(path => path)
    const { analysis } = renderer.analyze(model.text, null)
    const element = analysis.elementSources?.elements.find(item => item.kind === 'box')!
    const result = renderer.editing.applyElementOperation(model.text, { kind: 'delete', elementId: element.id }, model.eols)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    model.editTransaction([result.edit])
    expect(model.text).not.toContain('data-box')
    model.undo()
    expect(model.serialize()).toBe(original)
    expect(model.hasBom).toBe(true)
    model.redo()
    expect(model.text).not.toContain('data-box')
  })

  it('rolls back an empty box and combines the first input with insertion', () => {
    const model = new DocumentModel('---\r\ntheme: gaia\r\n---\n\n', { hasBom: true })
    const original = model.serialize()
    const renderer = new MarpRenderer(path => path)
    renderer.analyze(model.text, null)
    const inserted = renderer.editing.insertBox(model.text, 0, 1280, 720, model.eols)
    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return
    model.edit(inserted.edit)
    const cancellation = renderer.editing.cancelDraft(model.text)
    expect(cancellation.ok).toBe(true)
    if (!cancellation.ok) return
    model.edit(cancellation.edit)
    expect(model.serialize()).toBe(original)
    expect(model.canUndo).toBe(false)
    const again = renderer.editing.insertBox(model.text, 0, 1280, 720, model.eols)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    model.edit(again.edit)
    const typed = renderer.editing.applyRunEdit(model.text, again.cursor.runId, 'hello')
    expect(typed.ok).toBe(true)
    if (!typed.ok) return
    model.edit(typed.edit)
    expect(model.text).toContain('hello')
    model.undo()
    expect(model.serialize()).toBe(original)
    model.redo()
    expect(model.text).toContain('hello')
  })

  it('changes only the font-size range and restores it with undo', () => {
    const model = new DocumentModel(box.replaceAll('\n', '\r\n'))
    const original = model.serialize()
    const renderer = new MarpRenderer(path => path)
    const before = renderer.analyze(model.text, null).analysis
    const id = before.elementSources!.elements[0].id
    const added = setBoxFontSize(model, renderer.editing, before, id, 32)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(model.text).toContain('width:640px; font-size:32pt')
    const removed = setBoxFontSize(model, renderer.editing, added.analysis, added.elementId, null)
    expect(removed.ok).toBe(true)
    expect(model.serialize()).toBe(original)
    model.undo()
    expect(model.text).toContain('font-size:32pt')
    model.undo()
    expect(model.serialize()).toBe(original)
  })

  it('keeps an entered box when its last text is deleted', () => {
    const source = '<div data-box style="position:absolute; left:1px; top:2px; width:3px">\n\nx\n\n</div>'
    const renderer = new MarpRenderer(path => path)
    const before = renderer.analyze(source, null).analysis
    const run = before.runs.find(item => item.text === 'x')!
    const result = renderer.editing.applyRunEdit(source, run.id, '')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.newText).toContain('data-box')
      const reloaded = renderer.editing.analyze(result.newText)
      const empty = reloaded.runs.find(item => item.editable && item.text === '')
      expect(empty).toBeDefined()
      expect(empty && renderer.editing.applyRunEdit(result.newText, empty.id, 'again').ok).toBe(true)
    }
  })

  it('rejects font edits during conflict and in read-only documents', () => {
    for (const source of [box, `${box}\n\0`]) {
      const model = new DocumentModel(source)
      if (!source.includes('\0')) model.markConflict()
      const renderer = new MarpRenderer(path => path)
      const before = renderer.analyze(model.text, null).analysis
      const id = before.elementSources!.elements.find(item => item.kind === 'box')?.id ?? 'unavailable'
      expect(setBoxFontSize(model, renderer.editing, before, id, 32)).toEqual({ ok: false, reason: 'element-readonly' })
      expect(model.text).toBe(source)
    }
  })

  it('inserts into an empty slide with mixed line endings without changing existing bytes', () => {
    const original = '---\r\nmarp: true\n---\r\n\nfirst\r\n\r\n---\n'
    const model = new DocumentModel(original, { hasBom: true })
    const renderer = new MarpRenderer(path => path)
    renderer.analyze(model.text, null)
    const inserted = renderer.editing.insertBox(model.text, 1, 1280, 720, model.eols)
    expect(inserted.ok).toBe(true)
    if (!inserted.ok) return
    model.edit(inserted.edit)
    const typed = renderer.editing.applyRunEdit(model.text, inserted.cursor.runId, 'box')
    expect(typed.ok).toBe(true)
    if (!typed.ok) return
    model.edit(typed.edit)
    model.undo()
    expect(model.serialize()).toBe(original)
    expect(model.hasBom).toBe(true)
  })

  it('maps a box after a generated heading divider and permits font changes', () => {
    const source = `---\nheadingDivider: 2\n---\n\n## First\n\none\n\n## Second\n\n${box}`
    const model = new DocumentModel(source)
    const renderer = new MarpRenderer(path => path)
    const analysis = renderer.analyze(model.text, null).analysis
    const element = analysis.elementSources!.elements.find(item => item.kind === 'box')!
    expect(element.slide).toBe(1)
    const changed = setBoxFontSize(model, renderer.editing, analysis, element.id, 32)
    expect(changed.ok).toBe(true)
    expect(model.text).toContain('font-size:32pt')
    model.undo()
    expect(model.text).toBe(source)
  })

  it('keeps heading, list, and table content editable inside one box element', () => {
    const source = '<div data-box style="position:absolute; left:1px; top:2px; width:300px">\n\n# Heading\n\n- Item\n\n| A | B |\n|---|---|\n| C | D |\n\n</div>'
    const renderer = new MarpRenderer(path => path)
    const analysis = renderer.analyze(source, null).analysis
    expect(analysis.elementSources?.elements.map(element => element.kind)).toEqual(['box'])
    for (const content of ['Heading', 'Item', 'A', 'C']) {
      expect(analysis.runs.find(run => run.text === content)?.editable, content).toBe(true)
    }
  })
})
