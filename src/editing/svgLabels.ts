import type { Token } from './markdown-types'
import type { SlideSources } from './slides'

export interface SvgLabel { start: number; end: number; text: string }
export interface SvgLabelGroup { slide: number; labels: SvgLabel[]; markup: string }

function decodeText(value: string): string | undefined {
  if (/&(?!amp;|lt;|gt;|quot;|apos;)/.test(value) || /[\r\n\0]/.test(value)) return
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[name]!)
}

/** Parse a conservative XML subset while retaining each character-data offset. */
function parseDiagram(content: string, offset: number): SvgLabel[] | undefined {
  const token = /<!--[\s\S]*?-->|<\/?[A-Za-z_][\w:.-]*(?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>|[^<]+/gy
  const stack: { name: string; start: number; text?: string; nested: boolean }[] = []
  const labels: SvgLabel[] = []
  let root = false, closed = false, position = 0
  for (;;) {
    token.lastIndex = position
    const match = token.exec(content)
    if (!match) break
    const value = match[0], start = match.index, end = token.lastIndex
    position = end
    if (value.startsWith('<!--')) {
      if (stack.at(-1)?.name === 'text') stack.at(-1)!.nested = true
      continue
    }
    if (value.startsWith('<')) {
      const name = /^<\/?([A-Za-z_][\w:.-]*)/.exec(value)![1]!
      const closing = value.startsWith('</'), selfClosing = /\/\s*>$/.test(value)
      if (closing) {
        const item = stack.pop()
        if (!item || item.name !== name) return
        if (name === 'text') {
          const text = item.nested ? undefined : decodeText(item.text ?? '')
          if (text === undefined) return
          labels.push({ start: offset + item.start, end: offset + start, text })
        }
        if (!stack.length) closed = true
      } else {
        if (closed || (!stack.length && (root || name !== 'svg'))) return
        if (!stack.length) root = true
        if (stack.at(-1)?.name === 'text') stack.at(-1)!.nested = true
        if (!selfClosing) stack.push({ name, start: end, nested: false })
        else if (!stack.length) closed = true
      }
    } else {
      if (!stack.length) {
        if (value.trim()) return
      } else if (stack.at(-1)?.name === 'text') {
        const item = stack.at(-1)!
        item.text = (item.text ?? '') + value
      }
    }
  }
  if (position !== content.length || !root || !closed || stack.length) return
  return labels
}

/** Only exact, top-level Marp HTML blocks within unambiguous slide ranges qualify. */
export function collectSvgLabelGroups(source: string, tokens: readonly Token[], slides?: SlideSources): SvgLabelGroup[] {
  if (!slides || slides.boundariesAmbiguous || (slides.reason && slides.reason.code !== 'slide-position-css') || source.includes('\0')) return []
  const starts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1)
  const groups: SvgLabelGroup[] = []
  for (const token of tokens) {
    if (token.type !== 'html_block' || !token.map || !/^<svg(?:\s|>)/.test(token.content)) continue
    const start = starts[token.map[0]], end = starts[token.map[1]] ?? source.length
    if (start === undefined || source.slice(start, end) !== token.content) continue
    const slide = slides.bodies.findIndex(body => start >= body.start && end <= body.end)
    if (slide < 0) continue
    const labels = parseDiagram(token.content, start)
    if (labels) groups.push({ slide, labels, markup: token.content })
  }
  return groups
}

export function encodeSvgLabel(text: string): string | undefined {
  if (/[\x00-\x1f\x7f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(text)) return
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
