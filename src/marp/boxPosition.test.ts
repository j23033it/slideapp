import { describe, expect, it } from 'vitest'
import { DocumentModel } from '../document'
import { placeBox } from '../editing/boxPosition'
import { MarpRenderer } from './renderer'

describe('box positioning', () => {
  for (const content of ['paragraph', '# heading', '- item', '> quote', '| a | b |\n|---|---|\n| c | d |', '![](image.png)', '```\ncode\n```']) {
    it(`converts ${content.slice(0, 12)} and moves it with independent undo`, () => {
      const raw = `---\r\nmarp: true\n---\r\n\nfirst\r\n\r\n---\n\n${content.replaceAll('\n', '\r\n')}`
      const model = new DocumentModel(raw, { hasBom: true })
      const renderer = new MarpRenderer(path => path)
      const before = renderer.analyze(model.text, null).analysis
      const target = before.elementSources!.elements.find(element => element.slide === 1)!
      const converted = placeBox(model, renderer.editing, before, target.id, { left: 12, top: 34, width: 300 })
      expect(converted).toMatchObject({ ok: true })
      if (!converted.ok) return
      const convertedRaw = model.serialize()
      const moved = placeBox(model, renderer.editing, converted.analysis, converted.elementId, { left: -4, top: 60, width: 320 })
      expect(moved).toMatchObject({ ok: true })
      model.undo(); expect(model.serialize()).toBe(convertedRaw)
      model.undo(); expect(model.serialize()).toBe(raw); expect(model.hasBom).toBe(true)
    })
  }
  it('rejects stale revisions, conflict and heading divider conversion', () => {
    const model = new DocumentModel('---\nheadingDivider: 2\n---\n\n## title\n\ntext')
    const renderer = new MarpRenderer(path => path)
    const before = renderer.analyze(model.text, null).analysis
    const id = before.elementSources!.elements[0].id
    expect(placeBox(model, renderer.editing, before, id, { left: 0, top: 0, width: 40 })).toEqual({ ok: false, reason: 'box-convert-failed' })
    model.markConflict()
    expect(placeBox(model, renderer.editing, before, id, { left: 0, top: 0, width: 40 })).toEqual({ ok: false, reason: 'element-readonly' })
  })
  it.each([
    ['first', 'one\r\n\r\ntwo\n\nthree'],
    ['middle', 'one\r\n\r\ntwo\n\nthree'],
    ['last', 'one\r\n\r\ntwo\n\nthree'],
    ['only', 'one'],
  ])('preserves exact bytes when converting the %s element', (which, raw) => {
    const model = new DocumentModel(raw, { hasBom: true })
    const renderer = new MarpRenderer(path => path)
    const before = renderer.analyze(model.text, null).analysis
    const elements = before.elementSources!.elements
    const index = which === 'last' ? 2 : which === 'middle' ? 1 : 0
    const target = elements[index]
    const result = placeBox(model, renderer.editing, before, target.id, { left: 0, top: 0, width: 100 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(model.text).toContain(model.text.slice(0, target.start) + '<div data-box')
    model.undo(); expect(model.serialize()).toBe(raw); expect(model.hasBom).toBe(true)
  })
  it('rejects an old analysis or element ID without changing the source', () => {
    const model = new DocumentModel('one\n\ntwo')
    const renderer = new MarpRenderer(path => path)
    const before = renderer.analyze(model.text, null).analysis
    expect(placeBox(model, renderer.editing, before, 'stale', {left:0,top:0,width:100})).toEqual({ok:false,reason:'box-convert-failed'})
    model.edit({start:0,end:0,insert:'x'})
    expect(placeBox(model, renderer.editing, before, before.elementSources!.elements[0].id, {left:0,top:0,width:100})).toEqual({ok:false,reason:'box-convert-failed'})
    expect(model.text).toBe('xone\n\ntwo')
  })
  it('rejects read-only input and preserves small existing widths when moving', () => {
    const raw = '<div data-box style="position:absolute; left:1px; top:2px; width:3px">\n\nx\n\n</div>'
    const model = new DocumentModel(raw)
    const renderer = new MarpRenderer(path => path)
    const before = renderer.analyze(raw, null).analysis, id = before.elementSources!.elements[0].id
    expect(placeBox(model, renderer.editing, before, id, {left:3,top:4,width:3}, true)).toEqual({ok:false,reason:'element-readonly'})
    expect(placeBox(model, renderer.editing, before, id, {left:3,top:4,width:3}).ok).toBe(true)
  })

})
