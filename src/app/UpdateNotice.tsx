import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { platform, type UpdateInfo, type UpdateProgress } from '../platform'
import { progressFrom } from '../platform/progress'
import {
  canApplyCheckResult,
  nextRequestId,
  noticeForCheckResult,
  type CheckOutcome,
  type CheckResult,
  type Notice,
} from './updateCheck'

/** ツールバーなどから手動で確認するとき、window にこのイベントを投げる */
export const UPDATE_CHECK_EVENT = 'slideapp:check-update'

export interface UpdateNoticeProps {
  /**
   * 起動時に更新を確認するか。設定 `checkUpdatesOnStartup`（既定 true）を渡す。
   * 省略した場合は確認する。
   */
  checkOnStartup?: boolean
  /** 「後で」「閉じる」で帯を閉じたときに呼ばれる */
  onDismiss?: () => void
}

/** この部品だけで使う文言。アプリ共通の strings とは独立させている */
const text = {
  available: (version: string) => `v${version} があります`,
  install: '更新して再起動',
  later: '後で',
  checking: '更新を確認しています…',
  downloading: (version: string) => `v${version} をダウンロードしています…`,
  progressUnknown: 'ダウンロード中…',
  progress: (percent: number) => `${percent}%`,
  progressLabel: '更新のダウンロード進捗',
  installing: 'インストールしています…アプリを再起動します',
  failed: (message: string) => `更新に失敗しました: ${message}`,
  restartFailed: '更新はインストールされました。アプリを手動で再起動してください。',
  noUpdate: '配布されている更新が見つかりませんでした',
  retry: '再試行',
  dismiss: '閉じる',
  unknownError: '不明なエラー',
} as const

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return text.unknownError
}

function percentOf(progress: UpdateProgress): number | null {
  return progress.ratio === null ? null : Math.floor(progress.ratio * 100)
}

/**
 * 新しい版があるときにツールバーの下へ帯を出す。
 * 起動時の確認は `checkOnStartup` で切り替え、手動確認は `UPDATE_CHECK_EVENT` で受ける。
 */
export function UpdateNotice({ checkOnStartup, onDismiss }: UpdateNoticeProps) {
  const [notice, setNotice] = useState<Notice>({ kind: 'none' })
  const mounted = useRef(true)
  /** ダウンロード・インストール中は、別の確認で表示を上書きしない */
  const installing = useRef(false)
  /** 最後に始めた確認の世代。古い確認の結果を捨てるために使う */
  const checkRequest = useRef(0)

  /**
   * 更新を確認する。完了時には世代とインストール開始を確かめ、古い結果は捨てる。
   * `apply` が false のときは帯へ反映せず、結果だけを返す（インストールの再試行用）。
   */
  const check = useCallback(async (manual: boolean, apply = true): Promise<CheckOutcome> => {
    if (installing.current) return { status: 'stale' }

    const requestId = nextRequestId(checkRequest.current)
    checkRequest.current = requestId
    if (manual) setNotice({ kind: 'checking' })

    let outcome: CheckResult
    try {
      outcome = { status: 'ok', info: await platform.checkForUpdate() }
    } catch (error) {
      outcome = { status: 'error', message: text.failed(errorMessage(error)) }
      if (!manual) console.warn('update check failed', error)
    }

    if (
      !mounted.current ||
      !canApplyCheckResult({
        requestId,
        latestRequestId: checkRequest.current,
        installing: installing.current,
      })
    ) {
      // 新しい確認に追い越された、またはインストールが始まったあとの結果
      return { status: 'stale' }
    }

    if (apply) setNotice(noticeForCheckResult(outcome, manual))
    return outcome
  }, [])

  const install = useCallback(async (info: UpdateInfo) => {
    if (installing.current) return
    installing.current = true
    // 進行中の確認があとから完了しても、インストール中の表示を壊さないようにする
    checkRequest.current = nextRequestId(checkRequest.current)
    setNotice({ kind: 'downloading', info, progress: progressFrom(0, null) })

    try {
      await platform.downloadAndInstall((progress) => {
        if (mounted.current) setNotice({ kind: 'downloading', info, progress })
      })
    } catch (error) {
      installing.current = false
      if (!mounted.current) return
      setNotice({ kind: 'error', message: text.failed(errorMessage(error)), retry: 'install', info })
      return
    }

    if (!mounted.current) return
    setNotice({ kind: 'installing', info })

    try {
      await platform.relaunch()
    } catch (error) {
      installing.current = false
      if (!mounted.current) return
      console.warn('relaunch failed', error)
      setNotice({ kind: 'error', message: text.restartFailed, retry: 'install', info })
    }
  }, [])

  // 起動時の確認と、手動確認のイベント
  useEffect(() => {
    mounted.current = true
    if (checkOnStartup !== false) void check(false)

    const onRequest = () => {
      void check(true)
    }
    window.addEventListener(UPDATE_CHECK_EVENT, onRequest)

    return () => {
      mounted.current = false
      window.removeEventListener(UPDATE_CHECK_EVENT, onRequest)
    }
  }, [check, checkOnStartup])

  const dismiss = useCallback(() => {
    setNotice({ kind: 'none' })
    onDismiss?.()
  }, [onDismiss])

  const retry = useCallback(async () => {
    if (notice.kind !== 'error') return

    if (notice.retry === 'install') {
      // 失敗した更新は破棄済みなので、確認からやり直してから入れ直す
      const outcome = await check(true, false)
      if (!mounted.current || outcome.status === 'stale') return
      if (outcome.status === 'error') {
        setNotice({ kind: 'error', message: outcome.message, retry: 'check', info: null })
        return
      }
      if (outcome.info) {
        await install(outcome.info)
      } else {
        setNotice({ kind: 'error', message: text.failed(text.noUpdate), retry: 'check', info: null })
      }
      return
    }

    await check(true)
  }, [check, install, notice])

  switch (notice.kind) {
    case 'checking':
      return (
        <div class="banner" role="status">
          <span class="banner-message">{text.checking}</span>
        </div>
      )

    case 'available':
      return (
        <div class="banner" role="status">
          <span class="banner-message">{text.available(notice.info.version)}</span>
          <button type="button" onClick={() => void install(notice.info)}>
            {text.install}
          </button>
          <button type="button" onClick={dismiss}>
            {text.later}
          </button>
        </div>
      )

    case 'downloading': {
      const percent = percentOf(notice.progress)
      return (
        <div class="banner" role="status">
          <span class="banner-message">
            {text.downloading(notice.info.version)}{' '}
            {percent === null ? text.progressUnknown : text.progress(percent)}
          </span>
          {percent === null ? (
            <progress aria-label={text.progressLabel} style={{ width: '160px' }} />
          ) : (
            <progress
              aria-label={text.progressLabel}
              max={100}
              value={percent}
              style={{ width: '160px' }}
            />
          )}
        </div>
      )
    }

    case 'installing':
      return (
        <div class="banner" role="status">
          <span class="banner-message">{text.installing}</span>
        </div>
      )

    case 'error':
      return (
        <div class="banner" data-tone="error" role="alert">
          <span class="banner-message">{notice.message}</span>
          <button type="button" onClick={() => void retry()}>
            {text.retry}
          </button>
          <button type="button" onClick={dismiss}>
            {text.dismiss}
          </button>
        </div>
      )

    case 'none':
      return null
  }
}
