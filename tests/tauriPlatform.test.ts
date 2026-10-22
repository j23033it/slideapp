import { describe, expect, it } from 'vitest'

import { toSaveOutcome } from '../src/platform/tauri'

describe('toSaveOutcome', () => {
  it('Rustからの構造化された名前衝突を文言に依存せず判別する', () => {
    expect(toSaveOutcome({ kind: 'exists' })).toEqual({ ok: false, kind: 'exists' })
    expect(toSaveOutcome({ kind: 'io', message: 'ファイルがあります。 (os error 80)' })).toEqual({
      ok: false,
      kind: 'io',
      message: 'ファイルがあります。 (os error 80)',
    })
  })
})
