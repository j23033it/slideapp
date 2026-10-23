---
marp: true
theme: default
style: |
  section { padding: 40px; font-family: Arial; }
  svg { display: block; width: 1200px; height: 520px; overflow: visible; }
  svg path { fill: none; stroke: #d02020; stroke-width: 24px; }
  svg text { font-family: Arial; font-size: 22px; fill: #111; }
---
# Editable SVG joins

<svg viewBox="0 0 1200 520" xmlns="http://www.w3.org/2000/svg">
<text x="20" y="30">1px / 2px connectors</text>
<path d="M20 60 H110 V140 H160" stroke-width="1" style="stroke-width:1px"/>
<path d="M20 180 H110 V260 H160" stroke-width="2" style="stroke-width:2px"/>
<text x="240" y="30">Miter / round / bevel</text>
<path d="M240 60 H340 V140"/>
<path d="M240 200 H340 V280" stroke-linejoin="round"/>
<path d="M240 340 H340 V420" stroke-linejoin="bevel"/>
<text x="450" y="30">Miter limits 1 / 4 / 10</text>
<path d="M450 80 H570 L470 120" stroke-miterlimit="1"/>
<path d="M450 220 H570 L470 260" stroke-miterlimit="4"/>
<path d="M450 360 H570 L470 400" stroke-miterlimit="10"/>
<text x="760" y="30">Closed / reverse / subpaths</text>
<path d="M760 80 H860 V180 Z"/>
<path d="M900 280 H760 V220"/>
<path d="M760 360 H860 V400 M960 360 H1060 V400"/>
</svg>
