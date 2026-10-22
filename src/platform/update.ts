import { relaunch as tauriRelaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'

import { progressFrom } from './progress'
import type { UpdateInfo, UpdateProgress } from './types'

/**
 * `checkForUpdate` で見つけた更新。`downloadAndInstall` はこのインスタンスを使う。
 * Rust側のリソースを握っているため、使わないと決まったら close する。
 */
let pending: Update | null = null

/** 確認済みの更新を捨てる（リソースを解放する）。 */
function discardPending(): void {
  const update = pending
  pending = null
  if (update) {
    void update.close().catch(() => {
      // 解放に失敗しても致命的ではない。次の確認で新しいリソースを取る。
    })
  }
}

/** 更新を確認する。新しい版がなければ null。 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  discardPending()

  const update = await check()
  if (!update) return null

  pending = update
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body ?? null,
    date: update.date ?? null,
  }
}

/**
 * 確認済みの更新をダウンロードしてインストールする。
 * Windowsではインストーラーの起動後にアプリが終了するため、戻ってこないことがある。
 */
export async function downloadAndInstall(
  onProgress: (progress: UpdateProgress) => void,
): Promise<void> {
  const update = pending
  if (!update) {
    throw new Error('更新情報がありません。先に更新を確認してください。')
  }

  pending = null

  let downloaded = 0
  let total: number | null = null

  onProgress(progressFrom(downloaded, total))

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case 'Started':
        total = event.data.contentLength ?? null
        onProgress(progressFrom(downloaded, total))
        break
      case 'Progress':
        downloaded += event.data.chunkLength
        onProgress(progressFrom(downloaded, total))
        break
      case 'Finished':
        onProgress(progressFrom(total ?? downloaded, total ?? downloaded))
        break
    }
  })
}

/** アプリを再起動する。 */
export async function relaunch(): Promise<void> {
  await tauriRelaunch()
}
