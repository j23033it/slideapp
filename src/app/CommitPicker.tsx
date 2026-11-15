import { useEffect, useRef } from 'preact/hooks'
import type { GitFileStatus } from '../platform'
import { strings } from './strings'

export interface CommitPickerProps {
  disabledReason?: string
  busy: boolean
  status: GitFileStatus | null
  open: boolean
  message: string
  error: string | null
  onOpen: () => void
  onClose: () => void
  onMessage: (message: string) => void
  onCommit: () => void
}

export function CommitPicker(props: CommitPickerProps) {
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const composing = useRef(false)
  useEffect(() => {
    if (!props.open) return
    input.current?.focus()
    const close = (event: PointerEvent) => {
      if (!props.busy && !event.composedPath().includes(root.current!) && !(event.target instanceof Element && event.target.closest('.file-tab-bar'))) props.onClose()
    }
    document.addEventListener('pointerdown', close, true)
    return () => document.removeEventListener('pointerdown', close, true)
  }, [props.open, props.busy])
  return <div ref={root} title={props.disabledReason} style={{ position: 'relative' }}>
    <button ref={trigger} type="button" class="toolbar-button" title={props.disabledReason ?? strings.git.title}
      disabled={!!props.disabledReason || props.busy} aria-expanded={props.open} aria-haspopup="dialog"
      onClick={() => props.open ? props.onClose() : props.onOpen()}>{strings.git.label}</button>
    {props.open && <div role="dialog" aria-label={strings.git.label}
      style={{ position: 'absolute', zIndex: 1000, top: '100%', left: 0, padding: 8, minWidth: 260, background: 'var(--sm-surface)', color: 'var(--sm-text)', border: '1px solid var(--sm-border)', borderRadius: 4 }}
      onKeyDown={event => {
        if (event.key === 'Escape' && !props.busy && !event.isComposing && !composing.current) { event.preventDefault(); event.stopPropagation(); props.onClose(); trigger.current?.focus() }
        if (event.key === 'Enter') {
          event.stopPropagation()
          if (event.isComposing || composing.current) return
          event.preventDefault()
          if (!props.busy && props.message.trim()) props.onCommit()
        }
      }}>
      <div>{props.status?.branch ? strings.git.branch(props.status.branch) : strings.git.detached}</div>
      <input ref={input} type="text" aria-label={strings.git.placeholder} placeholder={strings.git.placeholder}
        value={props.message} disabled={props.busy} onInput={event => props.onMessage(event.currentTarget.value)}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} />
      {props.error && <div role="alert">{props.error}</div>}
      <div>
        <button type="button" disabled={props.busy || !props.message.trim()} onClick={props.onCommit}>{props.busy ? strings.git.working : strings.git.label}</button>
        <button type="button" disabled={props.busy} onClick={props.onClose}>{strings.git.cancel}</button>
      </div>
    </div>}
  </div>
}
