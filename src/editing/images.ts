import { replaceRange, type DocumentModel, type SourceEdit } from '../document'
import type { Analysis } from './types'
import type { EditingEngine } from './engine'

export type ImageResizeReason = 'image-unsupported-alt' | 'element-ambiguous' | 'element-structure-changed' | 'element-readonly' | 'element-heading-divider'
export type ImageResizeResult = { ok: true; edit: SourceEdit; analysis: Analysis; newText: string } | { ok: false; reason: ImageResizeReason }

/** Operates on the alt range captured when the element was parsed. */
export function resizeImage(model: DocumentModel, engine: EditingEngine, before: Analysis, id: string, width: number, slideWidth: number, readonly = false): ImageResizeResult {
  const fail = (reason: ImageResizeReason): ImageResizeResult => ({ ok: false, reason })
  if (readonly || model.state === 'readonly' || model.state === 'conflict') return fail('element-readonly')
  if (before.text !== model.text || before.draft || !before.elementSources?.valid || !before.slideSources) return fail('element-ambiguous')
  if (before.slideSources.reason?.code === 'slide-heading-divider') return fail('element-heading-divider')
  if (before.slideSources.reason) return fail('element-ambiguous')
  const target = before.elementSources.elements.find(element => element.id === id)
  if (!target || target.kind !== 'image' || target.unsafe) return fail('element-ambiguous')
  const alt = target.imageAlt
  if (!alt || model.text.slice(alt.start, alt.end) !== alt.text || !Number.isFinite(width) || !Number.isFinite(slideWidth) || slideWidth < 16) return fail('image-unsupported-alt')
  width = Math.max(16, Math.min(Math.floor(slideWidth), Math.round(width)))
  // Accept only unambiguous standalone size directives; preserve every other character.
  const sizes = alt.sizes
  if (sizes.some(m => !/^(?:(?:\d*\.)?\d+(?:%|ch|cm|em|ex|in|mm|pc|pt|px)?|auto)$/.test(m.value)) || sizes.filter(m => /^w(?:idth)?$/.test(m.name)).length > 1 || sizes.filter(m => /^h(?:eight)?$/.test(m.name)).length > 1) return fail('image-unsupported-alt')
  let next = alt.text
  for (const size of [...sizes].reverse()) {
    const start = size.start - alt.start, end = size.end - alt.start
    if (alt.text.slice(start, end) !== `${size.name}:${size.value}`) return fail('element-ambiguous')
    next = next.slice(0, start) + (/^w(?:idth)?$/.test(size.name) ? `${size.name}:${width}` : '') + next.slice(end)
  }
  if (!sizes.some(m => /^w(?:idth)?$/.test(m.name))) next = `w:${width}${next ? ' ' : ''}${next}`
  let prefix = 0, suffix = 0
  while (prefix < alt.text.length && prefix < next.length && alt.text[prefix] === next[prefix]) prefix++
  while (suffix < alt.text.length - prefix && suffix < next.length - prefix &&
    alt.text[alt.text.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  const edit = { start: alt.start + prefix, end: alt.end - suffix, insert: next.slice(prefix, next.length - suffix) }
  const newText = replaceRange(model.text, edit)
  let after: Analysis
  try { after = engine.analyze(newText) } catch { engine.analyze(model.text); return fail('element-structure-changed') }
  const old = before.elementSources, current = after.elementSources
  const oldIndex = old.elements.indexOf(target), updated = current?.elements[oldIndex]
  const good = !!current?.valid && !!after.slideSources && !after.slideSources.reason && current.elements.length === old.elements.length &&
    updated?.kind === 'image' && updated.slide === target.slide && updated.imageAlt?.text === next &&
    old.signature.length === current.signature.length && old.signature.every((groups, slide) => {
      const replacement = [...groups]
      if (slide === target.slide) {
        const index = old.groups.filter(g => g.slide === slide).findIndex(g => g.start === target.start && g.end === target.end)
        if (index < 0) return false
        replacement[index] = current.signature[slide]?.[index]
      }
      return JSON.stringify(replacement) === JSON.stringify(current.signature[slide])
    })
  if (!good) { engine.analyze(model.text); return fail('element-structure-changed') }
  try { model.editTransaction([edit]) } catch { engine.analyze(model.text); return fail('element-ambiguous') }
  return { ok: true, edit, analysis: after, newText }
}
