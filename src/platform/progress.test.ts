import { describe, expect, it } from 'vitest'

import { progressFrom } from './progress'

describe('progressFrom', () => {
  it('全体の大きさが分かれば割合を返す', () => {
    expect(progressFrom(250, 1000)).toEqual({
      downloaded: 250,
      total: 1000,
      ratio: 0.25,
    })
  })

  it('全体の大きさが分からなければ割合を null にする', () => {
    expect(progressFrom(250, null)).toEqual({
      downloaded: 250,
      total: null,
      ratio: null,
    })
  })

  it('全体を超えた分は全体に丸め、割合は1を超えない', () => {
    expect(progressFrom(1500, 1000)).toEqual({
      downloaded: 1000,
      total: 1000,
      ratio: 1,
    })
  })

  it('不正な値は0として扱う', () => {
    expect(progressFrom(Number.NaN, 0)).toEqual({
      downloaded: 0,
      total: null,
      ratio: null,
    })
    expect(progressFrom(-5, -1)).toEqual({
      downloaded: 0,
      total: null,
      ratio: null,
    })
  })
})
