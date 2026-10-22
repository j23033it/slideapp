import { describe, expect, it } from 'vitest'

import type { Analysis, Run } from '../src/editing'
import { planBoundaryDeletion } from '../src/app/runDeletion'

function run(id: string, text: string, editable = true, blockId = 'b1'): Run {
  return { id, blockId, text, segments: [], editable }
}

function analysis(runs: Run[], order = runs.map((entry) => entry.id)): Analysis {
  return {
    text: runs.map((entry) => entry.text).join(''),
    html: '',
    css: '',
    runs,
    blocks: [{ id: 'b1', tag: 'p', runs: order, editable: true }],
    readonly: [],
    structure: '',
    inlineStructure: [],
  }
}

describe('planBoundaryDeletion', () => {
  it('ランの途中ではブラウザの通常削除に任せる', () => {
    const left = run('r1', 'left')
    const right = run('r2', 'right')
    expect(planBoundaryDeletion(analysis([left, right]), left, 2, 'backward')).toEqual({ kind: 'none' })
    expect(planBoundaryDeletion(analysis([left, right]), left, 2, 'forward')).toEqual({ kind: 'none' })
  })

  it('先頭のBackspaceは前のランの最後の1文字を消し、その末尾へ移る', () => {
    const left = run('r1', 'left')
    const right = run('r2', 'right')
    const plan = planBoundaryDeletion(analysis([left, right]), right, 0, 'backward')
    expect(plan).toMatchObject({ kind: 'delete', text: 'lef', offset: 3 })
    if (plan.kind === 'delete') expect(plan.run.id).toBe('r1')
  })

  it('末尾のDeleteは次のランの最初の1文字を消し、その先頭へ移る', () => {
    const left = run('r1', 'left')
    const right = run('r2', 'right')
    const plan = planBoundaryDeletion(analysis([left, right]), left, 4, 'forward')
    expect(plan).toMatchObject({ kind: 'delete', text: 'ight', offset: 0 })
    if (plan.kind === 'delete') expect(plan.run.id).toBe('r2')
  })

  it('サロゲートペアを割らずに1文字だけ消す', () => {
    const emoji = run('r1', '😀a')
    const right = run('r2', 'right')
    const plan = planBoundaryDeletion(analysis([emoji, right]), right, 0, 'backward')
    expect(plan).toMatchObject({ kind: 'delete', text: '😀', offset: 2 })
  })

  it('隣に編集可能なランがなければ拒否する', () => {
    const only = run('r1', 'left')
    expect(planBoundaryDeletion(analysis([only]), only, 0, 'backward')).toEqual({ kind: 'reject' })
    expect(planBoundaryDeletion(analysis([only]), only, 4, 'forward')).toEqual({ kind: 'reject' })
    const blocked = run('r2', 'code', false)
    const left = run('r1', 'left')
    expect(planBoundaryDeletion(analysis([left, blocked]), left, 4, 'forward')).toEqual({ kind: 'reject' })
  })

  it('ブロックの並び順で隣を探す', () => {
    const first = run('r1', 'AB')
    const second = run('r2', 'B')
    const third = run('r3', 'C')
    const plan = planBoundaryDeletion(analysis([third, first, second]), second, 0, 'backward')
    expect(plan).toMatchObject({ kind: 'delete', text: 'A', offset: 1 })
  })
})
