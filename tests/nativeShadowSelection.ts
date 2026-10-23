import { vi } from 'vitest'

/** Model WebView2's native selection: document sees the host, shadow sees text. */
export function nativeShadowSelection(root: ShadowRoot): Selection {
  const scoped = document.getSelection()!
  const range = document.createRange()
  range.setStartBefore(root.host)
  range.collapse(true)
  const overrides: Partial<Selection> = {
    rangeCount: 1,
    isCollapsed: true,
    anchorNode: range.startContainer,
    anchorOffset: range.startOffset,
    focusNode: range.endContainer,
    focusOffset: range.endOffset,
    getRangeAt: () => range,
    toString: () => scoped.toString(),
    removeAllRanges: () => scoped.removeAllRanges(),
  }
  const retargeted = new Proxy(scoped, {
    get(target, key) {
      if (key in overrides) return Reflect.get(overrides, key)
      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  Object.defineProperty(root, 'getSelection', { configurable: true, value: () => scoped })
  vi.spyOn(document, 'getSelection').mockReturnValue(retargeted)
  return scoped
}
