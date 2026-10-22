import { describe, expect, it } from 'vitest'

import sample from '../../tests/fixtures/sample.md?raw'
import { MarpRenderer } from './renderer'

describe('MarpRenderer', () => {
  it('renders the sample deck and rewrites relative image paths', () => {
    const renderer = new MarpRenderer((path) => `asset://localhost/${encodeURIComponent(path)}`)
    const deck = renderer.render(sample, 'C:\\deck')

    expect(deck.slides).toHaveLength(5)
    expect(deck.width).toBe(1280)
    expect(deck.height).toBe(720)

    const backgroundSlide = deck.slides[3] ?? ''
    expect(backgroundSlide).toContain('asset://localhost/')
    expect(backgroundSlide).toContain('sample.png')
    expect(backgroundSlide).not.toContain('url(&quot;images/sample.png&quot;)')
  })
})
