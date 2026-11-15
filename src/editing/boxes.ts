import { replaceRange, type DocumentModel, type SourceEdit } from '../document'
import type { Analysis } from './types'
import type { EditingEngine } from './engine'
import { renderedSlideSignatures } from './slideValidation'

export type BoxSizeResult = { ok: true; edit: SourceEdit; analysis: Analysis; elementId: string } |
  { ok: false; reason: 'element-readonly' | 'element-ambiguous' | 'element-structure-changed' | 'element-heading-divider' }

/** Change only the font-size range recorded during the latest parse. */
export function setBoxFontSize(model: DocumentModel, engine: EditingEngine, before: Analysis, id: string, size: number | null, readonly = false): BoxSizeResult {
  const fail = (reason: Extract<BoxSizeResult, { ok: false }>['reason']): BoxSizeResult => ({ ok: false, reason })
  if (readonly || model.state === 'readonly' || model.state === 'conflict') return fail('element-readonly')
  if (before.text !== model.text || before.draft || !before.elementSources?.valid || !before.slideSources) return fail('element-ambiguous')
  if ((before.slideSources.reason && before.slideSources.reason.code !== 'slide-heading-divider') ||
      (size !== null && (!Number.isInteger(size) || size < 12 || size > 72))) return fail('element-ambiguous')
  const elements = before.elementSources.elements
  const target = elements.find(element => element.id === id && element.kind === 'box')
  const style = target?.boxStyle
  if (!target || !style || target.unsafe) return fail('element-ambiguous')
  let edit: SourceEdit
  if (style.size !== undefined) {
    if (size === null) edit = { start: style.declarationStart!, end: style.declarationEnd!, insert: '' }
    else edit = { start: style.numberStart!, end: style.numberEnd!, insert: String(size) }
  } else {
    if (size === null) return { ok: true, edit: { start: style.insertAt, end: style.insertAt, insert: '' }, analysis: before, elementId: id }
    edit = { start: style.insertAt, end: style.insertAt, insert: `; font-size:${size}pt` }
  }
  const nextText = replaceRange(model.text, edit)
  let after: Analysis
  try { after = engine.analyze(nextText) } catch { engine.analyze(model.text); return fail('element-structure-changed') }
  const next = after.elementSources
  const index = elements.indexOf(target), updated = next?.elements[index]
  const oldSlides = renderedSlideSignatures(before.html), newSlides = renderedSlideSignatures(after.html)
  const sameRuns = JSON.stringify(before.runs.map(run => [run.text, run.editable])) === JSON.stringify(after.runs.map(run => [run.text, run.editable]))
  const sameGroups = before.elementSources.signature.every((groups, slide) => {
    const replacement = [...groups]
    if (slide === target.slide) {
      const groupIndex = before.elementSources!.groups.filter(group => group.slide === slide).findIndex(group => group.start === target.start && group.end === target.end)
      if (groupIndex < 0) return false
      const updatedGroup = next?.signature[slide]?.[groupIndex]
      if (updatedGroup === undefined) return false
      replacement[groupIndex] = updatedGroup
    }
    return JSON.stringify(replacement) === JSON.stringify(next?.signature[slide])
  })
  if (!next?.valid || !after.slideSources || after.slideSources.reason?.code !== before.slideSources.reason?.code || next.elements.length !== elements.length ||
      updated?.kind !== 'box' || updated.slide !== target.slide || (updated.boxStyle?.size ?? null) !== size || !sameRuns || !sameGroups ||
      !oldSlides || !newSlides || oldSlides.length !== newSlides.length || oldSlides.some((value, i) => i !== target.slide && value !== newSlides[i])) {
    engine.analyze(model.text); return fail('element-structure-changed')
  }
  try { model.editTransaction([edit]) } catch { engine.analyze(model.text); return fail('element-ambiguous') }
  return { ok: true, edit, analysis: after, elementId: updated.id }
}
