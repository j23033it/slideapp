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

/** Keep at least 16 slide pixels of the box visible in each direction. */
export function limitBoxPosition(geometry: { left: number; top: number; width: number }, height: number, slideWidth: number, slideHeight: number) {
  return { left: Math.round(Math.max(16 - geometry.width, Math.min(slideWidth - 16, geometry.left))),
    top: Math.round(Math.max(16 - height, Math.min(slideHeight - 16, geometry.top))), width: Math.round(geometry.width) }
}
