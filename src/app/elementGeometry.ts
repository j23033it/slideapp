/** Convert viewport geometry to the unscaled slide frame's coordinate system. */
export function toSlideRect(rect: DOMRect, frameRect: DOMRect, width: number, height: number) {
  if (!frameRect.width || !frameRect.height || !width || !height) return undefined
  const scaleX = frameRect.width / width, scaleY = frameRect.height / height
  return { x: (rect.left - frameRect.left) / scaleX, y: (rect.top - frameRect.top) / scaleY,
    width: rect.width / scaleX, height: rect.height / scaleY, scaleX, scaleY }
}

export function selectionOutlineWidth(element: HTMLElement): number {
  const frame = element.closest<HTMLElement>('.frame')
  if (!frame) return 2
  const geometry = toSlideRect(element.getBoundingClientRect(), frame.getBoundingClientRect(), frame.offsetWidth, frame.offsetHeight)
  return 2 / (geometry?.scaleX || 1)
}
