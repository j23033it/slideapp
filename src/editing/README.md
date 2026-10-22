# Editing engine integration

This package is pure TypeScript. Only `editing/dom` depends on DOM APIs.

## File boundary and rendering

- Rust strips the UTF-8 BOM and supplies `hasBom` separately. Keep that flag when saving.
- Construct `DocumentModel(rawWithoutBom, { hasBom, diskHash })`. Its `text` is LF-normalized; `serialize()` restores the original line endings and excludes the BOM.
- Construct one `Marp({ script: false })` with the default HTML allowlist, then `createEngine(marp)`. Use this same Marp instance for theme configuration and rendering. Register other markdown-it plugins before creating the engine.
- `engine.analyze(model.text)` returns `html`, `css`, ordered `runs`/`blocks`, and coded `readonly` regions. It installs tracking once per instance. Source coordinates and cursor offsets use JavaScript UTF-16 indices.
- Use the returned HTML rather than calling `marp.render()` again for the editable preview. `verifyRenderedRuns(root, analysis)` must run after mounting it; `bindEditing` calls it automatically. Pass the full rendered deck root to verification, even if the application shows only one slide.

## Applying an edit

```ts
const analysis = engine.analyze(model.text);
const result = engine.applyRunEdit(model.text, analysis.runs[0].id, 'New text');
if (result.ok) {
  model.edit(result.edit, { before: oldCursor, after: newCursor });
  // result.analysis is already current. Do not analyze again for every keystroke.
}
```

The edit changes only its recorded source range. Validation compares the full block structure, inline syntax and attributes, the edited display text, and all other runs. A failed candidate gets one retry with escaped ASCII punctuation. Failed validation retains the previous usable analysis. Run IDs remain stable through accepted edits; a new explicit `analyze` creates a new revision. Stale source text or IDs are rejected.

`DocumentModel` keeps reversible range edits, original EOL arrays, cursor records, save state and disk hash. Supply `before`/`after` cursors for grouping: edits in the same run at the same cursor within 1000 ms are grouped. Call `breakHistoryGroup()` on navigation or other intentional transaction boundaries. External `reload(raw, hash, hasBom)` clears history. After undo/redo, analyze the restored text and call `resolveCursor(analysis, storedCursor)` to map the saved cursor to its new run ID. This relies on P0 edits preserving run order; external reload clears the history that could violate that condition.

## Optional DOM adapter

`bindEditing(root, engine, { analysis, onCommit, onReject, onHistory, onFinish })` returns `begin(runElement)`, `finish()`, `getAnalysis()` and `dispose()`.

- The host handles clicks and caret placement, then calls `begin` on a verified run.
- The adapter enables the containing block, freezes read-only islands, restricts `beforeinput`, flattens pasted plain text, waits for IME composition end, validates input and restores rejected DOM changes.
- Rejected input restores the selection and block focus from run IDs and UTF-16 offsets captured before the browser mutation. Inline HTML contents are read-only; unmatched or uncertain HTML boundaries make the whole block read-only.
- `onCommit(result)` updates the document using `result.edit`. The host records before/after cursor positions for history. The adapter keeps the existing DOM during accepted input.
- `onHistory` delegates undo/redo to the host. `onFinish` lets the host rerender the deck and refresh thumbnails. Dispose/rebind after replacing the rendered root.
- When `begin` finishes a previous block, it reacquires the target by run ID after `onFinish` replaces the deck contents. Run switches during IME composition preserve the composition state and defer `onFinish` until editing ends, so the browser's provisional DOM survives. Both composition events and `InputEvent.isComposing` suppress commits until `compositionend`.
- Run-boundary Backspace/Delete returns `cross-run`. The host must implement adjacent-run actions; the adapter deliberately does not let the browser merge markup.

## Deliberate conservative behavior and remaining integration checks

- Unicode/shortcode emoji and Marp-created text without a verified source map are read-only. Marp can split surrounding ordinary text in the same token; those fragments are read-only too.
- Block-edge whitespace is accepted only when display text matches exactly. A harmless edit that Marp trims can therefore be rejected.
- Emptying an entire run is rejected when it removes an inline token, paragraph or heading. Adding/removing structure is outside P0.
- Automatic links whose target would change with their display text are rejected by the attribute check. Explicit Markdown link labels can be edited independently of their destinations.
- Setext `inline.map` already excludes the underline in markdown-it 14; the mapping code avoids subtracting it twice.
- A token's enumerable symbol metadata survives Marp's unchanged Unicode-token clones. Split/transformed content fails the equality check and loses editability.
- Lone CR line endings are rejected by the document boundary. LF, CRLF, mixed EOLs, final-newline presence, and BOM metadata are retained.
- Happy DOM covers event flow and DOM restoration. Actual WebView2 click caret behavior, native Japanese IME, browser `beforeinput` variations, and Shadow DOM selection still require the application's integration checks.

The source model, engine and DOM adapter have Vitest coverage; `npx vitest run` and `npx tsc --noEmit` are the required checks. Markdown-it is explicitly pinned/overridden to 14.3.3, shared by Marp Core 4.4.0 through Marpit. Re-run the full editing suite for dependency upgrades. Vitest 5 requires Node 22.12+, Node 24, or Node 26+.
