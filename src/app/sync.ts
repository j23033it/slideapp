/**
 * 外部変更の判断と、競合の帯で選んだ結果の計画。
 * DOMにもTauriにも触れない純粋関数だけを置き、Vitestで固定する。
 */
import { basename, dirname } from '../platform/paths'

export type ExternalChange =
  | { type: 'changed'; path: string; text: string; hasBom: boolean; hash: string; mtime: number }
  | { type: 'removed'; path: string }
  | { type: 'unreadable'; path: string; message: string }

export interface SyncState {
  path: string
  /** 未保存の変更があるか（conflict / readonly も含めて clean 以外） */
  dirty: boolean
  /** 現在の画面の内容（`DocumentModel.serialize()`） */
  currentText: string
  /** 最後に読んだ・保存した時点のディスクのハッシュ */
  diskHash: string
}

export type SyncDecision =
  | { type: 'ignore' }
  /** ディスクの内容が画面と同じ。再描画せずハッシュだけ更新する */
  | { type: 'synced'; hasBom: boolean; hash: string }
  | { type: 'reload'; text: string; hasBom: boolean; hash: string }
  | { type: 'conflict'; text: string; hasBom: boolean; hash: string }
  | { type: 'removed' }
  | { type: 'unreadable'; message: string }

/** 監視イベントを受けたときの分岐（設計4.3 / 9.2） */
export function decideExternalChange(state: SyncState, change: ExternalChange): SyncDecision {
  if (change.type === 'removed') return { type: 'removed' }
  if (change.type === 'unreadable') return { type: 'unreadable', message: change.message }
  if (change.path !== state.path) return { type: 'ignore' }
  // ハッシュが同じなら、ディスクの内容は最後に読んだ時点のまま。
  if (change.hash === state.diskHash) return { type: 'ignore' }
  if (state.dirty) {
    return { type: 'conflict', text: change.text, hasBom: change.hasBom, hash: change.hash }
  }
  if (change.text === state.currentText) {
    return { type: 'synced', hasBom: change.hasBom, hash: change.hash }
  }
  return { type: 'reload', text: change.text, hasBom: change.hasBom, hash: change.hash }
}

/** 帯の選択肢 */
export type ConflictChoice = 'load-disk' | 'overwrite' | 'save-mine'

export interface ConflictTarget {
  /** 帯を出した時点のディスクのハッシュ */
  hash: string
}

export interface ConflictPlan {
  /** ディスクの内容を読み込み直す */
  reloadDisk: boolean
  /** 自分の変更で上書き保存する。期待値は最新のディスクのハッシュ */
  save?: { expectedHash: string }
  /** 読み込み直す前に `<名前>.mine.md` へ退避する */
  writeMineCopy: boolean
}

/** 帯で選んだ結果、実際に何をするか */
export function planConflictChoice(choice: ConflictChoice, conflict: ConflictTarget): ConflictPlan {
  switch (choice) {
    case 'load-disk':
      return { reloadDisk: true, writeMineCopy: false }
    case 'overwrite':
      return { reloadDisk: false, writeMineCopy: false, save: { expectedHash: conflict.hash } }
    case 'save-mine':
      return { reloadDisk: true, writeMineCopy: true }
  }
}

/** 再読み込み後も同じスライド番号を表示する。減った場合は最後 */
export function slideAfterReload(current: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(Math.max(0, current), total - 1)
}

/**
 * 比較用の別名。`deck.md` → `deck.mine.md`、`deck.mine.md` が存在すれば `deck.mine-2.md`。
 * `attempt` は 0 始まり。
 */
export function mineFileName(path: string, attempt: number): string {
  const name = basename(path)
  const stem = name.replace(/\.(md|markdown)$/i, '')
  const suffix = attempt <= 0 ? '.mine.md' : `.mine-${attempt + 1}.md`
  const directory = dirname(path)
  return directory ? `${directory}\\${stem}${suffix}` : `${stem}${suffix}`
}

/** 別名の作成が「既に存在する」で失敗したか（次の候補へ進む判断） */
export function isNameTakenError(error: unknown): boolean {
  const message =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message: unknown }).message)
          : ''
  return /exists|already|exist|存在|上書きできない/i.test(message)
}
