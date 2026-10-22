import type { DocumentModel } from '../document'
import type { Analysis } from '../editing'
import type { MarpRenderer, RenderedDeck } from '../marp/renderer'
import type { StageFocus } from './stageEditor'

/** 開いている1ファイル分の可変状態。Preactの再描画とは別に、同期処理から最新値を読む */
export interface EditorSession {
  path: string
  baseDir: string
  model: DocumentModel
  renderer: MarpRenderer
  analysis: Analysis
  deck: RenderedDeck
  /** 元に戻す・やり直す・外部変更の後に戻すカーソル位置 */
  focus?: StageFocus
}

/** 表示中のスライドに渡す操作 */
export interface StageApi {
  endEditing(): void
}
