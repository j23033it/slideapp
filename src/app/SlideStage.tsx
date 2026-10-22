import { useEffect, useRef } from 'preact/hooks'

import type { RenderedDeck } from '../marp/renderer'
import { SlideSurface } from '../marp/surface'

export interface SlideStageProps {
  deck: RenderedDeck
  current: number
}

/** 中央のスライド表示。1枚を縦横比を保って最大表示する */
export function SlideStage({ deck, current }: SlideStageProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<SlideSurface | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const surface = new SlideSurface(host, { layout: 'single' })
    surfaceRef.current = surface

    return () => {
      surfaceRef.current = null
      surface.dispose()
    }
  }, [])

  useEffect(() => {
    surfaceRef.current?.update(deck, current)
  }, [deck, current])

  return (
    <div class="stage">
      <div class="stage-host" ref={hostRef} />
    </div>
  )
}
