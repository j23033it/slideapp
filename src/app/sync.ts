/**
 * 外部変更の判断と、競合の帯で選んだ結果の計画。
 * DOMにもTauriにも触れない純粋関数だけを置き、Vitestで固定する。
 */
import type { SaveState } from '../document'
import { basename, dirname } from '../platform/paths'

export type ExternalChange =
  | { type: 'changed'; path: string; text: string; hasBom: boolean; hash: string; mtime: number }
  | { type: 'removed'; path: string }
  | { type: 'unreadable'; path: string; message: string }

export interface SyncState {
  path: string
  /** 未保存の変更があるか（conflict / readonly も含めて clean 以外） */
  dirty: boolean
  /** 競合の帯を表示中か。同じハッシュの通知でも帯を最新にする */
  conflict: boolean
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
  // 競合中は同じハッシュでも帯の本文を最新にする（ディスクが元の内容へ戻った場合も含む）。
  if (change.hash === state.diskHash && !state.conflict) return { type: 'ignore' }
  if (state.dirty || state.conflict) {
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

/** 読み込み結果1回分の値。本文・BOM・ハッシュを混ぜずに使う */
export interface DiskSnapshot {
  text: string
  hasBom: boolean
  hash: string
}

/** 保存・読み込み処理を始めた時点の本文とBOM。 */
export interface ContentSnapshot {
  text: string
  hasBom: boolean
}

export function sameContentSnapshot(left: ContentSnapshot, right: ContentSnapshot): boolean {
  return left.text === right.text && left.hasBom === right.hasBom
}

/**
 * 保存が終わったときの扱い。開始時の内容から変わっていれば、
 * 後続の入力を保存済みにせず、ディスクのハッシュだけを進める。
 */
export interface SaveCompletion {
  /** `DocumentModel.markSaved` を呼んでよいか */
  markSaved: boolean
  /** ディスクに書き込んだ保存済み基準 */
  savedSnapshot: ContentSnapshot
  /** 保存後のディスクのハッシュ */
  diskHash: string
}

export function planSaveCompletion(
  snapshot: ContentSnapshot,
  current: ContentSnapshot,
  diskHash: string,
): SaveCompletion {
  return { markSaved: sameContentSnapshot(snapshot, current), savedSnapshot: snapshot, diskHash }
}

/** Appのセッションに保存済み基準を保持するときの表示状態を決める。 */
export function saveStateFromSnapshot(
  current: ContentSnapshot,
  saved: ContentSnapshot,
  readonly: boolean,
  conflict: boolean,
): SaveState {
  if (readonly) return 'readonly'
  if (conflict) return 'conflict'
  return sameContentSnapshot(current, saved) ? 'clean' : 'dirty'
}

/** 置き換え・再読み込みの前に確認が要る状態か（読み取り専用は未保存の変更ではない） */
export function hasUnsavedChanges(state: SaveState): boolean {
  return state === 'dirty' || state === 'conflict'
}

export interface OpenRecheck {
  /** 読み込みを始めた時点の本文とBOM（開いていなければ null） */
  snapshot: ContentSnapshot | null
  /** 現在の本文とBOM */
  current: ContentSnapshot | null
  /** 現在の保存状態 */
  state: SaveState
  /** 未保存の変更を破棄すると利用者が確認済みか */
  allowDirty: boolean
}

/** 読み込みの待機中に編集があった場合、置き換えの前に未保存確認をやり直す */
export function needsOpenReconfirm({ snapshot, current, state, allowDirty }: OpenRecheck): boolean {
  if (snapshot === null || current === null) {
    if (snapshot !== current) return true
  } else if (!sameContentSnapshot(snapshot, current)) {
    return true
  }
  return hasUnsavedChanges(state) && !allowDirty
}

/** 別名保存の待機中に内容が変わっていなければ、ディスクを読み込み直してよい */
export function planMineCopyReload(snapshot: ContentSnapshot, current: ContentSnapshot): boolean {
  return sameContentSnapshot(snapshot, current)
}

/** 競合の帯に出す値。読み込み結果が無ければ読み取り不能として扱う */
export function planConflictBanner(
  disk: DiskSnapshot | null,
): { kind: 'conflict'; text: string; hasBom: boolean; hash: string } | { kind: 'unreadable' } {
  if (!disk) return { kind: 'unreadable' }
  return { kind: 'conflict', text: disk.text, hasBom: disk.hasBom, hash: disk.hash }
}

/** 帯を出した時点からディスクの内容が変わったか（上書き保存の前に確かめる） */
export function diskChangedSinceBanner(fresh: DiskSnapshot, banner: DiskSnapshot): boolean {
  return fresh.hash !== banner.hash
}
