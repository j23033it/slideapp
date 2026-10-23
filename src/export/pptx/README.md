# PPTX export integration

This module does not touch Markdown, the supplied Marp instance, or application UI.
Use the current in-memory Markdown and a Marp instance configured with the same
themes and HTML allowlist as the preview (`script: false`, never `html: true`).
For inline SVG diagrams, configure **both** preview and export Marp instances with
`html: svgHtmlAllowlist` (exported from this module). Marp's default allowlist
escapes inline SVG; this change does not wire a different renderer into `src/app/**`.

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
`@font-face` rules. Native text uses an installed Windows font for OOXML `latin`.
Japanese characters always use **Noto Sans JP** in the preview, measurement and
raster surfaces, regardless of the authored family. `src/marp/fonts.ts` prepends
a Japanese-only alias (registered in `document.head`) to the declaring CSS rules,
including conditional rules and pseudos, while retaining the original Latin family
list, specificity and `!important`. Inherited children, including editing run spans,
keep inheriting: no computed font or extra attributes/styles are added to them.
The existing PostCSS dependency is explicitly pinned for lossless CSS rule updates;
selector casing (notably `foreignObject`) survives SVG rasterization. Existing
inline/presentation font declarations are updated only where already present.
The ZIP pass splits text runs at the Japanese Unicode boundaries documented in
`docs/design.md`, retaining all run properties and `a:latin`. Only Japanese segments
receive Noto Sans JP in `a:ea`; Bopomofo, Hangul and other out-of-range characters
retain the original `a:ea`. Japanese custom bullets also use Noto Sans JP. Missing Noto Sans JP
stops export with an explicit error. Local probes include full Regular face names
(notably `Yu Gothic Regular`). Generic Latin families are matched by measured
advances against Windows font candidates instead of assuming English browser
defaults. An unsupported name is detected by changing its trailing fallback
between serif and monospace: differing advances mean the name was skipped by the
browser, so export also tries the next authored family (for example Consolas
after Windows' unsupported ui-monospace in the default theme). A supported generic
with unmatched advances, a lone unsupported generic, or unavailable measurement
uses the approximation below and records requested/replacement names in
`substitutedFonts`. Font mapping uncertainty never aborts the deck. Raster parts
keep the browser's generic; native text uses the reported approximation, so line
wrap differences are possible in this case.

| Generic | Windows approximation when no measured match exists |
| --- | --- |
| `system-ui`, `ui-sans-serif`, `ui-rounded` | Segoe UI |
| `sans-serif` | Arial |
| `serif`, `ui-serif` | Times New Roman |
| `monospace`, `ui-monospace` | Consolas |
| `cursive` / `fantasy` / `math` | Comic Sans MS / Impact / Cambria Math |
| `fangsong` / `emoji` | SimSun / Segoe UI Emoji |

These are export approximations, not claims about every browser's defaults.
[CSS Fonts 4](https://www.w3.org/TR/css-fonts-4/#generic-font-families) defines
generic categories and allows platform/language-dependent mappings.
[Microsoft's font catalog](https://learn.microsoft.com/en-us/typography/font-list/)
documents the corresponding Windows families; in particular
[Segoe UI](https://learn.microsoft.com/en-us/typography/font-list/segoe-ui) is a
Windows UI font, and [Consolas](https://learn.microsoft.com/en-us/typography/font-list/consolas)
is designed for monospaced programming text. Arial/Times New Roman preserve the
sans/serif categories; ui-rounded uses Segoe UI because Windows has no universal
rounded UI face; SimSun is a CJK serif approximation for fangsong. All are measured
before approximation, including Yu Gothic UI as a Japanese Windows UI candidate.
If the preferred approximation is not installed, use the first installed one of
Segoe UI, Arial, Consolas, Noto Sans JP, and report that actual replacement.
PowerPoint has one presentation size, so mixed slide sizes are rejected.

To reproduce issue #21 in installed Chrome and PowerPoint:

```powershell
node src/export/pptx/inspect-chrome.mjs tests/fixtures/export/japanese-fonts.md --font-audit --inspect-dir "$env:TEMP/slideapp-issue21"
powershell -NoProfile -File src/export/pptx/audit-powerpoint.ps1 -InputDir "$env:TEMP/slideapp-issue21" -All
```

`--font-audit` uses the actual `SlideSurface`, checks CDP's painted platform fonts,
and records preview PNGs and per-paragraph line contents in `*-font-audit.json`.
The COM audit checks Latin/East Asian names, exact preview line contents, unchanged
table row heights, Japanese custom bullet fonts and in-memory editing. The seven
slides cover both Arial/Yu Gothic orders, serif/monospace/sans-serif, inherited
families, mixed Japanese/Latin/fullwidth/halfwidth kana, bold/italic, tables and
custom bullets. On 2026-10-23 Chrome 156 and installed PowerPoint passed all seven
slides with no rasterization or export errors. Glyph shapes and line wraps were
also compared in their PNGs.

The issue #21 review regressions are `font-code-default.md`, `font-code-gaia.md`,
`font-code-uncover.md`, `font-system-ui.md` and `font-pseudo.md` in the same fixture
directory. Pass all five paths plus `japanese-fonts.md` to `inspect-chrome.mjs
--font-audit`, then run the COM audit above with `-All`. Chrome 156.0.8078.48 and
installed PowerPoint passed these 12 slides on 2026-10-23. Default code retains
editable Consolas without font substitution; system-ui matches installed
Yu Gothic UI by measured advances (also confirmed by CDP), with Noto Sans JP for
Japanese and identical Office line wraps. The explicitly same-family Yu Mincho
`p::before` paints Noto Sans JP and is preserved as a reported decoration image.
Gaia/uncover code retains existing local raster routes for inline-block/effects;
their substitutions (Roboto Mono → BIZ UDGothic, SFMono-Regular → Consolas) are
reported. Gaia's live preview can download Roboto Mono while offline export uses
the reported installed replacement. The three unit regressions use the pinned
themes' actual code stacks with unavailable earlier families and verify Consolas.
The merged `path-default-fill.md` additionally passed all five slides in Chrome
and COM, retaining both `fonts` and `defaultFill` in `com-metrics.json`.

Review 2 regressions are `font-first-line.md` and `font-east-asian.md`. The font
preview harness now runs **MarpRenderer → SlideSurface**, including editing spans,
and rejects added run style/font attributes. Chrome checks actual platform fonts:
first-line Latin (including bold text) stays Consolas and Japanese stays Noto Sans
JP. The first-line paragraph keeps the existing local raster route; comparison
against a real Chrome screenshot permits SVG/canvas antialias differences (6% of
foreground pixels with the existing 2px/color tolerance; measured 4.17%).
Bopomofo remains SimSun and Hangul remains Malgun Gothic in preview and native
PowerPoint runs, without substitution. The supplied review probes, all existing
font fixtures and all three code themes passed Chrome/PowerPoint verification
(20 slides). COM checks each Unicode span's expected Latin/East Asian font, line
wraps, table heights and editing. The four-class `!important` pseudo probe also
paints Noto Sans JP: rewriting its declaring rule naturally removes the previously
reported specificity limitation. WebView2's 10 direct-editing cases passed.

Unsupported math/SVG primitives/emoji, transformed blocks and merged tables are rasterized.
Supported inline SVG `g`, `rect`/circular `rx`, single text nodes, absolute
`M/L/H/V` paths and triangular arrow markers become editable shapes. The collector
is atomic: unsupported curves/primitives, rotation/skew/nonuniform scale, complex
paint or text reject only that SVG, roll back its native parts, and record the
reason before raster fallback. It never stops the rest of the deck.
The reference's text-bearing overflow outside an SVG viewport is allowed only up
to 3 CSS pixels and recorded in `approximatedElements`; larger clips or clipped
non-text geometry rasterize the diagram. External marker references are rejected.
Stroke and arrow paint also participate in viewport checks. Clipped opaque square
hairlines (at most 1 CSS pixel outside) retain their exact visible area as a fill
and clipped rectangular border strips; other clipped strokes/markers rasterize.
Computed CSS path overrides, hidden/transformed marker content, non-butt path
line caps and unsupported joins reject only the SVG and appear in the raster report.
Solid block backgrounds and straight solid borders become native shapes behind content.
Equal circular CSS corners with uniform borders use a native `roundRect`, with
the measured radius and the CSS border inset. Elliptical/asymmetric corners and
complex decoration remain images behind editable content. Complex separable backgrounds and generated decoration become independent image layers. Code highlighting that can be represented as runs remains text.
Native tables specify the DOM's measured row heights
with auto-paging disabled. Cell padding is passed in inches (text-box padding uses points).
Each column keeps at least its DOM width and requests space beyond the measured
text lines for Office's font metrics, preserving the existing export behavior.
The table may expand beyond its DOM width and ancestor content area. Only when
the expanded table would cross the slide's right edge does spare width in other
columns supply that reserve; any remaining reserve shortage is shared
proportionally. Reserve shortage alone never rasterizes a table. Rectangular
solid cell backgrounds (including alpha) use the native cell's fill, so text,
borders and fill share the final grid. If a table contains independently painted
descendant backgrounds, borders or generated decoration, all its cells instead
stay transparent. Structural and cell background shapes use the same final grid
and precede descendant decoration, followed by the transparent editable table.
Solid table/row/column/group backgrounds map their horizontal edges to those same
output column boundaries. Complex cell decoration (gradient, radius, shadow,
etc.) retains its separate browser-painted image. If the original DOM table itself
exceeds the slide's horizontal bounds, the table rasterizes with a
reported reason.
Flat lists place each item at its measured position. A nested list uses one text box with a paragraph per
item; an OOXML pass sets exact measured text/marker indents independently of its
`lvl`. The existing JSZip dependency is used at runtime for that correction.
Single-line Marp-fitted headings and CSS `nowrap` disable Office wrapping.
Every native paragraph uses its measured base font for paragraph metrics and
selects the deck theme from its first native font. Explicit BRs (including
consecutive/trailing BRs) and preserved newlines use DrawingML soft breaks.
Collapsed spaces after BRs are removed without trimming nonbreaking spaces.
The OOXML pass removes duplicate paragraph properties from all rich text and
table cells and writes explicit no-stroke values, independent of theme defaults.
Margins between paragraphs are represented by their measured positions, so they
are not applied a second time inside each text box.
Text with spare height from `height`/`min-height` stays top aligned. Middle
alignment is limited to measured glyph bounds or fully occupied line boxes, so
font leading does not shift ordinary lines. List text excludes padding/borders
from its content box. Each table cell may use its own whitespace mode, while
mixed whitespace modes inside a cell rasterize the table.

## Conservative conversion

`styles.ts`, `cssAudit.ts`, `markers.ts`, `paint.ts` and `classify.ts` hold explicit native eligibility decisions. Unknown
markers, alignments, typography, color formats, writing direction and whitespace
values rasterize with their property/value in the report. No unknown value is
coerced to a default bullet, font, alignment or numeric zero. `visibility.ts` is
shared by text, lists, tables, images, decoration, assets and raster bounds; it
follows shadow hosts and distinguishes suppressed subtrees from unpainted wrappers
with visible descendants. Hidden/merged/ragged table grids rasterize as a unit.
Native decisions have three outcomes: exact serialization, an explicitly listed
approximation, or rasterization. `APPROXIMATION_RULES` in `styles.ts` defines CSS
typography bounds and report descriptions; `markers.ts` defines the default disc
mapping and `svg.ts` defines the SVG dash preset mapping and bounded text-bearing overflow. CSS rules cover
weight 300, underline offset/thickness, tabular
numeric metrics and selected font features, kerning/rendering/smoothing, small positive
letter spacing, and translucent borders composited over ancestor solid fills.
Small negative letter spacing (at most 0.05em and 1px) is serialized exactly.
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

Issue #20's eight-slide regression is `table-background-width.md`: English and
Japanese cell fills, row and row-group fills, reserve-only bounds cases, and
actual slide/parent overflow. Ancestor overflow remains native; actual slide
clipping keeps its existing raster route. The three `table-width-wrapped-{default,gaia,uncover}.md`
fixtures cover full-width tables with wrapped English and Japanese descriptions.
Run `inspect-chrome.mjs tests/fixtures/export/table-background-width.md
--inspect-dir <temporary-directory>`, then `audit-powerpoint.ps1 -InputDir
<temporary-directory> -All`. The COM audit checks output column widths, native
cell colors/alpha, unchanged row heights, cell text and in-memory editing. For
these fixtures and the supplied `probe-*` review slides with blue headers, it
also samples every final header's right edge in the rendered PowerPoint PNG and
verifies white text. `com-metrics.json` retains these checks under `tableMetrics`.
Seven background tables remain editable; only slide 7's actual clipping uses
raster fallback. Default COM auditing rejects row-height changes. Explicit
`-AllowTableRowGrowth` continues through increased heights with warnings and
records each row's expected/actual height and delta under `rowHeightChanges`;
column widths, cell editing, fill and header paint checks remain strict. This
option records DOM/Office differences; comparison with main is a separate check.
On 2026-10-24 Chrome 156.0.8078.48 and installed PowerPoint verified all 71 decks /
128 slides / 43 native tables / 116 table rows against main (e5fec9d). Every row
height matched main within the audit's 0.02pt tolerance. The prior fixed-DOM-width
attempt's seven new row increases across six tables (29.30–38.215pt) returned to
main's heights. The remaining `probe-default` slide 7 header is 60.32504pt in both
versions (23.57504pt above the DOM height), an existing main difference, so the
whole-suite COM runs use `-AllowTableRowGrowth` and compare actual Office heights.
All column, cell-edit and fill checks passed; all 90 sampled blue header edges
retained white text. Only `table-background-width`
slide 5 needed reserve reduction: its right edge moved from 1291.80625px to
1280px, with unchanged Office row heights and editable cells. The other 42 tables
kept main's column widths. The deliberately missing-image review case retains its
expected isolated asset error.

PR #29's inline-decoration regression is `table-inline-decoration.md`: default
theme code on white cells, a yellow span on blue cells, and an outlined span.
The fixture uses the default code background/font/radius, with `white-space:inherit`
and zero code padding to stay within existing native inline-layout support.
Unmodified default code's `break-spaces`/padding still takes the existing table
raster route; this change does not broaden native layout eligibility.
Export with `inspect-chrome.mjs`, then run `audit-powerpoint.ps1 -All`. The audit
requires an editable table on every slide, transparent cell fills, decoration
below the table, visible gray/yellow/outline pixels and blue paint at every final
header edge. It also changes/restores decorated cell text in memory.
Chrome 156.0.8078.48 and installed PowerPoint passed all three slides on
2026-10-24: only the four inline decorations are images; all three tables remain
editable. The code background samples retain RGB(240,241,242), the yellow span
RGB(255,255,0), and the outline RGB(234,179,8). The complete 72-deck / 131-slide
COM run also passed. All 116 existing rows across 43 native tables (71 decks /
128 slides) matched main e5fec9d within 0.02pt, with zero row-height increases;
the pre-existing `probe-default` slide 7 DOM/Office difference remains unchanged.

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
| 近似 | Explicit typography, marker and SVG bounds described above; record property/value/replacement in `approximatedElements`, or font substitution in `substitutedFonts` | `styles.test.ts` bounds; `audit-approximation`; native built-in theme tables; `parity.test.ts` SVG overflow |
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
| `ul`, `ol`, `li` | Nested lists use one native list box; flat lists position each item separately. Paragraph level/start/indent/glyph and independent list/item/continuation box paint are retained | Typography and marker typography rules, with `li::marker` attribution | Unsupported marker/content, reversed/inside list, overlapping items, nested positioned content or complex list structure captures whole list |
| `blockquote` | Own box; native child blocks | Native child rules | Inseparable block effects/layout captures quote; child images/unsupported units stay local |
| `table`, `thead`, `tbody`, `tfoot`, `tr` | Table grid; separate column/group/row/table fills; collapsed solid borders resolved at cells | Numeric features and alpha cell/row borders | Hidden/merged/ragged grid, visible caption, nonzero separate border spacing, changed table flow captures table |
| `th`, `td` | Native cell runs, measured padding/width/height, vertical alignment and solid cell fill (including alpha) on the output column grid | Numeric features/border compositing | Cell gradient/rounding/outline is separate decoration only; unsupported text/inline images captures table |
| `pre`, Marp code hosts, `code` | Runs when Marp layout is representable; decoration is independent | Font/typography rules | Preserved tabs, unsupported shadow-host/math layout or typography captures code block |
| `img`, `figure`, `figcaption` | Image appearance; figure box and native caption/child content | Font rules for caption | Image CSS is browser-painted in its image surface; wrapper effects/clip capture figure; SVG image is reported |
| `a`, `strong`, `em`, `s`, `mark`, inline `code`, `span` | Rich runs including link/alpha/size/weight/italic/underline/strike; independent inline decoration raster | Bounded typography/font rules | Padding/margins/inline-block/float/position or in-flow generated content that changes internal run positions captures containing block/list/table |
| `header`, `footer` | Native text at measured coordinates with independent box | Typography/font rules | Unsupported text/effects captures respective block |
| `::before`, `::after` | Plain positioned section pagination can remain native text | Native text/font rules | Generated decoration paints alone in original containing block; unsupported text content stays in decoration image; in-flow nested pseudo layout captures containing unit; reordered stacking/blending captures slide |
| Inline `svg` | `g`, `rect` (circular `rx`), simple `text`, absolute `M/L/H/V` lines and triangular end markers; uniform positive screen scale/translation applied | Reference-compatible `6 4` → DrawingML `dash` mapping and text-bearing viewport overflow up to 3px are reported; text has a 2px width reserve | Any unsupported painted child/style rolls back and rasterizes only the diagram, including CSS rectangle geometry that differs from its SVG attributes; definition/title/description nodes do not paint |
| `::marker` | Default allowlisted bullets/numbering or one character with independent font/size/color/alpha; empty/hidden marker has no bullet | Bounded marker typography, explicitly reported | Multiple characters, image/counter content, unsupported font styling or marker type captures list; non-list-item: 該当なし |
| `::first-letter`, `::first-line` | Unchanged computed text appearance: 該当なし | None silently applied to partial runs | Changed color/font/decoration/spacing/direction/box/float/vertical alignment captures containing native unit |

### Property routes (applies to every element route above)

| CSS concern | ネイティブ | 近似 | 画像化 / 該当なし |
| --- | --- | --- | --- |
| Background color / alpha | Independent solid block/group/row/column rectangles, native table cell fills, section background, exact alpha; table layers share output column boundaries | None | Inline fragmented paint, gradients, images, background-clip/origin/size/repeat/position/attachment/blend are painted as decoration; transparent/no background: 該当なし |
| Borders / radius / outline | Straight opaque solid edges, native cell borders; uniform circular block corners use `roundRect` | Cell/row alpha border over solid ancestors, reported | Dashed/double/image borders, translucent standalone edges, asymmetric/elliptical corners, outline/offset and box shadows paint decoration only. Radius without visible paint or clipping: 該当なし |
| Margin / padding / dimensions / gaps | DOM positions, textbox/cell padding and list indentation; external margins are not reapplied | Existing font metric reserve for Office line wrapping | Inline margins/padding/inline-block and unrepresentable mixed layout capture containing unit; zero/default spacing: 該当なし |
| Color / transparency | Run, fill and bullet alpha in DrawingML | Only allowlisted border compositing | Unsupported CSS color spaces in text capture native unit; box colors browser-paint as decoration; opacity 0 / invisible subtree: 該当なし |
| Font family / size / weight / style | Resolved font, run size/bold/italic and marker font/size; Marp fit scale | Local font substitution and weight 300 → regular reported | Unsupported weight/stretch/caps/variants/features/variable settings/ligatures/language overrides capture unit |
| Decoration / transform / spacing | Underline, strike, positive and bounded small negative character spacing, super/subscript | Bounded underline offset/thickness, small positive spacing, numeric metrics, selected features/kerning/rendering/smoothing | Unsupported decoration color/style/overline/emphasis/stroke/fill, text-transform, word-spacing, indentation or spacing beyond bounds capture unit; none/default: 該当なし |
| Direction / writing mode | Horizontal LTR, supported bidi defaults | None | RTL/vertical writing, unsupported orientation/combine/bidi capture text unit; browser-inapplicable pseudo properties: 該当なし |
| White-space / wrapping | Uniform normal/pre/pre-wrap/nowrap without preserved tabs; measured line-height; soft BR/newline breaks | Native fonts have documented metric reserve | Mixed whitespace, break-spaces/pre-line, preserved tabs, word-break/line-break/hyphens/text-wrap-style outside allowlist capture unit |
| Overflow / ellipsis / clamp | Overflow visible, or nonvisible overflow with no clipped content | SVG text bearings up to 3 CSS px outside the viewport, reported | Other actual overflow clipping (scroll extent and painted descendant bounds), legacy clip, ellipsis, line-clamp capture containing unit; no clipping: 該当なし |
| List symbols / counters | Allowlisted list types, numbering start/level, single character marker and measured glyph/space advance | Marker typography uses same bounded rules; default disc uses Verdana U+2022 at 110%, reported | Custom list-style-image, arbitrary counters/content, reversed/inside numbering or unknown type captures list; marker none/display other than list-item: 該当なし |
| Display / visibility | Block coordinates; table/list structural validation; visible descendants of unpainted wrappers handled explicitly | None | Hidden inline layout or nonrectangular hidden table captures unit; display:none/content-visibility:hidden/opacity:0 skip subtree; inherited visibility is checked on each descendant |
| Transform / opacity / filter | SVG geometry supports uniform positive screen scale/translation; none/default: 該当なし | None | Other transforms including individual translate/rotate/scale/perspective, partial opacity, filter, clip-path/mask and related compositing capture affected unit; section context captures slide |
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


## Reference-converter parity (2026-10-22)

`inspect-chrome.mjs` launches its own headless Chrome/profile, uses the production
measurement/generation pipeline, and closes Chrome and Vite in `finally`. It adds
no npm dependency. Outputs stay in a temporary inspection directory: PPTX,
model/report JSON, standalone measured HTML and 2x Marp DOM PNGs. `onInspect` is
also available on `ExportOptions` for a caller-provided diagnostics sink; sink
failures propagate. These artifacts contain document content and are not committed.

```powershell
node src/export/pptx/inspect-chrome.mjs input.md --inspect-dir "$env:TEMP/slideapp-parity"
node src/export/pptx/inspect-chrome.mjs --fixtures
powershell -NoProfile -File src/export/pptx/audit-powerpoint.ps1 -InputDir <fixture-output> -All
```

`parity.md` is a synthetic fixture, not a copy of private presentation material.
It covers rounded HTML boxes with block children, SVG groups/boxes/text/elbow
paths/arrowheads, dashed borders, nowrap tables, explicit BRs and local fallback
for an unsupported circle. `parity.test.ts` additionally checks transactional
fallback, malformed paths, reverse line directions, OOXML and SVG allowlist safety.

Connected stroked subpaths (including closed `Z/z` paths) use one editable
`custGeom` per subpath, at every stroke width. Independent straight subpaths keep
their native line shapes. A path with multiple subpaths and a translucent stroke
(from `stroke-opacity` or stroke color alpha) rasterizes its entire SVG with a
reported reason: splitting one stroke across shapes compounds alpha at overlaps.
Separate path elements retain independent native alpha, so their overlaps remain
darker as in SVG. Opaque strokes retain the native conversion above.
Default or explicit path fill is ignored only when every subpath's vertices are
collinear, proving zero fill area even after implicit closure. This also covers
backtracking, point-only and closed collinear paths. Open elbows, filled polygons
and self-intersections still rasterize the entire SVG; zero total signed area
alone is insufficient. Before screen transforms, finite parsed IEEE 754 coordinates
are expressed exactly as BigInt multiples of 2^-1074 and their cross products are
compared without an epsilon. Cancellation, underflow or a tiny deviation cannot
turn nonzero area into an accepted zero; decimal inputs that are only nearly
collinear in their parsed binary representation conservatively rasterize.
PptxGenJS 4.0.1 has no shape join/cap API, so the existing
JSZip/OOXML pass adds explicit flat caps and `a:miter` (with `lim` in 1/1000 percent),
`a:round` or `a:bevel` only to named SVG path shapes. Miter limits use the SVG ratio
multiplied by 100000. Segment corners and actual miter tips participate in viewport
clipping checks; clipped stroke paint still rasterizes the diagram.
See [DrawingML miter](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.miter)
and [SVG stroke joins](https://www.w3.org/TR/SVG/painting.html#StrokeLinejoinProperty).
Per SVG's vertex marker rules,
`marker-end` applies only to the final vertex of the entire path, and `marker-start`
only to the first vertex, not to each subpath (issue #12's second finding was a
false positive, confirmed in Chrome and the SVG specification). Start/mid markers
retain the existing raster fallback. Their presentation attributes remain in the
shared preview/export HTML allowlist because dropping them would silently remove
visible arrows before either renderer can preserve them. `stroke-miterlimit` also
survives the allowlist for native joins and faithful fallback.

`tests/fixtures/export/path-joins.md` covers 1px/2px connectors, thick miter/round/
bevel corners, miter limits 1/4/10, closed paths, reverse coordinates and separate
subpaths. Export it with `inspect-chrome.mjs`, then run `audit-powerpoint.ps1 -All`:
the audit checks native labels and changes/restores freeform nodes in memory.
The installed PowerPoint verification retained all 12 paths and 5 editable text
shapes with zero rasterized elements. PNG inspection confirmed complete thick
corners, closed joins, round/bevel styles and the miter-limit cutoff.

`tests/fixtures/export/path-alpha.md` reproduces overlapping subpaths in one
translucent path, separate translucent path elements, and mixed closed/open
subpaths. The first and third slides rasterize their SVG; the second retains two
editable freeforms. `audit-powerpoint.ps1 -All` samples the exported PowerPoint
PNGs and records `strokeColors` in `com-metrics.json`: a single path stays
RGB(255,127,127) at both single and overlapping strokes; separate path elements
produce RGB(255,63,63) at the overlap. Installed PowerPoint confirmed these colors,
including the supplied `alpha-probe.md` reproduction, and retained the existing
fixture's 12 editable freeforms and 5 editable text shapes.

`tests/fixtures/export/path-default-fill.md` covers issue #22's omitted-fill line,
an identical `fill="none"` control, collinear/backtracking/closed/multiple subpaths,
and the atomic raster fallback for an open elbow and a zero-signed-area bow tie.
Export it with `inspect-chrome.mjs`, then run `audit-powerpoint.ps1 -All`.
The audit requires zero pictures and two editable labels on each of the first
three slides, changes/restores native lines and freeform nodes as well as labels,
and requires identical PowerPoint PNGs for the omitted-fill and `none` controls.
Installed PowerPoint passed these checks: the third slide retains three editable
freeforms and two native lines. The final two slides each retain one picture,
preserving their visible fill. `com-metrics.json` records the edit checks/counts
and the control comparison under `defaultFill`.

Comparison with the supplied reference converter's existing 8-slide PPTX used
installed PowerPoint COM (2560×1440 PNG) and the reference converter's Marp DOM
screenshots. All outputs are under the private temporary inspection directory.
The reference project, input and existing PPTX were only read.

| Whole-deck measurement | Reference | SlideApp |
| --- | ---: | ---: |
| Shapes | 139 | 181 |
| `HasTextFrame` shapes (including empty native boxes/lines) | 136 | 178 |
| Shapes containing editable text | 93 | 93 |
| Native tables | 2 | 2 |
| Pictures | 1 | 1 |
| Mean absolute RGB difference from Marp (0–255, lower is better) | 6.6623 | 6.6092 |

The cover and SVG slide are pixel-identical to reference PowerPoint output.
Slides 2 and 8 have small pixel-score increases (0.027 and 0.003 respectively),
while the whole-deck mean improves. The total-shape increase comes mainly from
independently editable table paint; it is not an increase in text content.
No whole-slide or diagram images are used in this acceptance deck. The existing
image's CSS border/radius/shadow stays browser-painted in the image surface,
which preserves its appearance without increasing the picture count.

Reference differences deliberately retained: preserved tabs are rasterized rather
than expanded using character counts, since proportional/mixed-font tab advances
cannot be reconstructed by counting characters. Image shadows stay browser-painted
rather than using PowerPoint's different blur model. Merged/hidden/irregular tables
retain conservative per-table fallback. The installed-font/generic font mapping,
measured table padding, notes and local image embedding were already supported.
