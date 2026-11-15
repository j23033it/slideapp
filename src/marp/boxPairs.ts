import type { Token } from '../editing/markdown-types'
import type { SlideSources } from '../editing/slides'
import { boxStyle } from './htmlAllowlist'

export interface BoxPair {
  open: Token
  close: Token
  slide: number
  start: number
  end: number
  styleStart: number
  styleEnd: number
}

/** Identify boxes from parser positions, without changing the source or tokens. */
export function findBoxPairs(source: string, tokens: Token[], slides: SlideSources): BoxPair[] {
  const starts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1)
  const result: BoxPair[] = []
  let pending: Omit<BoxPair, 'close' | 'end'> | undefined
  let depth = 0
  for (const token of tokens) {
    if (token.type === 'hr' && token.level === 0) { pending = undefined; depth = 0; continue }
    const html = token.type === 'html_block' || token.type === 'html_inline' ? [token] :
      (token.children ?? []).filter(child => child.type === 'html_inline')
    if (!html.length) continue
    const map = token.map
    const start = map ? starts[map[0]] : undefined
    const end = map ? (starts[map[1]] ?? source.length) : undefined
    const line = start !== undefined && end !== undefined ? source.slice(start, end).replace(/\n$/, '') : ''
    const opener = token.type === 'html_block' && token.level === 0 && map && map[1] === map[0] + 1
      ? /^(<div[ \t]+data-box[ \t]+style=")([^"\n]*)">[ \t]*$/.exec(line) : null
    const closer = token.type === 'html_block' && token.level === 0 && map && map[1] === map[0] + 1 && /^<\/div>[ \t]*$/.test(line)
    const tags = html.flatMap(item => [...item.content.matchAll(/<\/?div(?=[\s/>])/gi)])
    if (!tags.length) continue
    if (pending && depth === 1 && tags.length === 1 && closer && start !== undefined && end !== undefined &&
        slides.bodies[pending.slide] && end <= slides.bodies[pending.slide].end) {
      result.push({ ...pending, close: token, end })
      pending = undefined
      depth = 0
      continue
    }
    if (pending) pending = undefined
    if (depth === 0 && tags.length === 1 && opener && boxStyle(opener[2]) && start !== undefined && end !== undefined) {
      const slide = slides.bodies.findIndex(body => start >= body.start && end <= body.end)
      if (slide >= 0) {
        const styleStart = start + opener[1].length
        pending = { open: token, slide, start, styleStart, styleEnd: styleStart + opener[2].length }
      }
    }
    for (const tag of tags) depth = tag[0].startsWith('</') ? Math.max(0, depth - 1) : depth + 1
  }
  return result
}
