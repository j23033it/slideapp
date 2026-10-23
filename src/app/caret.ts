/**
 * Shadow DOM内のクリック位置からキャレットを求めるためのDOM補助。
 * 位置はブラウザの当たり判定で決め、文字列検索はしない。
 */

import { selectionFor } from '../editing/dom/selection'

type DocumentWithCaret = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
    options?: { shadowRoots?: readonly ShadowRoot[] },
  ) => CaretPosition | null
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

export interface RunSelectionPoint {
  runId: string
  offset: number
  collapsed: boolean
}

export function runElementOf(node: Node | null): HTMLElement | null {
  const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement
  return element?.closest<HTMLElement>('[data-sm-run]') ?? null
}

/** `(node, offset)` がランの中の何文字目かを返す */
export function offsetInRun(run: HTMLElement, node: Node | null, offset: number): number | null {
  if (!node || !run.contains(node)) return null
  const range = run.ownerDocument.createRange()
  try {
    range.selectNodeContents(run)
    range.setEnd(node, offset)
  } catch {
    return null
  }
  return range.toString().length
}

/** ランの表示文字列上の位置を、テキストノードの位置へ変換する */
export function pointInRun(run: HTMLElement, offset: number): { node: Node; offset: number } | null {
  const doc = run.ownerDocument
  const walker = doc.createTreeWalker(run, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, offset)
  let last: Node | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) return { node, offset: remaining }
    remaining -= length
    last = node
  }
  if (last) return { node: last, offset: last.textContent?.length ?? 0 }
  return run.firstChild ? { node: run.firstChild, offset: 0 } : { node: run, offset: 0 }
}

/**
 * クリック位置のキャレット。`caretPositionFromPoint` の shadowRoots 対応を優先し、
 * 無ければ `caretRangeFromPoint` を使う。
 */
export function caretFromPoint(
  root: ShadowRoot,
  x: number,
  y: number,
): { node: Node; offset: number } | null {
  const doc = root.ownerDocument as DocumentWithCaret
  if (typeof doc.caretPositionFromPoint === 'function') {
    try {
      const position = doc.caretPositionFromPoint(x, y, { shadowRoots: [root] })
      if (position) return { node: position.offsetNode, offset: position.offset }
    } catch {
      // 古い実装は第3引数を受け付けない。次の方法へ。
    }
    try {
      const position = doc.caretPositionFromPoint(x, y)
      if (position) return { node: position.offsetNode, offset: position.offset }
    } catch {
      // 下の caretRangeFromPoint へ。
    }
  }
  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y)
    if (range) return { node: range.startContainer, offset: range.startOffset }
  }
  return null
}

/** 文字の矩形を総当たりし、(x, y) に最も近いキャレット位置を求める（フォールバック） */
function nearestOffsetInRun(run: HTMLElement, x: number, y: number): { node: Node; offset: number } | null {
  const doc = run.ownerDocument
  const walker = doc.createTreeWalker(run, NodeFilter.SHOW_TEXT)
  const range = doc.createRange()
  let best: { node: Node; offset: number; distance: number } | null = null
  let fallback: Node | null = null

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    fallback = node
    const text = node.textContent ?? ''
    for (let index = 0; index < text.length; index += 1) {
      range.setStart(node, index)
      range.setEnd(node, Math.min(text.length, index + 1))
      const rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0
      const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
      const distance = dx * dx + dy * dy
      if (!best || distance < best.distance) {
        const after = x > rect.left + rect.width / 2
        best = { node, offset: index + (after ? 1 : 0), distance }
      }
    }
  }

  if (best) return { node: best.node, offset: best.offset }
  if (fallback) return { node: fallback, offset: fallback.textContent?.length ?? 0 }
  return null
}

/** クリック位置に対応する、ラン内のキャレット位置 */
export function caretInRun(run: HTMLElement, x: number, y: number, root: ShadowRoot): { node: Node; offset: number } | null {
  const point = caretFromPoint(root, x, y)
  if (point && run.contains(point.node)) {
    return point
  }
  return nearestOffsetInRun(run, x, y)
}

/** 現在の選択が1つのランの中だけにあるか */
export function selectionInRun(root: ShadowRoot, run: HTMLElement): RunSelectionPoint | null {
  const selection = selectionFor(root)
  if (!selection || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  const start = runElementOf(range.startContainer)
  const end = runElementOf(range.endContainer)
  if (start !== run || end !== run || !root.contains(run)) return null
  const offset = offsetInRun(run, range.endContainer, range.endOffset)
  if (offset === null) return null
  return { runId: run.dataset.smRun ?? '', offset, collapsed: range.collapsed }
}

/** ランの `offset` 文字目にキャレットを置く */
export function setCaretInRun(run: HTMLElement, offset: number): void {
  const point = pointInRun(run, offset)
  if (!point) return
  selectionFor(run)?.setBaseAndExtent(point.node, point.offset, point.node, point.offset)
}
