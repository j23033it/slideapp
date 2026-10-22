import { basename, dirname } from '../platform/paths'
import { strings } from './strings'

export interface EmptyStateProps {
  recent: string[]
  busy: boolean
  onOpen: () => void
  onOpenRecent: (path: string) => void
}

/** ファイル未選択時の中央表示（開くボタンと最近使ったファイル） */
export function EmptyState({ recent, busy, onOpen, onOpenRecent }: EmptyStateProps) {
  return (
    <div class="empty-state">
      <button type="button" class="empty-open-button" onClick={onOpen} disabled={busy}>
        {strings.stage.openFile}
      </button>
      <div class="empty-hint">{strings.stage.dropHint}</div>

      <div class="recent">
        <div class="recent-title">{strings.stage.recentFiles}</div>
        {recent.length === 0 ? (
          <div class="recent-empty">{strings.stage.noRecentFiles}</div>
        ) : (
          <ul class="recent-list">
            {recent.map((path) => (
              <li key={path}>
                <button
                  type="button"
                  class="recent-item"
                  title={path}
                  onClick={() => onOpenRecent(path)}
                  disabled={busy}
                >
                  <span class="recent-item-name">{basename(path)}</span>
                  <span class="recent-item-path">{dirname(path)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
