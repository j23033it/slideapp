import type { Cursor, DocumentModel, SaveState } from '../document'
import type { Analysis, SlideOperation, SlideOperationResult } from '../editing'
import { slideReason } from '../editing/slides'
import type { MarpRenderer, RenderedDeck } from '../marp/renderer'
import type { ThemeConfig } from '../platform'
import { saveStateFromSnapshot, type ContentSnapshot } from './sync'
import type { StageFocus } from './stageEditor'

/** 開いている1ファイル分の可変状態。Preactの再描画とは別に、同期処理から最新値を読む */
export interface EditorSession {
  path: string
  baseDir: string
  model: DocumentModel
  /** 直近でディスクに書き込んだ本文とBOM。DocumentModelの現在値と独立して保持する */
  savedSnapshot: ContentSnapshot
  /** 外部変更との競合が未解決か */
  conflict: boolean
  renderer: MarpRenderer
  /** 現在のプレビューに適用したテーマ設定 */
  themeConfig: ThemeConfig
  analysis: Analysis
  deck: RenderedDeck
  /** 元に戻す・やり直す・外部変更の後に戻すカーソル位置 */
  focus?: StageFocus
}

/** Appが表示・確認に使う保存状態。保存応答中の後続編集も正しく比較する。 */
export function editorSessionSaveState(session: EditorSession): SaveState {
  return saveStateFromSnapshot(
    { text: session.model.serialize(), hasBom: session.model.hasBom },
    session.savedSnapshot,
    session.model.state === 'readonly',
    session.conflict,
  )
}

/** 表示中のスライドに渡す操作 */
export interface StageApi {
  endEditing(): void
  /** IME変換中か。変換中は確定とコミットが終わるまで操作を保留する */
  isComposing(): boolean
  /** 変換中なら操作を予約して true。確定後にまとめて実行される */
  deferWhileComposing(action: () => void): boolean
}

/**
 * IME変換中の操作を、確定とコミットが終わるまで預かる。
 * 変換が終わってから再度始まった場合は、前回の予約を捨てずに次の確定まで持ち越す。
 */
export class CompositionGate {
  private composing = false
  private generation = 0
  private deferred: Array<() => void> = []

  get isComposing(): boolean {
    return this.composing
  }

  /** compositionstart のみ。input/beforeinput のフラグでは再開しない */
  start(): void {
    this.composing = true
    this.generation += 1
  }

  /** 変換中なら予約して true。変換中でなければ何もせず false */
  defer(action: () => void): boolean {
    if (!this.composing) return false
    this.deferred.push(action)
    return true
  }

  /** compositionend の時点の世代。コミット後に `flush` へ渡す */
  markEnded(): number {
    return this.generation
  }

  /** コミットを含む compositionend の全処理が終わった後に呼ぶ */
  flush(token: number): void {
    if (!this.composing || token !== this.generation) return
    this.composing = false
    const actions = this.deferred
    this.deferred = []
    for (const action of actions) action()
  }
}

/** 指定したランを表示しているスライド番号。見つからなければ undefined */
export function slideForRun(deck: Pick<RenderedDeck, 'slides'>, runId: string): number | undefined {
  if (!runId) return undefined
  const needle = `data-sm-run="${runId}"`
  const index = deck.slides.findIndex((slide) => slide.includes(needle))
  return index < 0 ? undefined : index
}

/** Undo/Redoで復元したカーソルと表示スライドを同じ計画として返す。 */
export function planHistoryRestore(
  deck: Pick<RenderedDeck, 'slides'>,
  cursor: Cursor | undefined,
  current: number,
): { cursor: Cursor | undefined; current: number } {
  if (cursor?.slideIndex !== undefined) {
    return { cursor: undefined, current: Math.max(0, Math.min(cursor.slideIndex, deck.slides.length - 1)) }
  }
  const slide = cursor ? slideForRun(deck, cursor.runId) : undefined
  return { cursor, current: slide ?? current }
}

/**
 * Commit pending text input/IME and call StageApi.endEditing() before invoking.
 * Updates the model, one undo entry, analysis and deck together. The host then
 * selects result.selectedSlide and refreshes both stage and thumbnails.
 */
export function applySessionSlideOperation(
  session: EditorSession,
  operation: SlideOperation,
  currentSlide: number,
): SlideOperationResult {
  if (session.model.state === 'readonly') return { ok: false, reason: slideReason('slide-readonly') }
  const engine = session.renderer.editing
  const result = engine.applySlideOperation(session.model.text, operation, session.model.eols)
  if (!result.ok) return result
  // Build the deck before mutating document/history so a render failure cannot
  // leave only half of the session updated.
  try {
    const deck = session.renderer.update(result.analysis, session.baseDir)
    session.model.editTransaction(result.edits, {
      before: { runId: '', offset: 0, slideIndex: currentSlide },
      after: { runId: '', offset: 0, slideIndex: result.selectedSlide },
    })
    session.analysis = result.analysis
    session.deck = deck
    session.focus = undefined
    return result
  } catch {
    const restored = engine.analyze(session.model.text)
    session.analysis = restored
    session.deck = session.renderer.update(restored, session.baseDir)
    return { ok: false, reason: slideReason('slide-pending-edit') }
  }
}
