// Review reproductions run in real WebView2, alongside the representative fixtures.
export const regressionCases = {
 'section-border':'<style>section {border:5px dashed red;border-radius:20px;background-color:rgba(0,0,255,.2);box-shadow:inset 0 0 8px black}</style>\n\n# Editable section border\n\nNative paragraph',
 'block-background':'<style>h1 {background-image:linear-gradient(90deg,#fea,#aef);border-radius:12px;border:2px dashed #888}</style>\n\n# Editable decorated heading\n\nNative paragraph',
 'list-background':'<style>ul {background-image:linear-gradient(90deg,#fea,#aef);border-radius:12px}</style>\n\n# Editable decorated list\n\n- Parent\n  - Child\n- Next',
 'hidden-table-row':'<style>tbody tr:first-child {display:none}</style>\n\n# Hidden row\n\n| A | B |\n| --- | --- |\n| HIDDEN_ROW | HIDDEN_CELL |\n| VISIBLE_ROW | PRESENT |',
 'hidden-table-cell':'<style>td:first-child {visibility:hidden}</style>\n\n| A | B |\n| --- | --- |\n| HIDDEN_CELL | PRESENT |',
 'greek-list':'<style>ol {list-style-type:lower-greek}</style>\n\n# Greek list\n\n1. Alpha\n2. Beta',
 'leading-zero-list':'<style>ol {list-style-type:decimal-leading-zero}</style>\n\n1. One\n2. Two',
 'native-table':'<style>table {font-variant-numeric:normal!important} table,thead,tbody,tr {border:0!important} td,th {vertical-align:top!important;border:1px solid rgb(0,0,0)!important}</style>\n\n| A | B |\n| --- | --- |\n| Editable | PRESENT |',
 'unsupported-text-values':'<style>strong {font-weight:500} em {font-style:oblique} p {white-space:break-spaces}</style>\n\n# Native heading\n\nBefore **medium** and *slanted* after\n\n---\n\n# Still exported',
 'unsupported-color':'<style>strong {color:color(display-p3 1 0 0)}</style>\n\n# Native heading\n\nBefore **P3 RED** after',
 'hidden-content':'<style>h1 {content-visibility:hidden} p:first-of-type {visibility:collapse} ul {content-visibility:hidden} img {display:none}</style>\n\n# HIDDEN_HEADING\n\nHIDDEN_PARAGRAPH\n\n- HIDDEN_LIST\n\n![width:80px](./does-not-exist.png)\n\nVisible ending',
 'hidden-decoration':'<style>strong {content-visibility:hidden} strong::before {content:url("./does-not-exist.png")}</style>\n\n# Visible heading\n\nBefore **HIDDEN_DECORATION** after',
 'failed-element':'# Native heading\n\n![width:80px](./does-not-exist.png)\n\nNative ending\n\n---\n\n# Still exported',
 'hidden-list-parent':'<style>section > ul > li:first-child {display:none}</style>\n\n# Hidden list parent\n\n- HIDDEN_PARENT\n  - HIDDEN_CHILD\n    - HIDDEN_GRANDCHILD\n- Visible item\n  - Visible child',
 'half-alpha-background':'<style>section {background-color:rgba(255,0,0,.5);background-image:none}</style>\n\n# Translucent background\n\nEditable text on pink',
'table-image':'# Table image\n\n| Icon | Label |\n| --- | --- |\n| ![width:60px](./picture.png) | PRESENT |',
 'hidden':'<style>strong {display:none} em {visibility:hidden}</style>\n\n# Visible\n\nBefore **HIDDEN_BOLD** after *HIDDEN_ITALIC* end',
 'inline-fill':'<style>strong {background-color:yellow;color:red}</style>\n\n# Inline fill\n\nBefore **HIGHLIGHT** after',
 'loose-list':'- One\n\n  Paragraph two\n\n  - Nested\n\n  After nested\n\n- Next',
 'whitespace':'# Spaces\n\nA ** B ** C\n\nA <strong> B </strong> C\n\nText\n** bold** tail',
 'divider':'---\nheadingDivider: 1\npaginate: true\n---\n# One\n\n<!-- first note & <tag> -->\n\nText\n\n# Two\n\n<!-- second note -->\n\nMore',
 'transparent-text':'<style>strong {color:transparent}</style>\n\n# Transparent\n\nBefore **INVISIBLE** after',
 'section-css':'<style>section {transform:rotate(5deg); opacity:.3}</style>\n\n# Rotated\n\nNormal text',
 'section-pseudo':'<style>section::before {content:"";position:absolute;width:200px;height:40px;background:red;top:20px;left:20px}</style>\n\n# Background box',
 'long-list':'# Multi-line\n\n- **First** item\n  line two  \n  line three\n- Next',
 'special-chars':'# Special & <> 日本語\n\n**a & < > "** [Link](https://example.com/?a=1&b=2)\n\n<!-- Note & < > "\nnewline -->',
 'nested-bg':'<style>strong {padding:10px;border-bottom:3px solid red}</style>\n\n# Underline\n\nA **word** B',
'inline-image':'# Inline image\n\nBefore ![width:100px](./picture.png) AFTER_IMAGE',
 'list-heading':'# List\n\n- First\n\n  ## LOST_HEADING\n\n  Continuation\n\n- Last',
 'pseudo-img':'<style>h1::before {content:url("./picture.png");display:inline-block;width:100px;height:100px}</style>\n\n# Pseudo picture',
 'pseudo-bg':'<style>h1::before {content:"X";display:inline-block;width:100px;height:100px;background-image:url("./picture.png");background-size:cover}</style>\n\n# Pseudo background',
 'raster-shadow':'<style>h1 {box-shadow: 20px 0 0 red;}</style>\n\n# Shadow',
 'text-transform':'<style>strong {text-transform:uppercase}</style>\n\n# Casing\n\nBefore **upper_case** after',
 'pseudo-empty':'<style>h1::before {content:"";display:block;width:200px;height:40px;background:red;}</style>\n\n# Missing red box',
 'masked-image':'<style>img {mask-image:linear-gradient(black,transparent);}</style>\n\n# Mask\n\n![width:100px](./picture.png)',
 'table-style':'<style>td {vertical-align:bottom;height:150px;}</style>\n\n| A | B |\n| --- | --- |\n| LOW | HIGH |',
 'half-alpha':'<style>strong {color:rgba(255,0,0,.25)}</style>\n\n# Alpha\n\nBefore **FAINT** after',
 'section-filter':'<style>section {filter:blur(2px)}</style>\n\n# Blurred slide\n\nText',
 'raster-filter':'<style>h1 {filter:drop-shadow(30px 8px 4px red) blur(1px)}</style>\n\n# Filter',
 'section-effects-bg':'---\ntheme: gaia\n---\n<style>section {opacity:.5;transform:rotate(3deg)}</style>\n\n# Gaia effects',
 'pseudo-overflow':'<style>h1::before {content:"";position:absolute;left:-25px;top:-20px;width:200px;height:40px;background:red}</style>\n\n# Overflow',
}

// Same ordinary content must stay editable under every built-in theme.
for (const theme of ['default', 'gaia', 'uncover']) {
  regressionCases[`native-${theme}-theme`] = `---
marp: true
theme: ${theme}
paginate: true
---
# Editable heading 日本語

Editable paragraph **bold** *italic* [LINK](https://example.com/)

---
## Editable list

- Parent
  - Child
- Next

3. Third
4. Fourth

---
## Editable table

| Name | Value |
| :--- | ---: |
| Editable cell | **42** |
| Japanese 日本語 | 123 |
`
}
