import { strings } from './strings'

export interface StatusBarProps {
  path: string | null
  dirty: boolean
  slideIndex: number
  slideTotal: number
}

/** ステータスバー（パス・保存状態・ページ番号） */
export function StatusBar({ path, dirty, slideIndex, slideTotal }: StatusBarProps) {
  return (
    <div class="status-bar">
      <span class="status-path" title={path ?? undefined}>
        {path ?? strings.status.noFile}
      </span>
      <span class={`status-item${dirty ? ' status-dirty' : ''}`}>
        {path ? (dirty ? strings.status.unsaved : strings.status.saved) : '—'}
      </span>
      <span class="status-item">
        {strings.status.slideCounter(slideTotal === 0 ? 0 : slideIndex + 1, slideTotal)}
      </span>
    </div>
  )
}
