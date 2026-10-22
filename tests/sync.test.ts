import { describe, expect, it } from 'vitest'

import { DocumentModel } from '../src/document'
import {
  decideExternalChange,
  diskChangedSinceBanner,
  hasUnsavedChanges,
  isNameTakenError,
  mineFileName,
  needsOpenReconfirm,
  planConflictBanner,
  planConflictChoice,
  planMineCopyReload,
  planSaveCompletion,
  slideAfterReload,
  type ExternalChange,
  type SyncState,
} from '../src/app/sync'

const state: SyncState = {
  path: 'C:\\deck\\deck.md',
  dirty: false,
  conflict: false,
  currentText: 'hello\r\n',
  diskHash: 'hash-1',
}

describe('decideExternalChange', () => {
  it('同じハッシュ（自分の保存・同じディスク）は無視する', () => {
    expect(
      decideExternalChange(state, {
        type: 'changed',
        path: state.path,
        text: 'other',
        hasBom: false,
        hash: 'hash-1',
        mtime: 1,
      }),
    ).toEqual({ type: 'ignore' })
  })

  it('別のファイルのイベントは無視する', () => {
    expect(
      decideExternalChange(state, {
        type: 'changed',
        path: 'C:\\deck\\other.md',
        text: 'other',
        hasBom: false,
        hash: 'hash-2',
        mtime: 1,
      }),
    ).toEqual({ type: 'ignore' })
  })

  it('未保存でなく内容も同じなら、再描画せずハッシュだけ更新する', () => {
    expect(
      decideExternalChange(state, {
        type: 'changed',
        path: state.path,
        text: state.currentText,
        hasBom: true,
        hash: 'hash-2',
        mtime: 2,
      }),
    ).toEqual({ type: 'synced', hasBom: true, hash: 'hash-2' })
  })

  it('競合中は同じハッシュの通知も処理し、帯の内容を最新にする', () => {
    const conflictState: SyncState = { ...state, dirty: true, conflict: true }
    expect(
      decideExternalChange(conflictState, {
        type: 'changed',
        path: state.path,
        text: 'the original disk',
        hasBom: true,
        hash: state.diskHash,
        mtime: 3,
      }),
    ).toEqual({ type: 'conflict', text: 'the original disk', hasBom: true, hash: 'hash-1' })
  })

  it('未保存でなく内容が違えば再読み込みする', () => {
    expect(
      decideExternalChange(state, {
        type: 'changed',
        path: state.path,
        text: 'disk',
        hasBom: false,
        hash: 'hash-2',
        mtime: 2,
      }),
    ).toEqual({ type: 'reload', text: 'disk', hasBom: false, hash: 'hash-2' })
  })

  it('未保存の変更があれば競合にする', () => {
    expect(
      decideExternalChange(
        { ...state, dirty: true },
        { type: 'changed', path: state.path, text: 'disk', hasBom: false, hash: 'hash-2', mtime: 2 },
      ),
    ).toEqual({ type: 'conflict', text: 'disk', hasBom: false, hash: 'hash-2' })
  })

  it('削除・読み込み不能はそのまま伝える', () => {
    const removed: ExternalChange = { type: 'removed', path: state.path }
    expect(decideExternalChange(state, removed)).toEqual({ type: 'removed' })
    const unreadable: ExternalChange = { type: 'unreadable', path: state.path, message: 'locked' }
    expect(decideExternalChange(state, unreadable)).toEqual({ type: 'unreadable', message: 'locked' })
  })
})

describe('planConflictChoice', () => {
  it('ディスクの内容を読み込む', () => {
    expect(planConflictChoice('load-disk', { hash: 'disk' })).toEqual({
      reloadDisk: true,
      writeMineCopy: false,
    })
  })

  it('自分の変更で上書きするときは最新のディスクのハッシュを期待値にする', () => {
    expect(planConflictChoice('overwrite', { hash: 'disk' })).toEqual({
      reloadDisk: false,
      writeMineCopy: false,
      save: { expectedHash: 'disk' },
    })
  })

  it('別名で保存してからディスクを読み込む', () => {
    expect(planConflictChoice('save-mine', { hash: 'disk' })).toEqual({
      reloadDisk: true,
      writeMineCopy: true,
    })
  })
})

describe('mineFileName', () => {
  it('1つ目は .mine.md、以降は .mine-2.md と番号を増やす', () => {
    expect(mineFileName('C:\\deck\\deck.md', 0)).toBe('C:\\deck\\deck.mine.md')
    expect(mineFileName('C:\\deck\\deck.md', 1)).toBe('C:\\deck\\deck.mine-2.md')
    expect(mineFileName('C:\\deck\\deck.md', 2)).toBe('C:\\deck\\deck.mine-3.md')
    expect(mineFileName('deck.markdown', 0)).toBe('deck.mine.md')
  })
})

describe('isNameTakenError', () => {
  it('存在エラーの文言を判別する', () => {
    expect(isNameTakenError('File exists')).toBe(true)
    expect(isNameTakenError(new Error('ファイルは既に存在します'))).toBe(true)
    expect(isNameTakenError('アクセスが拒否されました')).toBe(false)
  })
})

describe('planSaveCompletion', () => {
  it('保存を待つ間に追加入力があれば、その入力を未保存のまま残す', () => {
    const model = new DocumentModel('First\r\n', { diskHash: 'hash-1' })
    const snapshot = { text: model.serialize(), hasBom: model.hasBom }
    model.edit({ start: 0, end: 5, insert: 'Second' })

    const completion = planSaveCompletion(snapshot, { text: model.serialize(), hasBom: model.hasBom }, 'hash-2')
    expect(completion).toEqual({ markSaved: false, savedSnapshot: snapshot, diskHash: 'hash-2' })

    if (completion.markSaved) model.markSaved(completion.diskHash)
    else {
      model.diskHash = completion.diskHash
      model.breakHistoryGroup()
    }
    expect(model.state).toBe('dirty')
    expect(model.diskHash).toBe('hash-2')
  })

  it('開始時の内容のままなら保存済みにし、ハッシュを進める', () => {
    const model = new DocumentModel('First\r\n', { diskHash: 'hash-1' })
    model.edit({ start: 0, end: 5, insert: 'Second' })

    const snapshot = { text: model.serialize(), hasBom: model.hasBom }
    const completion = planSaveCompletion(snapshot, { text: model.serialize(), hasBom: model.hasBom }, 'hash-2')
    expect(completion.markSaved).toBe(true)
    model.markSaved(completion.diskHash)
    expect(model.state).toBe('clean')
    expect(model.diskHash).toBe('hash-2')
    expect(snapshot.text).toBe('Second\r\n')
  })

  it('BOMが保存開始後に変わった場合も追加入力として扱う', () => {
    const snapshot = { text: 'First\r\n', hasBom: false }
    expect(planSaveCompletion(snapshot, { text: snapshot.text, hasBom: true }, 'hash-2')).toEqual({
      markSaved: false,
      savedSnapshot: snapshot,
      diskHash: 'hash-2',
    })
  })
})

describe('未保存確認と再読み込みの判断', () => {
  it('未保存の変更がある状態だけ確認する（読み取り専用は含めない）', () => {
    expect(hasUnsavedChanges('dirty')).toBe(true)
    expect(hasUnsavedChanges('conflict')).toBe(true)
    expect(hasUnsavedChanges('clean')).toBe(false)
    expect(hasUnsavedChanges('readonly')).toBe(false)
  })

  it('読み込みの待機中に元のファイルを編集したら、置き換えの確認をやり直す', () => {
    // 読み込み開始時は保存済み。待機中に "Second" へ入力された
    expect(
      needsOpenReconfirm({
        snapshot: { text: 'First', hasBom: false },
        current: { text: 'Second', hasBom: false },
        state: 'dirty',
        allowDirty: false,
      }),
    ).toBe(true)
    // 「変更を破棄」で確認済みでも、その後に編集したらやり直す
    expect(
      needsOpenReconfirm({
        snapshot: { text: 'First', hasBom: false },
        current: { text: 'Second', hasBom: false },
        state: 'dirty',
        allowDirty: true,
      }),
    ).toBe(true)
    // 確認済みで、その後は変わっていない
    expect(
      needsOpenReconfirm({
        snapshot: { text: 'First', hasBom: false },
        current: { text: 'First', hasBom: false },
        state: 'dirty',
        allowDirty: true,
      }),
    ).toBe(false)
    // 確認していない未保存の変更が残っている
    expect(
      needsOpenReconfirm({
        snapshot: { text: 'First', hasBom: false },
        current: { text: 'First', hasBom: false },
        state: 'dirty',
        allowDirty: false,
      }),
    ).toBe(true)
    // 読み取り専用は未保存の変更ではない
    expect(
      needsOpenReconfirm({
        snapshot: { text: 'First', hasBom: false },
        current: { text: 'First', hasBom: false },
        state: 'readonly',
        allowDirty: false,
      }),
    ).toBe(false)
    expect(
      needsOpenReconfirm({
        snapshot: { text: 'First', hasBom: false },
        current: { text: 'First', hasBom: true },
        state: 'clean',
        allowDirty: false,
      }),
    ).toBe(true)
  })

  it('別名保存の待機中に内容が変わっていれば再読み込みしない', () => {
    const snapshot = { text: 'First', hasBom: false }
    expect(planMineCopyReload(snapshot, { ...snapshot })).toBe(true)
    expect(planMineCopyReload(snapshot, { text: 'Second', hasBom: false })).toBe(false)
    expect(planMineCopyReload(snapshot, { text: 'First', hasBom: true })).toBe(false)
  })

  it('競合の帯は同じ読み込み結果の本文・BOM・ハッシュを使う', () => {
    expect(planConflictBanner({ text: 'disk', hasBom: true, hash: 'disk-hash' })).toEqual({
      kind: 'conflict',
      text: 'disk',
      hasBom: true,
      hash: 'disk-hash',
    })
    expect(planConflictBanner(null)).toEqual({ kind: 'unreadable' })
  })

  it('帯を出した時点からディスクの内容が変わったかを比べる', () => {
    const banner = { text: 'disk', hasBom: false, hash: 'hash-1' }
    expect(diskChangedSinceBanner({ ...banner }, banner)).toBe(false)
    expect(diskChangedSinceBanner({ ...banner, hash: 'hash-2' }, banner)).toBe(true)
  })
})

describe('slideAfterReload', () => {
  it('同じ番号を保ち、減ったら最後にする', () => {
    expect(slideAfterReload(2, 5)).toBe(2)
    expect(slideAfterReload(4, 3)).toBe(2)
    expect(slideAfterReload(0, 0)).toBe(0)
  })
})
