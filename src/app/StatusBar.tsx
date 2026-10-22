import type { SaveState } from '../document'
import { strings } from './strings'

export interface StatusBarProps {
  path: string | null
  saveState: SaveState
  slideIndex: number
  slideTotal: number
  exporting: boolean
  /** 編集中の要素の種類、または読み取り専用の理由 */
  detail: string | null
}

/** ステータスバー（パス・保存状態・ページ番号・編集状態） */
export function StatusBar({ path, saveState, slideIndex, slideTotal, detail, exporting }: StatusBarProps) {
  const stateLabel = path ? strings.status.saveState[saveState] : null

  return (
    <div class="status-bar">
      <span class="status-path" title={path ?? undefined}>
        {path ?? strings.status.noFile}
      </span>
      <span class={`status-item${saveState === 'dirty' || saveState === 'conflict' ? ' status-dirty' : ''}`}>
        {stateLabel ?? '—'}
      </span>
      <span class="status-item">
        {strings.status.slideCounter(slideTotal === 0 ? 0 : slideIndex + 1, slideTotal)}
      </span>
      {exporting ? (
        <span class="status-detail" role="status" aria-live="polite">{strings.status.exporting}</span>
      ) : detail ? <span class="status-detail">{detail}</span> : null}
    </div>
  )
}
