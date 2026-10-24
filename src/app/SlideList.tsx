import { useEffect, useRef } from 'preact/hooks'

import type { RenderedDeck } from '../marp/renderer'
import { SlideSurface, type SlideOperationHandler } from '../marp/surface'
import { strings } from './strings'

export interface SlideListProps {
  deck: RenderedDeck | null
  version: number
  current: number
  onSelect: (index: number) => void
  onCollapse: () => void
  /** Omit the callback until the host can settle IME, commit edits and refresh the session. */
  onSlideOperation?: SlideOperationHandler
  readOnly?: boolean
}

/** 左のスライド一覧。描画はShadow DOM側（SlideSurface）が担当する */
export function SlideList({ deck, version, current, onSelect, onCollapse, onSlideOperation, readOnly = false }: SlideListProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const surfaceRef = useRef<SlideSurface | null>(null)
  const onSelectRef = useRef(onSelect)
  const operationRef = useRef(onSlideOperation)
  const readonlyRef = useRef(readOnly)
  const totalRef = useRef(0)
  const deckRef = useRef(deck)

  onSelectRef.current = onSelect
  operationRef.current = onSlideOperation
  readonlyRef.current = readOnly
  totalRef.current = deck?.slides.length ?? 0
  deckRef.current = deck

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const surface = new SlideSurface(host, {
      layout: 'list',
      labelFor: (index) => strings.sidebar.slideLabel(index + 1, totalRef.current),
      onSelect: (index) => onSelectRef.current(index),
      onSlideOperation: operation => operationRef.current?.(operation),
      isReadonly: () => readonlyRef.current || !operationRef.current,
      operationLabel: command => strings.slideOperations.labels[command],
    })
    surfaceRef.current = surface

    return () => {
      surfaceRef.current = null
      surface.dispose()
    }
  }, [])

  useEffect(() => {
    // 編集中は `deck` が毎回変わるので、確定した `version` のときだけ描き直す。
    const latest = deckRef.current
    if (latest) surfaceRef.current?.update(latest, current)
  }, [version, current])

  useEffect(() => {
    surfaceRef.current?.refreshOperations()
  }, [readOnly, !!onSlideOperation])

  return (
    <>
      <div class="slide-list-wrap">
        <div class="slide-list-host" ref={hostRef} />
        {!deck || deck.slides.length === 0 ? (
          <div class="list-empty">{strings.sidebar.empty}</div>
        ) : null}
      </div>
      <div class="sidebar-footer">
        <button
          type="button"
          aria-label={strings.slideOperations.labels.add}
          title={strings.slideOperations.addTitle}
          disabled={!onSlideOperation || readOnly || !deck?.slides.length}
          onClick={() => { void onSlideOperation?.({ kind: 'add', index: current }) }}
        >
          ＋
        </button>
        <button type="button" title={strings.sidebar.collapse} onClick={onCollapse}>
          ⟨⟨
        </button>
      </div>
    </>
  )
}
