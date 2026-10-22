import { describe, expect, it } from 'vitest'

import {
  decideExternalChange,
  isNameTakenError,
  mineFileName,
  planConflictChoice,
  slideAfterReload,
  type ExternalChange,
  type SyncState,
} from '../src/app/sync'

const state: SyncState = {
  path: 'C:\\deck\\deck.md',
  dirty: false,
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

describe('slideAfterReload', () => {
  it('同じ番号を保ち、減ったら最後にする', () => {
    expect(slideAfterReload(2, 5)).toBe(2)
    expect(slideAfterReload(4, 3)).toBe(2)
    expect(slideAfterReload(0, 0)).toBe(0)
  })
})
