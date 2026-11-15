import { describe, expect, it } from 'vitest'
import { Marp } from '@marp-team/marp-core'
import { DocumentModel } from '../src/document'
import { createEngine } from '../src/editing'
import { resizeImage } from '../src/editing/images'
import { imageLine, insertImage } from '../src/app/imageInsert'

function setup(raw: string) {
  const model = new DocumentModel(raw, { hasBom: true })
  const engine = createEngine(new Marp({ script: false }))
  const analysis = engine.analyze(model.text)
  return { model, engine, analysis, id: analysis.elementSources!.elements.find(e => e.kind === 'image')?.id ?? '' }
}

describe('image transactions', () => {
  it.each([
    ['', 'w:240'], ['caption', 'w:240 caption'], ['w:120 caption', 'w:240 caption'],
    ['width:120 h:55 caption', 'width:240  caption'], ['w:50% height:auto', 'w:240 '], ['height:30 other', 'w:240  other'],
  ])('resizes alt %s', (alt, expected) => {
    const raw = `before\r\n\r\n![${alt}](a.png)\r\n\r\nafter\n`
    const { model, engine, analysis, id } = setup(raw)
    const result = resizeImage(model, engine, analysis, id, 240, 1280)
    expect(result).toMatchObject({ ok: true })
    expect(model.serialize()).toBe(`before\r\n\r\n![${expected}](a.png)\r\n\r\nafter\n`)
    expect(model.hasBom).toBe(true)
    model.undo(); expect(model.serialize()).toBe(raw)
  })
  it('limits the replacement to the changed width value', () => {
    const x = setup('![caption width:120 more](a.png)\n')
    const result = resizeImage(x.model, x.engine, x.analysis, x.id, 240, 1280)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(x.analysis.text.slice(result.edit.start, result.edit.end)).toBe('12')
      expect(result.edit.insert).toBe('24')
    }
  })
  it('rejects escaped alt and background images', () => {
    const x = setup('![a\\*b](a.png)\n')
    expect(resizeImage(x.model, x.engine, x.analysis, x.id, 30, 1280)).toMatchObject({ ok: false, reason: 'image-unsupported-alt' })
    expect(setup('![bg](a.png)\n').id).toBe('')
    for (const alt of ['a &amp; b', '**bold**']) {
      const value = setup(`![${alt}](a.png)\n`)
      expect(resizeImage(value.model, value.engine, value.analysis, value.id, 30, 1280)).toMatchObject({ ok: false, reason: 'image-unsupported-alt' })
    }
  })
  it.each([[1, '16'], [9999, '1280']])('clamps width %i', (width, expected) => {
    const x = setup('![](a.png)\n')
    expect(resizeImage(x.model, x.engine, x.analysis, x.id, width, 1280).ok).toBe(true)
    expect(x.model.text).toBe(`![w:${expected}](a.png)\n`)
  })
  it('rejects duplicate dimensions instead of guessing', () => {
    const x = setup('![w:20 width:30](a.png)\n')
    expect(resizeImage(x.model, x.engine, x.analysis, x.id, 40, 1280)).toMatchObject({ ok: false, reason: 'image-unsupported-alt' })
    expect(x.model.text).toBe('![w:20 width:30](a.png)\n')
  })
  it('inserts through the element transaction and undoes once', () => {
    const { model, engine } = setup('text\r\n')
    const result = insertImage(model, engine, 0, imageLine('x.png', 2000, 1000, 1280, 720))
    expect(result.ok).toBe(true)
    expect(model.serialize()).toContain('![w:864](x.png)')
    model.undo(); expect(model.serialize()).toBe('text\r\n')
  })
})
