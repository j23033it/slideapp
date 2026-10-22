/**
 * ランの境界での Backspace / Delete を、隣のランへの1文字削除として組み立てる。
 * DOMに触れない純粋関数。
 */
import type { Analysis, Run } from '../editing'

export type DeletionDirection = 'backward' | 'forward'

export type BoundaryDeletion =
  /** 境界ではない。ブラウザの通常の削除に任せる */
  | { kind: 'none' }
  /** 隣が編集可能なランではない。理由を出して拒否する */
  | { kind: 'reject' }
  /** 隣のランから1文字削除する */
  | { kind: 'delete'; run: Run; text: string; offset: number }

/** コードポイント単位で1文字を取り除く（サロゲートペアを割らない） */
function removeFirst(text: string): string {
  return [...text].slice(1).join('')
}

function removeLast(text: string): string {
  return [...text].slice(0, -1).join('')
}

/**
 * キャレットがランの端にあるときだけ、隣のランへの削除を計画する。
 * - Backspace: 前のランの最後の1文字を削除し、そのランの末尾へカーソルを置く
 * - Delete: 次のランの最初の1文字を削除し、そのランの先頭へカーソルを置く
 */
export function planBoundaryDeletion(
  analysis: Analysis,
  run: Run,
  offset: number,
  direction: DeletionDirection,
): BoundaryDeletion {
  const atBoundary = direction === 'backward' ? offset === 0 : offset === run.text.length
  if (!atBoundary) return { kind: 'none' }

  const block = analysis.blocks.find((entry) => entry.id === run.blockId)
  const order = block?.runs ?? analysis.runs.filter((entry) => entry.blockId === run.blockId).map((entry) => entry.id)
  const index = order.indexOf(run.id)
  const neighborId = index < 0 ? undefined : order[index + (direction === 'backward' ? -1 : 1)]
  const neighbor = neighborId === undefined ? undefined : analysis.runs.find((entry) => entry.id === neighborId)
  if (!neighbor || !neighbor.editable || neighbor.text.length === 0) return { kind: 'reject' }

  const text = direction === 'backward' ? removeLast(neighbor.text) : removeFirst(neighbor.text)
  const nextOffset = direction === 'backward' ? text.length : 0
  return { kind: 'delete', run: neighbor, text, offset: nextOffset }
}
