import { describe, expect, it } from 'vitest'

import { DocumentModel } from '../src/document'
import {
  CompositionGate,
  editorSessionSaveState,
  planHistoryRestore,
  slideForRun,
  type EditorSession,
} from '../src/app/session'

describe('CompositionGate', () => {
  it('変換中に予約した操作を、確定後にまとめて順番どおり実行する', () => {
    const gate = new CompositionGate()
    const called: string[] = []

    expect(gate.defer(() => called.push('before'))).toBe(false)
    gate.start()
    expect(gate.isComposing).toBe(true)
    expect(gate.defer(() => called.push('first'))).toBe(true)
    expect(gate.defer(() => called.push('second'))).toBe(true)
    expect(called).toEqual([])

    const token = gate.markEnded()
    expect(gate.isComposing).toBe(true)
    called.push('commit')
    gate.flush(token)
    expect(gate.isComposing).toBe(false)
    expect(called).toEqual(['commit', 'first', 'second'])
  })

  it('確定前に変換が再開したら、予約した操作を次の確定まで持ち越す', () => {
    const gate = new CompositionGate()
    const called: string[] = []

    gate.start()
    gate.defer(() => called.push('save'))
    const ended = gate.markEnded()
    gate.start() // 確定処理の前に次の変換が始まった

    gate.flush(ended)
    expect(gate.isComposing).toBe(true)
    expect(called).toEqual([])

    gate.flush(gate.markEnded())
    expect(gate.isComposing).toBe(false)
    expect(called).toEqual(['save'])
  })

  it('変換中でなければ何も予約しない', () => {
    const gate = new CompositionGate()
    expect(gate.defer(() => {})).toBe(false)
    gate.flush(gate.markEnded())
  })
})

describe('slideForRun', () => {
  const deck = {
    slides: [
      '<div><span data-sm-run="r1-0">first</span></div>',
      '<div><span data-sm-run="r1-1">second</span></div>',
    ],
  }

  it('ランのIDを含むスライド番号を返す', () => {
    expect(slideForRun(deck, 'r1-0')).toBe(0)
    expect(slideForRun(deck, 'r1-1')).toBe(1)
  })

  it('表示中のデッキに無ければ undefined', () => {
    expect(slideForRun(deck, 'r1-9')).toBeUndefined()
    expect(slideForRun(deck, '')).toBeUndefined()
  })
})

describe('editorSessionSaveState', () => {
  it('保存中に追加編集があればdirtyを保ち、Undoで保存済みスナップショットに戻ればcleanにする', () => {
    const model = new DocumentModel('First\r\n', { diskHash: 'hash-1' })
    const session = {
      model,
      savedSnapshot: { text: model.serialize(), hasBom: model.hasBom },
      conflict: false,
    } as EditorSession

    model.edit({ start: 0, end: 5, insert: 'Second' })
    const savedSnapshot = { text: model.serialize(), hasBom: model.hasBom }
    model.markConflict()
    session.conflict = true

    // 保存応答は Second をディスクへ書いたが、応答待ちに Third へ追加入力した。
    model.edit({ start: 0, end: 6, insert: 'Third' })
    session.savedSnapshot = savedSnapshot
    session.conflict = false
    model.diskHash = 'hash-2'

    expect(editorSessionSaveState(session)).toBe('dirty')
    expect(model.state).toBe('conflict') // model APIの保存基準は変更できないため、App側で導出する。

    model.undo()
    expect(model.serialize()).toBe(savedSnapshot.text)
    expect(editorSessionSaveState(session)).toBe('clean')
  })
})

describe('planHistoryRestore', () => {
  const deck = {
    slides: [
      '<div><span data-sm-run="r1-0">first</span></div>',
      '<div><span data-sm-run="r1-1">second</span></div>',
    ],
  }

  it('復元カーソルと同じスライド番号をひとつの計画で返す', () => {
    const cursor = { runId: 'r1-0', offset: 2 }
    expect(planHistoryRestore(deck, cursor, 1)).toEqual({ cursor, current: 0 })
  })

  it('カーソルが無いかスライドを特定できない場合は表示番号を維持する', () => {
    expect(planHistoryRestore(deck, undefined, 1)).toEqual({ cursor: undefined, current: 1 })
    expect(planHistoryRestore(deck, { runId: 'missing', offset: 0 }, 1)).toEqual({
      cursor: { runId: 'missing', offset: 0 },
      current: 1,
    })
  })
})
