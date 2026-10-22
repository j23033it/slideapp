import { describe, expect, it } from 'vitest'

import { MarpRenderer, splitRenderedSlides } from './renderer'
import { isExternalReference, resolveAssetPath, rewriteCssUrls } from './urls'

const BASE = 'C:\\Users\\me\\deck'

const toAssetUrl = (path: string) => `asset://localhost/${encodeURIComponent(path)}`

describe('resolveAssetPath', () => {
  it('相対パスを開いたファイルのフォルダ基準で解決する', () => {
    expect(resolveAssetPath(BASE, 'images/sample.png')).toBe(
      'C:\\Users\\me\\deck\\images\\sample.png',
    )
    expect(resolveAssetPath(BASE, './images/sample.png')).toBe(
      'C:\\Users\\me\\deck\\images\\sample.png',
    )
  })

  it('.. を畳む', () => {
    expect(resolveAssetPath(BASE, '../img/a.png')).toBe('C:\\Users\\me\\img\\a.png')
    expect(resolveAssetPath(BASE, 'images/../a.png')).toBe('C:\\Users\\me\\deck\\a.png')
  })

  it('ルート相対はドライブのルートから解決する', () => {
    expect(resolveAssetPath(BASE, '/images/a.png')).toBe('C:\\images\\a.png')
  })

  it('絶対パスはそのまま返す', () => {
    expect(resolveAssetPath(BASE, 'D:/pics/a.png')).toBe('D:\\pics\\a.png')
  })

  it('外部参照・data URI・アンカーは変換しない', () => {
    expect(resolveAssetPath(BASE, 'https://example.com/a.png')).toBeNull()
    expect(resolveAssetPath(BASE, 'data:image/png;base64,AAAA')).toBeNull()
    expect(resolveAssetPath(BASE, '#section')).toBeNull()
    expect(resolveAssetPath(BASE, '//example.com/a.png')).toBeNull()
    expect(resolveAssetPath(BASE, '')).toBeNull()
  })

  it('基準フォルダがないときは相対パスを解決しない', () => {
    expect(resolveAssetPath(null, 'images/a.png')).toBeNull()
  })
})

describe('isExternalReference', () => {
  it('スキーム付きの参照を外部とみなす', () => {
    expect(isExternalReference('https://example.com')).toBe(true)
    expect(isExternalReference('asset://localhost/C%3A/a.png')).toBe(true)
    expect(isExternalReference('images/a.png')).toBe(false)
  })
})

describe('rewriteCssUrls', () => {
  it('相対URLだけを資産URLへ置き換える', () => {
    const css = [
      'section { background-image: url("images/bg.png"); }',
      'section::after { background: url(https://example.com/x.png); }',
      "section { border-image: url('a.png'); }",
    ].join('\n')
    const actual = rewriteCssUrls(css, BASE, toAssetUrl)

    expect(actual).toContain(`url("${toAssetUrl('C:\\Users\\me\\deck\\images\\bg.png')}")`)
    expect(actual).toContain('url(https://example.com/x.png)')
    expect(actual).toContain(`url("${toAssetUrl('C:\\Users\\me\\deck\\a.png')}")`)
  })

  it('baseDirがないときは何もしない', () => {
    const css = 'section { background: url(images/bg.png); }'
    expect(rewriteCssUrls(css, null, toAssetUrl)).toBe(css)
  })
})

describe('splitRenderedSlides', () => {
  it('入れ子のsvgがあってもスライド単位で分割する', () => {
    const html = [
      '<div class="marpit">',
      '<svg data-marpit-svg viewBox="0 0 960 720"><foreignObject><section>',
      '<svg viewBox="0 0 10 10"><rect /></svg>',
      '</section></foreignObject></svg>',
      '<svg data-marpit-svg viewBox="0 0 960 720"><foreignObject><section>2</section></foreignObject></svg>',
      '</div>',
    ].join('')

    const result = splitRenderedSlides(html)
    expect(result.slides).toHaveLength(2)
    expect(result.width).toBe(960)
    expect(result.height).toBe(720)
    expect(result.slides[0]).toContain('<rect />')
    expect(result.slides[0]?.startsWith('<div class="marpit">')).toBe(true)
  })
})

describe('MarpRenderer', () => {
  const renderer = new MarpRenderer(toAssetUrl)

  it('Marpのページ区切りでスライドを分割する', () => {
    const deck = renderer.render('# 1枚目\n\n---\n\n# 2枚目\n\n---\n\n# 3枚目', BASE)
    expect(deck.slides).toHaveLength(3)
    expect(deck.width).toBe(1280)
    expect(deck.height).toBe(720)
    expect(deck.css.length).toBeGreaterThan(0)
  })

  it('相対画像を資産URLへ変換する（ソースは変更しない）', () => {
    const deck = renderer.render('![代替](images/a.png)', BASE)
    const expected = toAssetUrl('C:\\Users\\me\\deck\\images\\a.png')
    expect(deck.slides[0]).toContain(`src="${expected}"`)
  })

  it('背景画像（bg）も資産URLへ変換する', () => {
    const deck = renderer.render('![bg right](images/sample.png)\n\n# 背景', BASE)
    const expected = toAssetUrl('C:\\Users\\me\\deck\\images\\sample.png')
    expect(deck.slides[0]).toContain('background-image')
    expect(deck.slides[0]).toContain(expected)
  })

  it('外部URLの画像は変換しない', () => {
    const deck = renderer.render('![alt](https://example.com/a.png)', BASE)
    expect(deck.slides[0]).toContain('src="https://example.com/a.png"')
  })

  it('同じ入力の再描画は同じ結果を返す', () => {
    const first = renderer.render('# same', BASE)
    const second = renderer.render('# same', BASE)
    expect(second).toBe(first)
    const changed = renderer.render('# changed', BASE)
    expect(changed).not.toBe(first)
  })
})
