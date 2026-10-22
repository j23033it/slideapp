import { Marp } from '@marp-team/marp-core'
import { describe, expect, it, vi } from 'vitest'

import {
  directoryOf,
  parseThemeName,
  registerThemes,
  rewriteThemeCss,
  type ThemeSetLike,
} from './themes'

const BASE = 'C:\\deck\\themes'

const toAssetUrl = (path: string) => `asset://localhost/${encodeURIComponent(path)}`

describe('parseThemeName', () => {
  it('コメントの @theme からテーマ名を取り出す', () => {
    expect(parseThemeName('/* @theme custom */\nsection {}')).toBe('custom')
    expect(parseThemeName('/*!\n * @theme my-theme\n */\nsection {}')).toBe('my-theme')
  })

  it('@theme がなければ null', () => {
    expect(parseThemeName('section { color: red; }')).toBeNull()
    expect(parseThemeName('/* テーマ名なし */\nsection {}')).toBeNull()
  })
})

describe('directoryOf', () => {
  it('CSSファイルの親フォルダを返す', () => {
    expect(directoryOf('C:\\deck\\themes\\a.css')).toBe('C:\\deck\\themes')
    expect(directoryOf('C:/deck/themes/a.css')).toBe('C:\\deck\\themes')
    expect(directoryOf('C:\\a.css')).toBe('C:\\')
    expect(directoryOf('a.css')).toBeNull()
  })
})

describe('rewriteThemeCss', () => {
  it('相対 url() と @import をCSSファイルの場所基準で資産URLにする', () => {
    const css = [
      '/* @theme custom */',
      '@import "./fonts/font.css";',
      'section { background-image: url("images/bg.png"); }',
      'section::after { background: url(https://example.com/x.png); }',
    ].join('\n')

    const actual = rewriteThemeCss(css, BASE, toAssetUrl)

    expect(actual).toContain(
      `@import url("${toAssetUrl('C:\\deck\\themes\\fonts\\font.css')}")`,
    )
    expect(actual).toContain(`url("${toAssetUrl('C:\\deck\\themes\\images\\bg.png')}")`)
    expect(actual).toContain('url(https://example.com/x.png)')
    expect(actual).toContain('/* @theme custom */')
  })

  it('コメント内の url() は書き換えない', () => {
    const css = '/* url(images/comment.png) */\nsection { color: red; }'
    expect(rewriteThemeCss(css, BASE, toAssetUrl)).toBe(css)
  })

  it('テーマ名の @import はパスとして扱わない', () => {
    const css = '@import "gaia";\nsection { color: red; }'
    expect(rewriteThemeCss(css, BASE, toAssetUrl)).toBe(css)
  })

  it('外部URLの @import は書き換えない', () => {
    const css = '@import "https://fonts.googleapis.com/css2?family=Lato";'
    expect(rewriteThemeCss(css, BASE, toAssetUrl)).toBe(css)
  })

  it('基準フォルダがなければ何もしない', () => {
    const css = 'section { background: url(images/bg.png); }'
    expect(rewriteThemeCss(css, null, toAssetUrl)).toBe(css)
  })
})

class FakeThemeSet implements ThemeSetLike {
  readonly themes = new Map<string, string>()

  add(css: string): unknown {
    const name = parseThemeName(css)
    if (!name) throw new Error('theme name is missing')
    this.themes.set(name, css)
    return { name }
  }

  delete(name: string): boolean {
    return this.themes.delete(name)
  }
}

describe('registerThemes', () => {
  const theme = (path: string, name: string): { path: string; css: string } => ({
    path,
    css: `/* @theme ${name} */\nsection { background: #123456; }`,
  })

  it('テーマを登録し、登録した名前を返す', () => {
    const themeSet = new FakeThemeSet()
    const result = registerThemes({ themeSet }, [theme('C:\\deck\\themes\\a.css', 'alpha')], toAssetUrl)

    expect(result.warnings).toEqual([])
    expect(result.themes).toEqual([{ path: 'C:\\deck\\themes\\a.css', name: 'alpha' }])
    expect(themeSet.themes.has('alpha')).toBe(true)
  })

  it('CSS内の相対URLを登録前に資産URLへ書き換える', () => {
    const themeSet = new FakeThemeSet()
    const css = [
      '/* @theme alpha */',
      '@import "./fonts/font.css";',
      'section { background-image: url(images/bg.png); }',
    ].join('\n')

    registerThemes({ themeSet }, [{ path: 'C:\\deck\\themes\\a.css', css }], toAssetUrl)

    const registered = themeSet.themes.get('alpha') ?? ''
    expect(registered).toContain(toAssetUrl('C:\\deck\\themes\\images\\bg.png'))
    expect(registered).toContain(toAssetUrl('C:\\deck\\themes\\fonts\\font.css'))
  })

  it('@theme がないCSSは登録せず警告する', () => {
    const themeSet = new FakeThemeSet()
    const result = registerThemes(
      { themeSet },
      [
        { path: 'C:\\deck\\themes\\broken.css', css: 'section { color: red; }' },
        theme('C:\\deck\\themes\\a.css', 'alpha'),
      ],
      toAssetUrl,
    )

    expect(themeSet.themes.has('alpha')).toBe(true)
    expect(themeSet.themes.size).toBe(1)
    expect(result.themes).toHaveLength(1)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('@theme')
    expect(result.warnings[0]).toContain('broken.css')
  })

  it('同じ名前のテーマは後勝ちにする', () => {
    const themeSet = new FakeThemeSet()
    const result = registerThemes(
      { themeSet },
      [
        { path: 'C:\\deck\\themes\\old.css', css: '/* @theme same */\nsection { color: red; }' },
        { path: 'C:\\deck\\themes\\new.css', css: '/* @theme same */\nsection { color: blue; }' },
      ],
      toAssetUrl,
    )

    expect(result.themes).toEqual([{ path: 'C:\\deck\\themes\\new.css', name: 'same' }])
    expect(themeSet.themes.get('same')).toContain('blue')
  })

  it('前回登録したテーマを外してから登録する', () => {
    const themeSet = new FakeThemeSet()
    const marp = { themeSet }
    const deleted = vi.spyOn(themeSet, 'delete')

    registerThemes(marp, [theme('C:\\deck\\themes\\a.css', 'alpha')], toAssetUrl)
    registerThemes(marp, [theme('C:\\deck\\themes\\b.css', 'beta')], toAssetUrl)

    expect(deleted).toHaveBeenCalledWith('alpha')
    expect(themeSet.themes.has('alpha')).toBe(false)
    expect(themeSet.themes.has('beta')).toBe(true)

    registerThemes(marp, [], toAssetUrl)
    expect(themeSet.themes.size).toBe(0)
  })

  it('登録に失敗したCSSは警告し、ほかのテーマは登録する', () => {
    const themeSet = new FakeThemeSet()
    const add = vi.spyOn(themeSet, 'add').mockImplementationOnce(() => {
      throw new Error('invalid css')
    })
    const result = registerThemes(
      { themeSet },
      [theme('C:\\deck\\themes\\a.css', 'alpha'), theme('C:\\deck\\themes\\b.css', 'beta')],
      toAssetUrl,
    )

    expect(add).toHaveBeenCalledTimes(2)
    expect(result.themes).toEqual([{ path: 'C:\\deck\\themes\\b.css', name: 'beta' }])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('invalid css')
  })
})

describe('registerThemes with Marp', () => {
  it('登録したテーマで描画でき、切り替えると前のテーマが外れる', () => {
    const marp = new Marp({ script: false })
    const custom = [
      {
        path: 'C:\\deck\\themes\\custom.css',
        css: '/* @theme custom */\nsection { background: #123456; }',
      },
    ]

    const result = registerThemes(marp, custom, toAssetUrl)
    expect(result.warnings).toEqual([])
    expect(marp.render('<!-- theme: custom -->\n\n# 見出し').css).toContain('#123456')

    registerThemes(
      marp,
      [
        {
          path: 'C:\\deck\\themes\\other.css',
          css: '/* @theme other */\nsection { background: #abcdef; }',
        },
      ],
      toAssetUrl,
    )

    const after = marp.render('<!-- theme: custom -->\n\n# 見出し').css
    expect(after).not.toContain('#123456')
    expect(marp.render('<!-- theme: other -->\n\n# 見出し').css).toContain('#abcdef')
  })
})
