# PPTX export integration

This module does not touch Markdown, the supplied Marp instance, or application UI.
Use the current in-memory Markdown and a Marp instance configured with the same
themes as the preview (`script: false`, default HTML allowlist).

```ts
import { exportPptx, defaultPptxPath } from '../export/pptx'
import { dirname } from '../platform/paths'

const path = await platform.pickPptxSavePath(defaultPptxPath(markdownPath))
if (path) {
  const { bytes, report } = await exportPptx(
    { markdown: currentMarkdown, marp, baseDir: dirname(markdownPath) },
    { title: markdownPath, onProgress: (done, total) => updateProgress(done, total) },
  )
  await platform.writeBinary(path, bytes)
  showExportReport(report)
}
```

`report.rasterizedElements` contains one-based slide numbers, tags and reasons;
`approximatedElements` records each lossy native mapping with slide, element, CSS
property/value and replacement; show these as approximations separately from
images. `substitutedFonts` contains requested/replacement names. `warnings` reports font
resources blocked by CSP or unavailable offline. `errors` (when present) identifies
elements that could not be exported even as images. These errors are also mirrored
in `warnings` for existing consumers. Surface them in the completion dialog as a
partial export, never as unconditional success. Unaffected elements/slides remain
in the returned deck. Cancellation is available through `options.signal`. Export generation
and file saving are separate, so the UI can retain bytes for a save retry.

Images use `convertFileSrc` by default and the `img-src` path rather than fetch.
The document folder must already have been authorized through `open_file`.
Browser verification can override `toAssetUrl`.

Remote font fetching respects CSP and falls back offline. To preserve embedded
Web fonts in raster parts without relaxing CSP, pass `fontEmbedCSS` with data URL
`@font-face` rules. Native text uses an installed Windows font, also in OOXML `ea`.
PowerPoint has one presentation size, so mixed slide sizes are rejected.

Unsupported math/SVG/emoji, transformed blocks and merged tables are rasterized.
Separable backgrounds and generated decoration become independent image layers. Code highlighting that can be represented as runs remains text.
Native tables use measured columns and rows with auto-paging disabled.
Cell padding is passed in inches (text-box padding uses points). Columns reserve
space beyond the measured text lines for Office's font metrics, preventing row
growth over the next block. A nested list uses one text box with a paragraph per
item; an OOXML pass sets exact measured text/marker indents independently of its
`lvl`. The existing JSZip dependency is used at runtime for that correction.
Single-line Marp-fitted headings disable Office wrapping.
Margins between paragraphs are represented by their measured positions, so they
are not applied a second time inside each text box.

## Conservative conversion

`styles.ts` and `classify.ts` hold explicit native eligibility decisions. Unknown
markers, alignments, typography, color formats, writing direction and whitespace
values rasterize with their property/value in the report. No unknown value is
coerced to a default bullet, font, alignment or numeric zero. `visibility.ts` is
shared by text, lists, tables, images, decoration, assets and raster bounds; it
follows shadow hosts and distinguishes suppressed subtrees from unpainted wrappers
with visible descendants. Hidden/merged/ragged table grids rasterize as a unit.
Native decisions have three outcomes: exact serialization, an explicitly listed
approximation, or rasterization. `APPROXIMATION_RULES` in `styles.ts` is the single
source for bounds and report descriptions: underline offset/thickness, tabular
numeric metrics and selected font features, kerning/rendering/smoothing, small
letter spacing, and translucent borders composited over ancestor solid fills.
Large underline changes, negative spacing outside the small bound, stylistic
font features and unsupported values still rasterize. Positive spacing outside
the approximation bound uses native character spacing. Built-in theme tables
(including default's tabular-nums/alpha borders) remain editable. Collapsed borders
on rows/groups are resolved into cell borders. Inline images, images
in tables, unsupported list blocks, inline boxes, and text-transform are reported
and rasterized. Hidden text is excluded from runs; visibility-hidden layout is
rasterized to preserve its occupied space. Native text includes color alpha, and
table cells include top/middle/bottom alignment.

Inseparable section effects use a full-slide raster to preserve compositing.
Pseudo decoration, block/list backgrounds, and section border/rounded decoration
are isolated while retaining their original containing blocks and layout. An
alpha crop places each generated image only over its painted bounds. Normal
headings, paragraphs, links, lists and tables remain native. Uncover's pagination
is a triangular gradient and a white text shadow: these are an image layer while
the page number itself is native text. Other fallback parts are painted in the
original Marp DOM/CSS context, with siblings made transparent while retaining
layout. Shadow content and slots are materialized. Shadow/filter overflow expands
the image bounds and its PPTX placement. Assets in pseudo content, backgrounds,
masks and borders are embedded explicitly. Each element conversion is transactional:
its measured geometry and serializer options are validated before the DOM goes away,
and a failure rolls back its partial native parts before attempting rasterization.
Asset/raster failures are reported with slide/element/property context while the
remaining deck continues. A failed whole-slide composite also attempts to retain
unaffected individual elements. Cancellation and invalid input still abort.

An export-local cache reuses equal CSS background surfaces. The OOXML pass also
stores identical PNG media once and redirects every slide relationship to it.
Numbered marker indentation uses the measured font's number/period/space advance.

## Verification

- `npm test -- tests/export` verifies unit conversions, lists, native tables,
  rich text, East Asian font entries, hyperlinks, positions, notes and slide size.
- `node tests/export/serve.mjs` starts a Vite verification server on port 1422.
  Import `/src/export/pptx/devHarness.ts` and call `exportFixtures()` in Chromium;
  artifacts are written to the temporary directory printed by the server.
- `classify.test.ts` covers native/raster eligibility and shadow/filter extents.
  `styles.test.ts` fixes the exact/approximation/raster property bounds.
  `measure.test.ts` covers hidden runs, run alpha, pseudo assets, separated
  decoration, approximation reports and cell alignment;
  `pptx.test.ts` also checks PNG deduplication and relationship integrity.
- `regressions.mjs` contains all review reproductions plus alpha, filter,
  compositing, positioned-pseudo, decorated background and built-in theme cases. The WebView2 runner checks those,
  records coarse paint comparisons (with antialias tolerance), confirms missing
  pseudo assets appear in the error report without stopping other slides, and exports a 50-slide Gaia performance deck with one PNG.
  Manual PowerPoint comparison remains required; the pixel check is a paint-loss
  regression guard, not a claim of pixel-identical native font rendering.
- For actual WebView2 verification, start Tauri with devUrl `http://127.0.0.1:1422`,
  a dedicated `WEBVIEW2_USER_DATA_FOLDER`, and
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9338`.
  Run `node tests/export/webview2.mjs`. It writes each fixture's PPTX and measured
  JSON and 1:1 WebView2 PNGs to a new temporary directory and verifies the resulting ZIP/XML, plus an
  embedded-font raster probe using Windows' Arial file.
- Run `powershell -File tests/export/render-powerpoint.ps1 -InputDir <that-directory>`.
  It opens every PPTX in installed desktop PowerPoint via COM, exports every slide
  at 1280×720 into a separate temporary directory, checks actual table row heights
  against the measured model, checks fitted headings stay single-line, and records
  table line counts in `table-metrics.json`. Every native text/list is matched to
  an actual `Shapes.HasTextFrame` object, every native table/cell is checked, and
  the COM evidence is written to `editable-metrics.json`. Compare these PNGs with the WebView2
  PNGs; the 4:3/custom fixtures are stretched to 1280×720 by PowerPoint's export.
- Visual comparison: open each generated PPTX in desktop PowerPoint at 100%,
  compare against the corresponding fixture in SlideApp, then edit a Japanese
  title, a nested list item and a table cell. Check line wraps, list markers,
  table heights, notes, background splits and image transparency. PowerPoint
  itself is not required for export or automated checks.

`src/app/**` is deliberately outside this implementation's scope. Changes to the
`Platform` interface require adding the two new methods to any UI test mocks.
