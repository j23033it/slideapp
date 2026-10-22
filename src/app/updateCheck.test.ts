import { describe, expect, it } from 'vitest'

import type { UpdateInfo } from '../platform'
import {
  canApplyCheckResult,
  nextRequestId,
  noticeForCheckResult,
  type CheckOutcome,
} from './updateCheck'

const info: UpdateInfo = {
  version: '0.2.0',
  currentVersion: '0.1.0',
  notes: null,
  date: null,
}

describe('nextRequestId', () => {
  it('確認のたびに世代を1つ進める', () => {
    expect(nextRequestId(0)).toBe(1)
    expect(nextRequestId(1)).toBe(2)
  })
})

describe('canApplyCheckResult', () => {
  it('最新の確認が終わっていれば反映する', () => {
    expect(canApplyCheckResult({ requestId: 2, latestRequestId: 2, installing: false })).toBe(true)
  })

  it('起動時の確認が遅れて成功しても、後から始めた手動確認の結果を上書きしない', () => {
    // 起動時（1）の確認が残ったまま手動（2）が始まり、手動が先に終わったあとで起動時が完了した
    expect(canApplyCheckResult({ requestId: 1, latestRequestId: 2, installing: false })).toBe(false)
  })

  it('起動時の確認が遅れて失敗しても、新しい確認の結果を上書きしない', () => {
    expect(canApplyCheckResult({ requestId: 1, latestRequestId: 2, installing: false })).toBe(false)
  })

  it('インストールが始まったあとは、最新の確認が完了しても反映しない', () => {
    expect(canApplyCheckResult({ requestId: 2, latestRequestId: 2, installing: true })).toBe(false)
  })

  it('インストール中に起動時の確認が遅れて失敗しても、インストール中の表示を壊さない', () => {
    expect(canApplyCheckResult({ requestId: 1, latestRequestId: 2, installing: true })).toBe(false)
  })

  it('インストールが失敗して終わったあとでも、古い確認の結果は反映しない', () => {
    expect(canApplyCheckResult({ requestId: 1, latestRequestId: 2, installing: false })).toBe(false)
  })
})

describe('noticeForCheckResult', () => {
  it('新しい版があれば「更新あり」にする', () => {
    expect(noticeForCheckResult({ status: 'ok', info }, false)).toEqual({
      kind: 'available',
      info,
    })
  })

  it('新しい版がなければ帯を消す', () => {
    expect(noticeForCheckResult({ status: 'ok', info: null }, true)).toEqual({ kind: 'none' })
  })

  it('手動確認の失敗はエラーとして再試行できるようにする', () => {
    const outcome: CheckOutcome = { status: 'error', message: '更新に失敗しました: timeout' }
    expect(noticeForCheckResult(outcome, true)).toEqual({
      kind: 'error',
      message: '更新に失敗しました: timeout',
      retry: 'check',
      info: null,
    })
  })

  it('起動時の確認失敗は帯を出さない', () => {
    const outcome: CheckOutcome = { status: 'error', message: '更新に失敗しました: timeout' }
    expect(noticeForCheckResult(outcome, false)).toEqual({ kind: 'none' })
  })
})
