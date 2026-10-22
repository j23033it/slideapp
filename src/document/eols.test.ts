import { describe, expect, it } from 'vitest'

import { dominantEol, joinEols, splitEols, type Eol } from './eols'

function roundTrip(raw: string): string {
  const { text, eols } = splitEols(raw)
  return joinEols(text, eols)
}

describe('splitEols', () => {
  it('CRLFをLFに正規化し、行ごとの改行コードを返す', () => {
    const { text, eols } = splitEols('a\r\nb\r\nc')
    expect(text).toBe('a\nb\nc')
    expect(eols).toEqual(['\r\n', '\r\n', ''])
  })

  it('LFをそのまま保つ', () => {
    const { text, eols } = splitEols('a\nb\n')
    expect(text).toBe('a\nb\n')
    expect(eols).toEqual(['\n', '\n', ''])
  })

  it('混在した改行コードを行ごとに記録する', () => {
    const { text, eols } = splitEols('a\r\nb\nc\r\n')
    expect(text).toBe('a\nb\nc\n')
    expect(eols).toEqual(['\r\n', '\n', '\r\n', ''])
  })

  it('末尾改行なしは最後の行の改行が空', () => {
    const { text, eols } = splitEols('a\r\nb')
    expect(text).toBe('a\nb')
    expect(eols).toEqual(['\r\n', ''])
  })

  it('空文字は1行の空文字として扱う', () => {
    expect(splitEols('')).toEqual({ text: '', eols: [''] })
  })

  it('末尾の連続改行をすべて保持する', () => {
    const { text, eols } = splitEols('a\n\n\n')
    expect(text).toBe('a\n\n\n')
    expect(eols).toEqual(['\n', '\n', '\n', ''])
  })

  it('eolsの長さは常に行数と一致する', () => {
    for (const raw of ['', 'a', 'a\n', 'a\r\nb', '\r\n', '\n\n', 'a\r\n\r\nb\r\n']) {
      const { text, eols } = splitEols(raw)
      expect(eols.length).toBe(text.split('\n').length)
    }
  })
})

describe('joinEols', () => {
  const samples = [
    '',
    'a',
    'a\n',
    'a\r\n',
    'a\nb\nc',
    'a\r\nb\r\nc',
    'a\r\nb\nc\r\n',
    'a\r\n\r\nb\r\n',
    '\n',
    '\r\n',
    '日本語の\r\nスライド\n本文\r\n',
    '---\r\nmarp: true\r\ntheme: gaia\r\n---\r\n\r\n# 見出し\r\n\r\n- 箇条書き\n- 二つ目',
    'a\n\n',
  ]

  for (const raw of samples) {
    it(`往復で完全一致する: ${JSON.stringify(raw)}`, () => {
      expect(roundTrip(raw)).toBe(raw)
    })
  }

  it('eolsが足りない行はファイル内で最も多い改行コードを使う', () => {
    expect(joinEols('a\nb\nc', ['\r\n', '\r\n'])).toBe('a\r\nb\r\nc')
    expect(joinEols('a\nb', [])).toBe('a\nb')
  })

  it('明示された行の改行コードを優先する', () => {
    const eols: Eol[] = ['\r\n', '\n', '']
    expect(joinEols('a\nb\nc', eols)).toBe('a\r\nb\nc')
  })
})

describe('dominantEol', () => {
  it('多い方の改行コードを返す', () => {
    expect(dominantEol(['\r\n', '\r\n', '\n', ''])).toBe('\r\n')
    expect(dominantEol(['\r\n', '\n', '\n', ''])).toBe('\n')
    expect(dominantEol([])).toBe('\n')
    expect(dominantEol([''])).toBe('\n')
  })

  it('同数のときはLF', () => {
    expect(dominantEol(['\r\n', '\n'])).toBe('\n')
  })
})
