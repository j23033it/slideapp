import { preferredEol, replaceRange, type DocumentModel, type SourceEdit } from '../document'
import type { Analysis } from './types'
import type { EditingEngine } from './engine'
import { renderedSlideSignatures } from './slideValidation'

export interface BoxGeometry { left: number; top: number; width: number }
export type BoxPositionResult = { ok: true; analysis: Analysis; elementId: string } |
  { ok: false; reason: 'element-readonly' | 'box-move-failed' | 'box-convert-failed' }

/** Validate the original parser coordinates and commit only after re-parsing. */
export function placeBox(model: DocumentModel, engine: EditingEngine, before: Analysis, id: string,
  geometry: BoxGeometry, readonly = false): BoxPositionResult {
  const target = before.elementSources?.elements.find(item => item.id === id)
  const conversion = target?.kind !== 'box'
  const failure = conversion ? 'box-convert-failed' : 'box-move-failed'
  const fail = (): BoxPositionResult => ({ ok: false, reason: failure })
  if (readonly || model.state === 'readonly' || model.state === 'conflict') return { ok: false, reason: 'element-readonly' }
  if (before.text !== model.text || before.draft || !before.elementSources?.valid || !before.slideSources || !target || target.unsafe ||
      (before.slideSources.reason && (conversion || before.slideSources.reason.code !== 'slide-heading-divider')) ||
      !Number.isSafeInteger(geometry.left) || !Number.isSafeInteger(geometry.top) || !Number.isSafeInteger(geometry.width) || (geometry.width < 40 && geometry.width !== target.boxStyle?.width)) return fail()
  const edits: SourceEdit[] = []
  if (conversion) {
    const line = model.text.slice(0, target.start).split('\n').length - 1
    const endLine = model.text.slice(0, target.end).split('\n').length - 1
    const opening = `<div data-box style="position:absolute; left:${geometry.left}px; top:${geometry.top}px; width:${geometry.width}px">\n\n`
    const closing = model.text[target.end - 1] === '\n' ? '\n</div>\n' : '\n\n</div>'
    const eolBefore = model.eols[line] || model.eols[line - 1] || preferredEol(model.eols)
    const eolAfter = model.eols[endLine - 1] || model.eols[endLine] || preferredEol(model.eols)
    edits.push({ start: target.end, end: target.end, insert: closing, eols: Array(closing.split('\n').length - 1).fill(eolAfter) })
    edits.push({ start: target.start, end: target.start, insert: opening, eols: [eolBefore, eolBefore] })
  } else {
    const style = target.boxStyle
    if (!style) return fail()
    // One replacement spans only the recorded numeric fields and their unchanged separators.
    const values = [
      { start: style.leftStart, end: style.leftEnd, old: style.left, value: geometry.left },
      { start: style.topStart, end: style.topEnd, old: style.top, value: geometry.top },
      { start: style.widthStart, end: style.widthEnd, old: style.width, value: geometry.width },
    ].filter(value => value.old !== value.value)
    if (!values.length) return { ok: true, analysis: before, elementId: id }
    const start = values[0].start, end = values[values.length - 1].end
    let insert = '', cursor = start
    for (const value of values) { insert += model.text.slice(cursor, value.start) + String(value.value); cursor = value.end }
    edits.push({ start, end, insert })
  }
  let nextText = model.text
  for (const edit of edits) nextText = replaceRange(nextText, edit)
  let after: Analysis
  try { after = engine.analyze(nextText) } catch { engine.analyze(model.text); return fail() }
  const previous = before.elementSources, next = after.elementSources
  const targetIndex = previous.elements.indexOf(target), updated = next?.elements[targetIndex]
  const oldSlides = renderedSlideSignatures(before.html), newSlides = renderedSlideSignatures(after.html)
  const sameRuns = JSON.stringify(before.runs.map(run => [run.text, run.editable])) === JSON.stringify(after.runs.map(run => [run.text, run.editable]))
  const oldGroups = previous.groups.filter(group => group.slide === target.slide)
  const groupIndex = oldGroups.findIndex(group => group.start === target.start && group.end === target.end)
  const sameGroups = previous.signature.every((groups, slide) => {
    const result = [...groups], newGroups = next?.signature[slide]
    if (slide === target.slide) {
      if (groupIndex < 0 || !newGroups?.[groupIndex]) return false
      try {
        const oldTokens = JSON.parse(groups[groupIndex]) as unknown[]
        const newTokens = JSON.parse(newGroups[groupIndex]) as unknown[]
        const oldInner = conversion ? oldTokens : oldTokens.slice(1, -1)
        if (JSON.stringify(oldInner) !== JSON.stringify(newTokens.slice(1, -1))) return false
      } catch { return false }
      result[groupIndex] = newGroups[groupIndex]
    }
    return JSON.stringify(result) === JSON.stringify(newGroups)
  })
  const style = updated?.boxStyle
  if (!next?.valid || !after.slideSources || next.elements.length !== previous.elements.length || updated?.kind !== 'box' ||
      updated.slide !== target.slide || !style || style.left !== geometry.left || style.top !== geometry.top || style.width !== geometry.width ||
      (!conversion && style.size !== target.boxStyle?.size) || !sameRuns || !sameGroups || !oldSlides || !newSlides ||
      oldSlides.length !== newSlides.length || oldSlides.some((value, i) => i !== target.slide && value !== newSlides[i])) {
    engine.analyze(model.text); return fail()
  }
  try { model.editTransaction(edits) } catch { engine.analyze(model.text); return fail() }
  return { ok: true, analysis: after, elementId: updated.id }
}
