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
Solid block backgrounds and straight solid borders become native shapes behind content. Complex separable backgrounds and generated decoration become independent image layers. Code highlighting that can be represented as runs remains text.
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

`styles.ts`, `cssAudit.ts`, `markers.ts`, `paint.ts` and `classify.ts` hold explicit native eligibility decisions. Unknown
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
Numbered marker indentation uses the measured font's number/period/space advance. Custom `::marker` strings are decoded as CSS strings. A single BMP glyph, its trailing whitespace advance, independent font, size and color/alpha use native DrawingML bullets (`buChar`, `buFont`, `buSzPts`, `buClr`). Empty/hidden markers have no bullet. Multiple glyphs, images, counters or independently styled bold/italic markers rasterize the list; they never become default discs.

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


## CSS paint audit (2026-10-22)

Every entry below is evaluated on computed styles after Marp layout and asset/font
settlement. A computed default that paints nothing, or a property that the browser
does not apply to that element/pseudo, is **該当なし**. The table describes the
supported rendering contract, not a claim to implement every future CSS property.
New native CSS support must add an explicit mapping or bounded approximation and a
regression case; it must not remove a fallback merely because a value parses.

| Classification | Contract | Representative automated case |
| --- | --- | --- |
| ネイティブ | Measured native text/list/table, image or independent solid rectangle/lines; retain alpha where supported | `audit.test.ts`: solid `ul`/`li` backgrounds and custom marker OOXML; `audit-solid-list`, `audit-marker` in WebView2/COM |
| 近似 | Only `APPROXIMATION_RULES`; record property/value/replacement in `approximatedElements`, or font substitution in `substitutedFonts` | `styles.test.ts` bounds; `audit-approximation`; native built-in theme tables |
| 画像化 | Record element and reason. Separable decoration alone is an image; changed text flow/partial-run styling rasterizes its containing native unit. Cross-unit compositing uses the slide | `audit-decorations`, `audit-marker-complex`, `audit-first-line`, `audit-stacking` |
| 該当なし | No paint to serialize: suppressed subtrees, empty pseudos, default effects; browser-inapplicable CSS retains its computed default | `audit.test.ts`: default/empty paint; `measure.test.ts` painted-state tests; `audit-hidden` |

### Element routes

All rows also pass the property gates in the next table. Inline descendants are
inspected even when a native collector consumes their entire parent. Wrappers
(`figure`, `div`, etc.) receive their own paint/effect/layout checks before walking
children; direct wrapper text is collected or explicitly rasterized, never skipped.

| Target | Native collector / independent paint | Approximation | Raster boundary / nonapplicable cases |
| --- | --- | --- | --- |
| `section` | Solid slide/alpha background; measured layout of children | Inherited typography is reported at native children | Complex box decoration alone; transform/opacity/filter/clip/mask or cross-unit stacking/blending captures the slide; empty decoration: 該当なし |
| `h1`–`h6`, Marp heading hosts, `p` | Native rich text, measured padding/margins; own box behind text | Bounded typography/font rules | Unsupported typography/partial-run pseudos/changed text flow captures block |
| `ul`, `ol`, `li` | One native list box, paragraph level/start/indent/glyph; each list/item/continuation paragraph has independent box paint | Typography and marker typography rules, with `li::marker` attribution | Unsupported marker/content, reversed/inside list, overlapping items, nested positioned content or complex list structure captures whole list |
| `blockquote` | Own box; native child blocks | Native child rules | Inseparable block effects/layout captures quote; child images/unsupported units stay local |
| `table`, `thead`, `tbody`, `tfoot`, `tr` | Table grid; separate column/group/row/table fills; collapsed solid borders resolved at cells | Numeric features and alpha cell/row borders | Hidden/merged/ragged grid, visible caption, nonzero separate border spacing, changed table flow captures table |
| `th`, `td` | Native cell runs, measured padding/width/height, vertical alignment, transparent native cell over separated fill | Numeric features/border compositing | Cell gradient/rounding/outline is decoration only; unsupported text/inline images captures table |
| `pre`, Marp code hosts, `code` | Runs when Marp layout is representable; decoration is independent | Font/typography rules | Preserved tabs, unsupported shadow-host/math layout or typography captures code block |
| `img`, `figure`, `figcaption` | Image appearance; figure box and native caption/child content | Font rules for caption | Image CSS is browser-painted in its image surface; wrapper effects/clip capture figure; SVG image is reported |
| `a`, `strong`, `em`, `s`, `mark`, inline `code`, `span` | Rich runs including link/alpha/size/weight/italic/underline/strike; independent inline decoration raster | Bounded typography/font rules | Padding/margins/inline-block/float/position or in-flow generated content that changes internal run positions captures containing block/list/table |
| `header`, `footer` | Native text at measured coordinates with independent box | Typography/font rules | Unsupported text/effects captures respective block |
| `::before`, `::after` | Plain positioned section pagination can remain native text | Native text/font rules | Generated decoration paints alone in original containing block; unsupported text content stays in decoration image; in-flow nested pseudo layout captures containing unit; reordered stacking/blending captures slide |
| `::marker` | Default allowlisted bullets/numbering or one character with independent font/size/color/alpha; empty/hidden marker has no bullet | Bounded marker typography, explicitly reported | Multiple characters, image/counter content, unsupported font styling or marker type captures list; non-list-item: 該当なし |
| `::first-letter`, `::first-line` | Unchanged computed text appearance: 該当なし | None silently applied to partial runs | Changed color/font/decoration/spacing/direction/box/float/vertical alignment captures containing native unit |

### Property routes (applies to every element route above)

| CSS concern | ネイティブ | 近似 | 画像化 / 該当なし |
| --- | --- | --- | --- |
| Background color / alpha | Independent solid block/group/row/cell rectangles, section background, exact alpha | None | Inline fragmented paint, gradients, images, background-clip/origin/size/repeat/position/attachment/blend are painted as decoration; transparent/no background: 該当なし |
| Borders / radius / outline | Straight opaque solid edges, native cell borders | Cell/row alpha border over solid ancestors, reported | Dashed/double/image borders, translucent standalone edges, asymmetric/elliptical corners, outline/offset and box shadows paint decoration only. Radius without visible paint or clipping: 該当なし |
| Margin / padding / dimensions / gaps | DOM positions, textbox/cell padding and list indentation; external margins are not reapplied | Existing font metric reserve for Office line wrapping | Inline margins/padding/inline-block and unrepresentable mixed layout capture containing unit; zero/default spacing: 該当なし |
| Color / transparency | Run, fill and bullet alpha in DrawingML | Only allowlisted border compositing | Unsupported CSS color spaces in text capture native unit; box colors browser-paint as decoration; opacity 0 / invisible subtree: 該当なし |
| Font family / size / weight / style | Resolved font, run size/bold/italic and marker font/size; Marp fit scale | Local font substitution reported | Unsupported weight/stretch/caps/variants/features/variable settings/ligatures/language overrides capture unit |
| Decoration / transform / spacing | Underline, strike, positive character spacing, super/subscript | Bounded underline offset/thickness, small spacing, numeric metrics, selected features/kerning/rendering/smoothing | Unsupported decoration color/style/overline/emphasis/stroke/fill, text-transform, word-spacing, indentation or spacing beyond bounds capture unit; none/default: 該当なし |
| Direction / writing mode | Horizontal LTR, supported bidi defaults | None | RTL/vertical writing, unsupported orientation/combine/bidi capture text unit; browser-inapplicable pseudo properties: 該当なし |
| White-space / wrapping | Uniform normal/pre/pre-wrap without preserved tabs; measured line-height; fit-heading nowrap | Native fonts have documented metric reserve | Mixed whitespace, nowrap/break-spaces/pre-line, preserved tabs, word-break/line-break/hyphens/text-wrap-style outside allowlist capture unit |
| Overflow / ellipsis / clamp | Overflow visible, or nonvisible overflow with no clipped content | None | Actual overflow clipping (scroll extent and painted descendant bounds), legacy clip, ellipsis, line-clamp capture containing unit; no clipping: 該当なし |
| List symbols / counters | Allowlisted list types, numbering start/level, single character marker and measured glyph/space advance | Marker typography uses same bounded rules | Custom list-style-image, arbitrary counters/content, reversed/inside numbering or unknown type captures list; marker none/display other than list-item: 該当なし |
| Display / visibility | Block coordinates; table/list structural validation; visible descendants of unpainted wrappers handled explicitly | None | Hidden inline layout or nonrectangular hidden table captures unit; display:none/content-visibility:hidden/opacity:0 skip subtree; inherited visibility is checked on each descendant |
| Transform / opacity / filter | None/default: 該当なし | None | Transform including individual translate/rotate/scale/perspective, partial opacity, filter, clip-path/mask and related compositing capture affected unit; section context captures slide |
| mix-blend-mode / backdrop-filter | normal/none: 該当なし | None | Any active cross-element blending/backdrop effect captures slide, preserving original backdrop |
| Columns | auto/one column with automatic width: 該当なし | None | Multi-column count or explicit column-width captures affected text/list/wrapper (column gaps/rules retained by browser image) |
| float / position | Standalone block/figure/header/footer coordinates measured after layout | None | Nested inline/list/table positioning or floats capture enclosing unit; mixed wrapper text captures wrapper. Offsets on CSS-inapplicable properties: 該当なし |
| z-index / paint overlap | DOM-order native layers for ordinary auto/zero contexts; before/after layers respect natural order | None | Nonzero child stacking, reordered pseudo stacking or overlapping list items captures slide/list; no reordered paint: 該当なし |
| Pseudo assets | Image data embedded before painting, including marker/list-style-image, mask, border and partial-line backgrounds | None | Failed embedding reports element/pseudo/property in `errors`/`warnings`; other elements continue. Empty/non-generated pseudos: 該当なし |

### Reproduction and evidence

All additions are inside `src/export/pptx/**`. Run:

```powershell
npx tsc --noEmit
npx vitest run
node tests/export/serve.mjs
# Start the documented SlideApp WebView2 session on 1422 / CDP 9338.
node src/export/pptx/audit-webview2.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File src/export/pptx/audit-powerpoint.ps1 -InputDir <printed-outputDir>
```

`audit-webview2.mjs` exports the new CSS audit cases plus all existing fixture and
review cases, with PPTX, model/report JSON and reference PNGs. `--audit-only` limits
it to the new cases. It asserts native lists, marker OOXML, editable decorated
cells, fallback reasons, approximation reports and hidden content exclusion.
`audit-powerpoint.ps1` opens every `audit-*.pptx` in installed PowerPoint, exports
PNGs, checks editable Shapes/table cells and real bullet character/font/size,
checks dark-background/white-text z-order, and changes/restores native text and
cell content in memory. `com-metrics.json` is the evidence. It always closes the
decks and quits PowerPoint in `finally` without saving edits.

`audit-powerpoint.ps1 -All` also checks every existing fixture/review deck and its measured table row heights.

The older `tests/export/webview2.mjs` has a fixed expectation that default code
blocks are whole images. Code that now passes native text gates has only its
background rasterized (`marp-pre background`); the new audit runner covers the
current behavior without that obsolete expectation. No files outside this module
were modified to update that legacy runner.
