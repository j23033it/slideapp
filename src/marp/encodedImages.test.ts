import { describe, expect, it } from 'vitest'
import { MarpRenderer } from './renderer'
import { resolveAssetPath } from './urls'

describe('encoded local image paths', () => {
  it('resolves the same encoded URL for the preview and export DOM', () => {
    const base = 'C:\\slides'
    const path = 'images/%E6%97%A5%E6%9C%AC%20%23%25.png'
    const absolute = 'C:\\slides\\images\\日本 #%.png'
    const toAsset = (value: string) => `asset://localhost/${encodeURIComponent(value)}`
    const deck = new MarpRenderer(toAsset).render(`![](${path})`, base)
    expect(deck.slides[0]).toContain(toAsset(absolute))
    // measureDeck applies this same resolver to the Marp-produced img src.
    expect(resolveAssetPath(base, path)).toBe(absolute)
    expect(resolveAssetPath(base, 'images/a%2Fb.png')).toBeNull()
    expect(resolveAssetPath(base, 'images/100%.png')).toBe('C:\\slides\\images\\100%.png')
  })
})
