import { Marp } from '@marp-team/marp-core'
import type { Markdown, Token } from '../editing/markdown-types'
import { collectSlideSources } from '../editing/slides'
import { findBoxPairs } from './boxPairs'
import { boxHtmlAllowlist } from './htmlAllowlist'

/** Render only recognized box boundaries with the extended div allowlist. */
export function installBoxHtmlRules(marp: Marp, fallback: Marp): void {
  const md = marp.markdown as unknown as Markdown
  const defaultMd = fallback.markdown as unknown as Markdown
  let admitted = new WeakSet<Token>()
  md.core.ruler.before('marpit_slide', 'sm_box_html', state => {
    admitted = new WeakSet()
    const slides = collectSlideSources(state.src, state.tokens, md)
    if (slides.reason?.code === 'slide-ambiguous-boundary') return
    for (const pair of findBoxPairs(state.src, state.tokens, slides)) {
      admitted.add(pair.open)
      admitted.add(pair.close)
    }
  })
  for (const type of ['html_block', 'html_inline']) {
    const extended = md.renderer.rules[type]
    const normal = defaultMd.renderer.rules[type]
    md.renderer.rules[type] = (tokens, index, options, env, self) => {
      const token = tokens[index]
      const html = (admitted.has(token) ? extended : normal)(tokens, index, options, env, self)
      const id = token.attrs?.find(([name]) => name === 'data-sm-element')?.[1]
      return admitted.has(token) && id && /^e\d+-\d+$/.test(id) && html.startsWith('<div ')
        ? `<div data-sm-element="${id}"${html.slice(4)}` : html
    }
  }
}

/** The fallback keeps all other supplied HTML rules while restoring the normal div rules. */
export function createBoxMarp(options: { svgHtmlAllowlist?: Record<string, unknown> } = {}): Marp {
  const base = options.svgHtmlAllowlist ?? Marp.html
  const common = { script: false as const, math: 'mathjax' as const }
  const marp = new Marp({ ...common, html: { ...base, div: boxHtmlAllowlist.div } })
  const fallback = new Marp({ ...common, html: { ...base, div: Marp.html.div } })
  installBoxHtmlRules(marp, fallback)
  return marp
}
