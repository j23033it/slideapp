import { Marp } from '@marp-team/marp-core'
import { describe, expect, it } from 'vitest'

import type { Analysis, Run } from '../src/editing'
import { createEngine } from '../src/editing'
import { planBoundaryDeletion, runsAreSourceAdjacent } from '../src/app/runDeletion'

function run(id: string, text: string, start: number, editable = true, blockId = 'b1'): Run {
  return {
    id,
    blockId,
    text,
    segments: [{ start, end: start + text.length, text, kind: 'literal' }],
    editable,
  }
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

function actual(source: string): Analysis {
  const engine = createEngine(new Marp({ script: false, math: 'mathjax' }))
  return engine.analyze(source)
}

describe('planBoundaryDeletion', () => {
  it('ランの途中ではブラウザの通常削除に任せる', () => {
    const left = run('r1', 'left', 0)
    const right = run('r2', 'right', 4)
    expect(planBoundaryDeletion(analysis([left, right]), left, 2, 'backward')).toEqual({ kind: 'none' })
    expect(planBoundaryDeletion(analysis([left, right]), left, 2, 'forward')).toEqual({ kind: 'none' })
  })

  it('先頭のBackspaceは前のランの最後の1文字を消し、その末尾へ移る', () => {
    const left = run('r1', 'left', 0)
    const right = run('r2', 'right', 4)
    const plan = planBoundaryDeletion(analysis([left, right]), right, 0, 'backward')
    expect(plan).toMatchObject({ kind: 'delete', text: 'lef', offset: 3 })
    if (plan.kind === 'delete') expect(plan.run.id).toBe('r1')
  })

  it('末尾のDeleteは次のランの最初の1文字を消し、その先頭へ移る', () => {
    const left = run('r1', 'left', 0)
    const right = run('r2', 'right', 4)
    const plan = planBoundaryDeletion(analysis([left, right]), left, 4, 'forward')
    expect(plan).toMatchObject({ kind: 'delete', text: 'ight', offset: 0 })
    if (plan.kind === 'delete') expect(plan.run.id).toBe('r2')
  })

  it('サロゲートペアを割らずに1文字だけ消す', () => {
    const emoji = run('r1', '😀a', 0)
    const right = run('r2', 'right', 3)
    const plan = planBoundaryDeletion(analysis([emoji, right]), right, 0, 'backward')
    expect(plan).toMatchObject({ kind: 'delete', text: '😀', offset: 2 })
  })

  it('隣に編集可能なランがなければ拒否する', () => {
    const only = run('r1', 'left', 0)
    expect(planBoundaryDeletion(analysis([only]), only, 0, 'backward')).toEqual({ kind: 'reject' })
    expect(planBoundaryDeletion(analysis([only]), only, 4, 'forward')).toEqual({ kind: 'reject' })
    const blocked = run('r2', 'code', 4, false)
    const left = run('r1', 'left', 0)
    expect(planBoundaryDeletion(analysis([left, blocked]), left, 4, 'forward')).toEqual({ kind: 'reject' })
  })

  it('ブロックの並び順で隣を探す', () => {
    const first = run('r1', 'AB', 0)
    const second = run('r2', 'B', 2)
    const third = run('r3', 'C', 3)
    const plan = planBoundaryDeletion(analysis([third, first, second]), second, 0, 'backward')
    expect(plan).toMatchObject({ kind: 'delete', text: 'A', offset: 1 })
  })

  it('ソース上に別の要素があるランとは隣り合わない', () => {
    const left = run('r1', 'left', 0)
    const right = run('r2', 'right', 5) // 4文字目の後ろに1文字分の隙間
    expect(runsAreSourceAdjacent(left, right)).toBe(false)
    expect(planBoundaryDeletion(analysis([left, right]), right, 0, 'backward')).toEqual({ kind: 'reject' })
    expect(planBoundaryDeletion(analysis([left, right]), left, 4, 'forward')).toEqual({ kind: 'reject' })
  })
})

describe('実際の解析結果でのラン境界', () => {
  // block.runs には文字ランだけが入る。間の要素を確認せずに隣とみなすと、
  // コード・画像・数式・改行を飛び越えて手前の文字を消してしまう。
  it.each([
    ['left`code`right', 'right', 0, 'backward'],
    ['left`code`right', 'left', 4, 'forward'],
    ['left![alt](image.png)right', 'right', 0, 'backward'],
    ['left![alt](image.png)right', 'left', 4, 'forward'],
    ['left$x$right', 'right', 0, 'backward'],
    ['left$x$right', 'left', 4, 'forward'],
    ['left\nright', 'right', 0, 'backward'],
    ['left\nright', 'left', 4, 'forward'],
    ['left**bold**right', 'right', 0, 'backward'],
  ])('%s: %s の位置 %i の %s は拒否する', (source, text, offset, direction) => {
    const parsed = actual(source)
    const target = parsed.runs.find((entry) => entry.text === text)
    expect(target, JSON.stringify(parsed.runs)).toBeDefined()
    expect(target?.editable, JSON.stringify(target)).toBe(true)
    expect(
      planBoundaryDeletion(
        parsed,
        target!,
        offset,
        direction as 'backward' | 'forward',
      ),
    ).toEqual({ kind: 'reject' })
  })

  it('隙間の無い文字ランは削除を計画できる', () => {
    const left = run('r1', 'left', 0)
    const right = run('r2', 'right', 4)
    expect(runsAreSourceAdjacent(left, right)).toBe(true)
  })
})
