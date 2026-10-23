/** Read the actual selection inside a Shadow DOM editing surface. */
export function selectionFor(root: Node): Selection | null {
  // Chromium rescopes document.getSelection() to the shadow host after native
  // input, even though a range set through script initially exposes text nodes.
  const tree = root.getRootNode() as Node & { getSelection?(): Selection | null }
  return tree.getSelection?.() ?? root.ownerDocument?.getSelection() ?? null
}
