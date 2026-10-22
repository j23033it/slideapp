import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { platform, type UpdateInfo, type UpdateProgress } from '../platform'
import { progressFrom } from '../platform/progress'
import { strings } from './strings'
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
  checkOnStartup?: boolean | null
  /** インストール前の確認。false なら更新帯を維持して処理を中止する */
  beforeInstall: () => Promise<boolean>
  /** インストール処理が失敗し、アプリが続行できるときに呼ばれる */
  onInstallFailure?: () => void
  /** 「後で」「閉じる」で帯を閉じたときに呼ばれる */
  onDismiss?: () => void
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return strings.update.unknownError
}

function percentOf(progress: UpdateProgress): number | null {
  return progress.ratio === null ? null : Math.floor(progress.ratio * 100)
}

/**
 * 新しい版があるときにツールバーの下へ帯を出す。
 * 起動時の確認は `checkOnStartup` で切り替え、手動確認は `UPDATE_CHECK_EVENT` で受ける。
 */
export function UpdateNotice({ checkOnStartup, beforeInstall, onInstallFailure, onDismiss }: UpdateNoticeProps) {
  const [notice, setNotice] = useState<Notice>({ kind: 'none' })
  const mounted = useRef(true)
  const startupCheckStarted = useRef(false)
  /** ダウンロード・インストール中は、別の確認で表示を上書きしない */
  const installing = useRef(false)
  /** 確認画面が開いている間の二重クリックも抑止する */
  const installRequested = useRef(false)
  /** 最後に始めた確認の世代。古い確認の結果を捨てるために使う */
  const checkRequest = useRef(0)

  /**
   * 更新を確認する。完了時には世代とインストール開始を確かめ、古い結果は捨てる。
   * `apply` が false のときは帯へ反映せず、結果だけを返す（インストールの再試行用）。
   */
  const check = useCallback(async (manual: boolean, apply = true): Promise<CheckOutcome> => {
    if (installing.current || installRequested.current) return { status: 'stale' }

    const requestId = nextRequestId(checkRequest.current)
    checkRequest.current = requestId
    if (manual) setNotice({ kind: 'checking' })

    let outcome: CheckResult
    try {
      outcome = { status: 'ok', info: await platform.checkForUpdate() }
    } catch (error) {
      outcome = { status: 'error', message: strings.update.failed(errorMessage(error)) }
      if (!manual) console.warn('update check failed', error)
    }

    if (
      !mounted.current ||
      !canApplyCheckResult({
        requestId,
        latestRequestId: checkRequest.current,
        installing: installing.current || installRequested.current,
      })
    ) {
      // 新しい確認に追い越された、またはインストールが始まったあとの結果
      return { status: 'stale' }
    }

    if (apply) setNotice(noticeForCheckResult(outcome, manual))
    return outcome
  }, [])

  const install = useCallback(async (info: UpdateInfo) => {
    if (installing.current || installRequested.current) return
    installRequested.current = true
    let approved: boolean
    try {
      approved = await beforeInstall()
    } catch (error) {
      installRequested.current = false
      onInstallFailure?.()
      console.warn('update pre-install check failed', error)
      return
    }
    if (!approved || !mounted.current) {
      installRequested.current = false
      return
    }
    installing.current = true
    installRequested.current = false
    // 進行中の確認があとから完了しても、インストール中の表示を壊さないようにする
    checkRequest.current = nextRequestId(checkRequest.current)
    setNotice({ kind: 'downloading', info, progress: progressFrom(0, null) })

    try {
      await platform.downloadAndInstall((progress) => {
        if (mounted.current) setNotice({ kind: 'downloading', info, progress })
      })
    } catch (error) {
      installing.current = false
      onInstallFailure?.()
      if (!mounted.current) return
      setNotice({
        kind: 'error',
        message: strings.update.failed(errorMessage(error)),
        retry: 'install',
        info,
      })
      return
    }

    if (!mounted.current) return
    setNotice({ kind: 'installing', info })

    try {
      await platform.relaunch()
    } catch (error) {
      installing.current = false
      onInstallFailure?.()
      if (!mounted.current) return
      console.warn('relaunch failed', error)
      setNotice({ kind: 'error', message: strings.update.restartFailed, retry: 'install', info })
    }
  }, [beforeInstall, onInstallFailure])

  // 手動確認のイベント
  useEffect(() => {
    mounted.current = true
    const onRequest = () => {
      void check(true)
    }
    window.addEventListener(UPDATE_CHECK_EVENT, onRequest)

    return () => {
      mounted.current = false
      window.removeEventListener(UPDATE_CHECK_EVENT, onRequest)
    }
  }, [check])

  // 設定読込後に起動時確認を一度だけ判断する。null は設定読込中。
  useEffect(() => {
    if (checkOnStartup === null || startupCheckStarted.current) return
    startupCheckStarted.current = true
    if (checkOnStartup !== false) void check(false)
  }, [check, checkOnStartup])

  const dismiss = useCallback(() => {
    if (installing.current || installRequested.current) return
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
        setNotice({
          kind: 'error',
          message: strings.update.failed(strings.update.noUpdate),
          retry: 'check',
          info: null,
        })
      }
      return
    }

    await check(true)
  }, [check, install, notice])

  switch (notice.kind) {
    case 'checking':
      return (
        <div class="banner" role="status">
          <span class="banner-message">{strings.update.checking}</span>
        </div>
      )

    case 'available':
      return (
        <div class="banner" role="status">
          <span class="banner-message">{strings.update.available(notice.info.version)}</span>
          <button type="button" onClick={() => void install(notice.info)}>
            {strings.update.install}
          </button>
          <button type="button" onClick={dismiss}>
            {strings.update.later}
          </button>
        </div>
      )

    case 'downloading': {
      const percent = percentOf(notice.progress)
      return (
        <div class="banner" role="status">
          <span class="banner-message">
            {strings.update.downloading(notice.info.version)}{' '}
            {percent === null ? strings.update.progressUnknown : strings.update.progress(percent)}
          </span>
          {percent === null ? (
            <progress aria-label={strings.update.progressLabel} style={{ width: '160px' }} />
          ) : (
            <progress
              aria-label={strings.update.progressLabel}
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
          <span class="banner-message">{strings.update.installing}</span>
        </div>
      )

    case 'error':
      return (
        <div class="banner" data-tone="error" role="alert">
          <span class="banner-message">{notice.message}</span>
          <button type="button" onClick={() => void retry()}>
            {strings.update.retry}
          </button>
          <button type="button" onClick={dismiss}>
            {strings.update.dismiss}
          </button>
        </div>
      )

    case 'none':
      return null
  }
}
