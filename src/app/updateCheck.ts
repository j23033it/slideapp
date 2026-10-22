import type { UpdateInfo, UpdateProgress } from '../platform'

/** 帯に出す状態。`UpdateNotice` だけが使う */
export type Notice =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'downloading'; info: UpdateInfo; progress: UpdateProgress }
  | { kind: 'installing'; info: UpdateInfo }
  | { kind: 'error'; message: string; retry: 'check' | 'install'; info: UpdateInfo | null }

/** 確認1回分の結果。失敗の文言は表示できる形に整えておく */
export type CheckResult =
  | { status: 'ok'; info: UpdateInfo | null }
  | { status: 'error'; message: string }

/** 確認1回分の結果。`stale` は古い、またはインストール開始後のため画面へ反映しなかった */
export type CheckOutcome = CheckResult | { status: 'stale' }

/** 確認要求の世代を1つ進める */
export function nextRequestId(current: number): number {
  return current + 1
}

/**
 * 完了した確認の結果を画面へ反映してよいか。
 * 新しい確認が始まっていれば古い結果を、インストールが始まっていればすべての結果を捨てる。
 */
export function canApplyCheckResult(input: {
  /** 完了した確認の世代 */
  requestId: number
  /** いま最新の確認の世代 */
  latestRequestId: number
  /** ダウンロード・インストールが始まっているか */
  installing: boolean
}): boolean {
  return !input.installing && input.requestId === input.latestRequestId
}

/** 反映してよい確認結果から、帯の表示を決める。起動時の確認失敗は黙って諦める */
export function noticeForCheckResult(outcome: CheckResult, manual: boolean): Notice {
  if (outcome.status === 'ok') {
    return outcome.info ? { kind: 'available', info: outcome.info } : { kind: 'none' }
  }
  if (manual) {
    return { kind: 'error', message: outcome.message, retry: 'check', info: null }
  }
  return { kind: 'none' }
}
