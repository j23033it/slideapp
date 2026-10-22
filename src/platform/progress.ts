import type { UpdateProgress } from './types'

/**
 * ダウンロード済みのバイト数から、表示用の進捗を作る。
 * 全体の大きさが分からない（サーバーが Content-Length を返さない）ときは ratio を null にする。
 */
export function progressFrom(downloaded: number, total: number | null): UpdateProgress {
  const bytes = Number.isFinite(downloaded) && downloaded > 0 ? Math.floor(downloaded) : 0

  if (total === null || !Number.isFinite(total) || total <= 0) {
    return { downloaded: bytes, total: null, ratio: null }
  }

  const length = Math.floor(total)
  return {
    downloaded: Math.min(bytes, length),
    total: length,
    ratio: Math.min(1, bytes / length),
  }
}
