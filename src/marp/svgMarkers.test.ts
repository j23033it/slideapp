// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { isolateSvgMarkers } from './svgMarkers'

afterEach(() => { document.body.innerHTML = '' })

it('keeps each duplicated CSS marker reference within its diagram and restores the DOM', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = host.attachShadow({ mode: 'open' })
  const diagram = '<section><svg><defs><marker id="arrow"><path fill="red" d="M0 0 L10 5 L0 10 z"/></marker></defs><path class="line" d="M0 0 L20 0" style="stroke: black"/></svg></section>'
  root.innerHTML = `<style>.line { marker-end: url(#arrow) }</style>${diagram}${diagram}`
  const paths = [...root.querySelectorAll<SVGElement>('.line')]
  const restore = isolateSvgMarkers(root)
  const ids = paths.map(path => /#([^)]*)/.exec(path.style.getPropertyValue('marker-end'))?.[1])
  expect(ids[0]).toBeTruthy()
  expect(ids[0]).not.toBe(ids[1])
  for (const [i, path] of paths.entries()) {
    expect([...path.closest('svg')!.querySelectorAll('marker')].some(marker => marker.id === ids[i])).toBe(true)
    expect(path.style.getPropertyPriority('marker-end')).toBe('important')
  }
  restore()
  expect(paths.map(path => path.getAttribute('style'))).toEqual(['stroke: black', 'stroke: black'])
  expect(root.querySelectorAll('marker')).toHaveLength(2)
})
