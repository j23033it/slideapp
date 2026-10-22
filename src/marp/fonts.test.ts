import { describe, expect, it } from 'vitest'

import { splitCssImports } from './fonts'

const IMPORT_LATO =
  '@import "https://fonts.bunny.net/css?family=Lato:400,900|Roboto+Mono:400,700&display=swap";'

describe('splitCssImports', () => {
  it('先頭の@importを取り出し、残りのCSSを返す', () => {
    const result = splitCssImports(`@charset "UTF-8";${IMPORT_LATO}div.marpit > svg { width: 100%; }`)

    expect(result.imports).toEqual([IMPORT_LATO])
    expect(result.css).toBe('@charset "UTF-8";div.marpit > svg { width: 100%; }')
  })

  it('複数の@importを元の順序で取り出す', () => {
    const second = '@import url("https://example.com/second.css") screen;'
    const result = splitCssImports(`${IMPORT_LATO}\n${second}\nsection { color: red; }`)

    expect(result.imports).toEqual([IMPORT_LATO, second])
    expect(result.css).toBe('section { color: red; }')
  })

  it('@importがなければCSSをそのまま返す', () => {
    const css = '@charset "UTF-8";section { color: red; }'

    expect(splitCssImports(css)).toEqual({ imports: [], css })
  })

  it('取り除いた後に先頭の空白を残さない', () => {
    const result = splitCssImports(`${IMPORT_LATO}\n\nsection { color: red; }`)

    expect(result.css).toBe('section { color: red; }')
  })
})
