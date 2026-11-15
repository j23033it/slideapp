import { useEffect, useRef } from 'preact/hooks'

import { SlideSurface } from '../marp/surface'
import type { EditorSession, StageApi } from './session'
import { StageEditor, type EditSuccess, type EditingCursors } from './stageEditor'
import type { Cursor } from '../document'
import type { ElementKind, ReadonlyCode } from '../editing'
import { selectionFor } from '../editing/dom/selection'
import { runElementOf, selectionInRun } from './caret'
import { attachTableMenu, type TableMenuTarget } from './tableMenu'
import type { BoxGeometry } from '../editing/boxPosition'
import type { TableCommand, TableReasonCode } from '../editing/tableOperations'

export interface SlideStageCallbacks {
  onBegin(label: string, elementId?: string): void
  onEnd(): void
  onNotice(code: ReadonlyCode): void
  onCommit(result: EditSuccess, cursors: EditingCursors): void
  onCrossRun(result: EditSuccess, target: Cursor, before?: Cursor, selectionEnd?: Cursor): void
  onElementBold(result: EditSuccess, elementId: string): void
  canBold(): boolean
  onBoldState(active: boolean): void
  onHistory(direction: 'undo' | 'redo'): void
  onElementDelete(id: string): boolean
  onElementSelect(kind: ElementKind | null, id?: string): void
  onTableReason?(target: TableMenuTarget, command: TableCommand | 'delete-table'): TableReasonCode | undefined
  onTableCommand?(target: TableMenuTarget, command: TableCommand | 'delete-table'): void
  onImageResize?(id: string, width: number, slideWidth: number): void
  onBoxPlace?(id: string, geometry: BoxGeometry): void
}

export interface SlideStageProps {
  session: EditorSession
  deckVersion: number
  current: number
  apiRef: { current: StageApi | null }
  callbacks: SlideStageCallbacks
}

/** 中央のスライド表示。1枚を縦横比を保って最大表示し、その場で編集する */
export function SlideStage({
  session,
  deckVersion,
  current,
  apiRef,
  callbacks,
}: SlideStageProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<StageEditor | null>(null)
  const callbacksRef = useRef(callbacks)
  const sessionRef = useRef(session)

  callbacksRef.current = callbacks
  sessionRef.current = session

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const surface = new SlideSurface(host, { layout: 'single' })
    const editor = new StageEditor(surface, sessionRef.current.renderer.editing, {
      latest: () => {
        const latest = sessionRef.current
        return { analysis: latest.analysis, deck: latest.deck }
      },
      onBegin: (label, id) => callbacksRef.current.onBegin(label, id),
      onEnd: () => callbacksRef.current.onEnd(),
      onNotice: (code) => callbacksRef.current.onNotice(code),
      onCommit: (result, cursors) => callbacksRef.current.onCommit(result, cursors),
      onCrossRun: (result, target, before, selectionEnd) => callbacksRef.current.onCrossRun(result, target, before, selectionEnd),
      onElementBold: (result, id) => callbacksRef.current.onElementBold(result, id),
      canBold: () => callbacksRef.current.canBold(),
      onBoldState: active => callbacksRef.current.onBoldState(active),
      onHistory: (direction) => callbacksRef.current.onHistory(direction),
      onElementDelete: (id) => callbacksRef.current.onElementDelete(id),
      onElementSelect: (kind, id) => callbacksRef.current.onElementSelect(kind, id),
      onBoxPlace: (id, geometry) => callbacksRef.current.onBoxPlace?.(id, geometry),
      onImageResize: callbacks.onImageResize ? (id, width, slideWidth) => callbacksRef.current.onImageResize?.(id, width, slideWidth) : undefined,
    })
    editorRef.current = editor
    const disposeTableMenu = attachTableMenu(surface.root, {
      accepts: target => !!callbacksRef.current.onTableCommand && editor.isTableActive(target.elementId),
      reason: (target, command) => callbacksRef.current.onTableReason?.(target, command),
      run: (target, command) => callbacksRef.current.onTableCommand?.(target, command),
    })
    let cursor: Cursor | undefined
    const rememberCursor = () => {
      const root = host.shadowRoot
      if (!root) return
      const run = runElementOf(selectionFor(root)?.focusNode ?? null)
      const point = run ? selectionInRun(root, run) : null
      if (point?.collapsed) cursor = { runId: point.runId, offset: point.offset }
    }
    host.ownerDocument.addEventListener('selectionchange', rememberCursor)
    apiRef.current = {
      cancelDrag: () => editor.cancelDrag(),
      toggleBold: () => editor.toggleBold(),
      endEditing: () => editor.endEditing(),
      insertionAnchor: () => editor.insertionAnchor(),
      selectElementOnRender: id => editor.selectElementOnRender(id),
      captureCursor: () => { rememberCursor(); return cursor },
      isComposing: () => editor.isComposing(),
      deferWhileComposing: (action) => editor.deferWhileComposing(action),
    }

    return () => {
      disposeTableMenu()
      host.ownerDocument.removeEventListener('selectionchange', rememberCursor)
      apiRef.current = null
      editorRef.current = null
      editor.dispose()
      surface.dispose()
    }
  }, [apiRef])

  useEffect(() => {
    editorRef.current?.render(session.deck, session.analysis, current, session.focus)
  }, [session, deckVersion, current])

  return (
    <div class="stage">
      <div class="stage-host" ref={hostRef} />
    </div>
  )
}
