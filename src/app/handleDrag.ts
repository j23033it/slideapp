/** Shared pointer gesture: coordinates are expressed in the unscaled frame. */
export function beginHandleDrag(event: PointerEvent, frame: HTMLElement, callbacks: {
  move(dx: number, dy: number): void
  finish(): void
  cancel(): void
}): () => void {
  const win = frame.ownerDocument.defaultView!
  const rect = frame.getBoundingClientRect()
  const sx = rect.width / frame.offsetWidth, sy = rect.height / frame.offsetHeight
  if (!(sx > 0 && sy > 0)) { callbacks.cancel(); return () => {} }
  const x = event.clientX, y = event.clientY, pointer = event.pointerId
  let active = true
  // The browser synthesizes a click after pointerup, even after Escape. Do not
  // let that click clear the selected element under the handle.
  const removeClickGuard = () => {
    win.removeEventListener('click', guardClick, true)
    win.removeEventListener('pointerup', released, true)
    win.clearTimeout(guardTimer)
  }
  const guardClick = (e: MouseEvent) => { e.preventDefault(); e.stopImmediatePropagation(); removeClickGuard() }
  const released = (e: PointerEvent) => { if (e.pointerId === pointer) win.setTimeout(removeClickGuard, 0) }
  const guardTimer = win.setTimeout(removeClickGuard, 10000)
  win.addEventListener('click', guardClick, true)
  win.addEventListener('pointerup', released, true)
  const cleanup = () => {
    if (!active) return
    active = false
    win.removeEventListener('pointermove', move, true)
    win.removeEventListener('pointerup', up, true)
    win.removeEventListener('pointercancel', cancel, true)
    win.removeEventListener('keydown', key, true)
    win.removeEventListener('blur', cancel, true)
  }
  const move = (e: PointerEvent) => { if (e.pointerId === pointer) { e.preventDefault(); callbacks.move((e.clientX - x) / sx, (e.clientY - y) / sy) } }
  const up = (e: PointerEvent) => { if (e.pointerId === pointer) { e.preventDefault(); cleanup(); callbacks.finish() } }
  const cancel = () => { if (active) { cleanup(); callbacks.cancel() } }
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cancel() } }
  win.addEventListener('pointermove', move, true)
  win.addEventListener('pointerup', up, true)
  win.addEventListener('pointercancel', cancel, true)
  win.addEventListener('keydown', key, true)
  win.addEventListener('blur', cancel, true)
  return cancel
}
