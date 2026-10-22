import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { platform, type UpdateInfo, type UpdateProgress } from '../platform'
import { progressFrom } from '../platform/progress'

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

type Notice =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'downloading'; info: UpdateInfo; progress: UpdateProgress }
  | { kind: 'installing'; info: UpdateInfo }
  | { kind: 'error'; message: string; retry: 'check' | 'install'; info: UpdateInfo | null }

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

  const check = useCallback(async (manual: boolean) => {
    if (installing.current) return
    if (manual) setNotice({ kind: 'checking' })

    try {
      const info = await platform.checkForUpdate()
      if (!mounted.current) return
      setNotice(info ? { kind: 'available', info } : { kind: 'none' })
    } catch (error) {
      if (!mounted.current) return
      if (manual) {
        setNotice({ kind: 'error', message: text.failed(errorMessage(error)), retry: 'check', info: null })
      } else {
        // 起動時の確認失敗は黙って諦める（オフラインでも通常の利用を妨げない）
        console.warn('update check failed', error)
        setNotice({ kind: 'none' })
      }
    }
  }, [])

  const install = useCallback(async (info: UpdateInfo) => {
    if (installing.current) return
    installing.current = true
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
      setNotice({ kind: 'checking' })
      try {
        const info = await platform.checkForUpdate()
        if (!mounted.current) return
        if (info) {
          await install(info)
        } else {
          setNotice({ kind: 'error', message: text.failed(text.noUpdate), retry: 'check', info: null })
        }
      } catch (error) {
        if (!mounted.current) return
        setNotice({ kind: 'error', message: text.failed(errorMessage(error)), retry: 'check', info: null })
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
