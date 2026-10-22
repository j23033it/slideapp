import { useEffect, useRef } from 'preact/hooks'

import type { RenderedDeck } from '../marp/renderer'
import { SlideSurface } from '../marp/surface'
import { strings } from './strings'

export interface SlideListProps {
  deck: RenderedDeck | null
  current: number
  onSelect: (index: number) => void
  onCollapse: () => void
}

/** 左のスライド一覧。描画はShadow DOM側（SlideSurface）が担当する */
export function SlideList({ deck, current, onSelect, onCollapse }: SlideListProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<SlideSurface | null>(null)
  const onSelectRef = useRef(onSelect)
  const totalRef = useRef(0)

  onSelectRef.current = onSelect
  totalRef.current = deck?.slides.length ?? 0

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const surface = new SlideSurface(host, {
      layout: 'list',
      labelFor: (index) => strings.sidebar.slideLabel(index + 1, totalRef.current),
      onSelect: (index) => onSelectRef.current(index),
    })
    surfaceRef.current = surface

    return () => {
      surfaceRef.current = null
      surface.dispose()
    }
  }, [])

  useEffect(() => {
    if (deck) surfaceRef.current?.update(deck, current)
  }, [deck, current])

  return (
    <>
      <div class="slide-list-wrap">
        <div class="slide-list-host" ref={hostRef} />
        {!deck || deck.slides.length === 0 ? (
          <div class="list-empty">{strings.sidebar.empty}</div>
        ) : null}
      </div>
      <div class="sidebar-footer">
        <button type="button" title={strings.sidebar.collapse} onClick={onCollapse}>
          ⟨⟨
        </button>
      </div>
    </>
  )
}
