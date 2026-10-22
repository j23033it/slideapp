/** Follow the composed tree too: the export surface and Marp use shadow roots. */
function parent(element: Element): Element | null {
  return element.assignedSlot ?? element.parentElement ?? (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null)
}

export interface PaintedState { subtreeHidden: boolean; painted: boolean }

/** Visibility can be overridden by a descendant; display/content-visibility cannot.
 * Empty wrappers and display:contents can still have painted descendants, so callers
 * prune only subtreeHidden and use painted when collecting the element itself.
 */
export function paintedState(element: Element, pseudo?: string): PaintedState {
  for (let ancestor: Element | null = element; ancestor; ancestor = parent(ancestor)) {
    const style = getComputedStyle(ancestor)
    if (ancestor.hasAttribute('hidden') || style.display === 'none' || style.contentVisibility === 'hidden' || style.opacity === '0') return { subtreeHidden: true, painted: false }
    if (style.contentVisibility === 'auto' && ancestor.checkVisibility && !ancestor.checkVisibility({ contentVisibilityAuto: true })) return { subtreeHidden: true, painted: false }
  }
  const style = getComputedStyle(element, pseudo), rect = element.getBoundingClientRect()
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) throw new Error('Invalid measured geometry')
  const generated = !pseudo || (['::first-letter', '::first-line'].includes(pseudo) && !!element.textContent?.trim()) || (pseudo === '::marker' && getComputedStyle(element).display === 'list-item') || (!!style.content && !['none', 'normal'].includes(style.content))
  const box = (rect.width > 0 || element.tagName === 'BR') && rect.height > 0
  const painted = generated && style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) &&
    (box || (!!pseudo && Number.parseFloat(style.width) > 0 && Number.parseFloat(style.height) > 0))
  return { subtreeHidden: false, painted }
}

export const isPainted = (element: Element, pseudo?: string): boolean => paintedState(element, pseudo).painted
