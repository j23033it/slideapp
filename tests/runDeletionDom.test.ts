// @vitest-environment happy-dom
import { Marp } from '@marp-team/marp-core'
import { describe, expect, it } from 'vitest'

import { createEngine } from '../src/editing'
import { areRunsDomAdjacent } from '../src/app/runDeletion'

function span(text: string): HTMLElement {
  const element = document.createElement('span')
  element.dataset.smRun = text
  element.textContent = text
  return element
}

describe('areRunsDomAdjacent', () => {
  it('間に要素や文字が無いランだけを隣接とみなす', () => {
    const paragraph = document.createElement('p')
    const left = span('left')
    const right = span('right')
    paragraph.append(left, right)
    expect(areRunsDomAdjacent(left, right)).toBe(true)
  })

  it('間の要素・文字・別の親を拒否する', () => {
    const paragraph = document.createElement('p')
    const left = span('left')
    const code = document.createElement('code')
    code.textContent = 'code'
    const right = span('right')
    paragraph.append(left, code, right)
    expect(areRunsDomAdjacent(left, right)).toBe(false)

    const spaced = document.createElement('p')
    const first = span('first')
    const second = span('second')
    spaced.append(first, document.createTextNode(' '), second)
    expect(areRunsDomAdjacent(first, second)).toBe(false)

    const nested = document.createElement('strong')
    nested.append(right)
    paragraph.append(nested)
    expect(areRunsDomAdjacent(left, right)).toBe(false)
  })

  it.each([
    'left`code`right',
    'left![alt](image.png)right',
    'left$x$right',
    'left\nright',
  ])('実際のMarp出力で別要素を飛び越えない: %s', (source) => {
    const engine = createEngine(new Marp({ script: false, math: 'mathjax' }))
    const analysis = engine.analyze(source)
    const container = document.createElement('div')
    container.innerHTML = analysis.html

    const leftRun = analysis.runs.find((run) => run.text === 'left')
    const rightRun = analysis.runs.find((run) => run.text === 'right')
    expect(leftRun).toBeDefined()
    expect(rightRun).toBeDefined()
    const left = container.querySelector<HTMLElement>(`[data-sm-run="${leftRun!.id}"]`)
    const right = container.querySelector<HTMLElement>(`[data-sm-run="${rightRun!.id}"]`)
    expect(left).not.toBeNull()
    expect(right).not.toBeNull()
    expect(areRunsDomAdjacent(left!, right!)).toBe(false)
  })
})
