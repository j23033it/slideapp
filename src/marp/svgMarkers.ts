/** Keep duplicate diagram marker IDs from resolving to a different slide.
 * The original nodes stay in place so author CSS selectors still match them.
 * This only touches the rendered DOM; the Markdown and Marp HTML stay intact.
 */
let nextMarkerId = 0

export function isolateSvgMarkers(root: ParentNode): () => void {
  const diagrams = [...root.querySelectorAll<SVGSVGElement>('section svg:not([data-marpit-svg])')]
  const byId = new Map<string, SVGElement[]>()
  for (const svg of diagrams) {
    for (const marker of svg.querySelectorAll<SVGElement>('marker[id]')) {
      if (marker.closest('svg') !== svg || !marker.id) continue
      const matches = byId.get(marker.id) ?? []
      matches.push(marker)
      byId.set(marker.id, matches)
    }
  }
  const duplicates = new Set([...byId].filter(([, markers]) => markers.length > 1).map(([id]) => id))
  if (!duplicates.size) return () => {}

  const existingIds = new Set([...root.querySelectorAll('[id]')].map(element => element.id))
  const markerCopies = new Map<SVGElement, { clone: SVGElement; id: string }>()
  const edits: { element: SVGElement; property: string; id: string }[] = []
  const originals = new Map<SVGElement, string | null>()
  for (const svg of diagrams) {
    const local = new Map<string, SVGElement>()
    for (const marker of svg.querySelectorAll<SVGElement>('marker[id]')) {
      if (marker.closest('svg') === svg && duplicates.has(marker.id) && !local.has(marker.id)) local.set(marker.id, marker)
    }
    if (!local.size) continue
    for (const element of svg.querySelectorAll<SVGElement>('*')) {
      if (element.closest('svg') !== svg) continue
      const style = getComputedStyle(element)
      for (const property of ['marker-start', 'marker-mid', 'marker-end']) {
        const value = style.getPropertyValue(property)
        const match = /^url\(\s*["']?#([^"')\s]+)["']?\s*\)$/.exec(value)
        const marker = match && local.get(match[1]!)
        if (!marker) continue
        let copy = markerCopies.get(marker)
        if (!copy) {
          let id: string
          do { id = `sm-marker-${++nextMarkerId}` } while (existingIds.has(id))
          existingIds.add(id)
          const clone = marker.cloneNode(true) as SVGElement
          const sources = [marker, ...marker.querySelectorAll<SVGElement>('*')]
          const targets = [clone, ...clone.querySelectorAll<SVGElement>('*')]
          for (let i = 0; i < sources.length; i++) {
            const source = sources[i]!, target = targets[i]!
            const computed = getComputedStyle(source)
            // Copy computed styles so selectors using the original ID still apply.
            for (let j = 0; j < computed.length; j++) {
              const name = computed.item(j)
              const computedValue = computed.getPropertyValue(name)
              if (computedValue) target.style.setProperty(name, computedValue, 'important')
            }
          }
          clone.id = id
          clone.setAttribute('data-sm-marker-copy', '')
          copy = { clone, id }
          markerCopies.set(marker, copy)
        }
        if (!originals.has(element)) originals.set(element, element.getAttribute('style'))
        edits.push({ element, property, id: copy.id })
      }
    }
  }
  for (const [marker, copy] of markerCopies) marker.parentNode?.appendChild(copy.clone)
  for (const edit of edits) edit.element.style.setProperty(edit.property, `url(#${edit.id})`, 'important')
  return () => {
    for (const { clone } of markerCopies.values()) clone.remove()
    for (const [element, original] of originals) {
      if (original === null) element.removeAttribute('style')
      else element.setAttribute('style', original)
    }
  }
}
