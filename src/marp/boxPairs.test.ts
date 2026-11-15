import { describe, expect, it } from 'vitest'
import { Marp } from '@marp-team/marp-core'
import { collectSlideSources } from '../editing/slides'
import type { Markdown } from '../editing/markdown-types'
import { findBoxPairs, type BoxPair } from './boxPairs'

const open = '<div data-box style="position:absolute; left:320px; top:240px; width:640px">'
function pairs(source: string): BoxPair[] {
  const marp = new Marp({ script: false })
  const md = marp.markdown as unknown as Markdown
  let found: BoxPair[] = []
  md.core.ruler.before('marpit_slide', 'test_box_pairs', state => {
    found = findBoxPairs(state.src, state.tokens, collectSlideSources(state.src, state.tokens, md))
  })
  marp.render(source)
  return found
}

describe('text box pairing', () => {
  it('records exact source ranges with front matter and a final line without newline', () => {
    const source = `---\ntheme: gaia\n---\n\n${open}\n\n# heading\n\n- item\n\n| a | b |\n| - | - |\n| c | d |\n\n</div>`
    const [box] = pairs(source)
    expect(box).toBeDefined()
    expect(source.slice(box.start, box.end)).toBe(source.slice(source.indexOf(open)))
    expect(source.slice(box.styleStart, box.styleEnd)).toBe('position:absolute; left:320px; top:240px; width:640px')
  })

  it('does not pair across slides, nested divs, inline divs, or a missing close', () => {
    for (const source of [
      `${open}\n\ntext`,
      `${open}\n\ntext\n\n---\n\n</div>`,
      `${open}\n\n<div>\n\ntext\n\n</div>\n\n</div>`,
      `<div>\n\n${open}\n\ntext\n\n</div>\n\n</div>`,
      `${open}\n\ntext <div>x</div>\n\n</div>`,
    ]) expect(pairs(source), source).toHaveLength(0)
  })

  it('rejects malformed openers and can recognize separate boxes', () => {
    for (const bad of [open.replace('data-box ', ''), open.replace('width:640px', 'width:640px; color:red'),
      open.replace('style=', 'onclick="x" style='), open.replace('<div', ' <div')]) {
      expect(pairs(`${bad}\n\ntext\n\n</div>`), bad).toHaveLength(0)
    }
    expect(pairs(`${open}\n\na\n\n</div>\n\n${open}\n\nb\n\n</div>`)).toHaveLength(2)
  })
})
