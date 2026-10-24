/**
 * Compare the actual rendered slide markup without a DOM dependency. Marp's
 * output is tokenized with quoted attributes intact; unknown differences reject.
 */
export function renderedSlideSignatures(html: string): string[] | undefined {
  const parts = html.match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9:.-]*(?:[^>"']|"[^"]*"|'[^']*')*>|[^<]+|</g) ?? [];
  const signatures: string[] = [];
  const stack: Array<{ name: string; omit: boolean }> = [];
  let slide: string[] | undefined;
  let slideDepth = -1;
  let scopes = new Map<string, string>();
  const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
  for (const part of parts) {
    if (!part.startsWith('<') || part.startsWith('<!--')) { if (slide) slide.push(part); continue; }
    const match = /^<(\/)?([a-zA-Z][a-zA-Z0-9:.-]*)([\s\S]*?)(\/?)>$/.exec(part);
    if (!match) return;
    const name = match[2].toLowerCase();
    if (match[1]) {
      const opening = stack.pop();
      if (!opening || opening.name !== name) return;
      if (slide && !opening.omit) slide.push(`</${name}>`);
      if (slide && stack.length === slideDepth) {
        signatures.push(slide.join('')); slide = undefined;
      }
      continue;
    }
    const attrs: Array<[string, string]> = [];
    const attrPattern = /\s+([^\s=<>"'`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s<>"'`=]+)))?/gy;
    let offset = 0;
    while (offset < match[3].length) {
      attrPattern.lastIndex = offset;
      const attr = attrPattern.exec(match[3]);
      if (!attr) { if (match[3].slice(offset).trim()) return; break; }
      attrs.push([attr[1], attr[2] ?? attr[3] ?? attr[4] ?? '']); offset = attrPattern.lastIndex;
    }
    const isRoot = name === 'svg' && attrs.some(([key]) => key === 'data-marpit-svg');
    if (isRoot) {
      if (slide) return;
      slide = []; slideDepth = stack.length; scopes = new Map();
    }
    const omit = name === 'span' && attrs.some(([key]) => key === 'data-sm-run');
    if (slide && !omit) {
      const normalized = attrs.filter(([key, value]) => {
        if (key.startsWith('data-sm-')) return false;
        if (name === 'section' && ['data-marpit-pagination', 'data-marpit-pagination-total'].includes(key)) return false;
        // Only Marpit's default numeric section anchor is position-dependent.
        if (name === 'section' && key === 'id' && value === String(signatures.length + 1)) return false;
        // Marp's heading-slug suffix counts earlier equal headings. Duplicating
        // a title changes this derived anchor even when its content is identical.
        if (/^h[1-6]$/.test(name) && key === 'id') return false;
        return true;
      }).map(([key, value]) => {
        // Marpit generates a random key on every scoped-style render. Preserve
        // scope count and identity within each slide, ignoring only that key.
        if (/^data-marpit-scope-[a-zA-Z0-9]{8}$/.test(key)) {
          if (!scopes.has(key)) scopes.set(key, `data-marpit-scope-${scopes.size}`);
          key = scopes.get(key)!;
        }
        return [key, value];
      }).sort(([a], [b]) => a.localeCompare(b));
      slide.push(JSON.stringify([name, normalized, !!match[4] || voidTags.has(name)]));
    }
    if (!match[4] && !voidTags.has(name)) stack.push({ name, omit });
  }
  if (stack.length || slide) return;
  return signatures;
}

export function validateSlideRendering(before: string, after: string, newToOld: Array<number | null>): boolean {
  const oldSlides = renderedSlideSignatures(before), newSlides = renderedSlideSignatures(after);
  return !!oldSlides && !!newSlides && newSlides.length === newToOld.length &&
    newToOld.every((oldIndex, newIndex) => oldIndex === null || oldSlides[oldIndex] === newSlides[newIndex]);
}
