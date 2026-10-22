---
marp: true
theme: default
style: |
  section { font-family: Arial; padding: 40px; }
  .flow { display: block; width: 900px; height: 300px; }
  .flow text { font-family: Arial; font-size: 22px; fill: #111; text-anchor: middle; }
  .flow .edge { fill: none; stroke: #444; stroke-width: 2; marker-end: url(#fixture-arrow); }
  .counts { display: flex; gap: 24px; }
  .counts .cell { border: 2px solid #444; border-radius: 8px; width: 200px; padding: 8px; text-align: center; font-size: 24px; }
  .counts strong { display: block; font-size: 36px; }
  .label { white-space: nowrap; }
  th, td { white-space: nowrap; }
---
# Editable flow

<svg class="flow" viewBox="0 0 900 300" xmlns="http://www.w3.org/2000/svg">
<defs><marker id="fixture-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#444"/></marker></defs>
<g transform="translate(20 10)">
<rect x="10" y="20" width="230" height="100" rx="20" fill="#eef4ff" stroke="#444"/>
<text x="125" y="65">Input</text><text x="125" y="95">Editable label</text>
<rect x="400" y="150" width="250" height="100" rx="10" fill="#fff" stroke="#444" stroke-width="1.5" stroke-dasharray="6 4"/>
<text x="525" y="205">Output</text>
<path class="edge" d="M240,70 H320 V200 H398"/>
</g>
</svg>

---
# Native rounded boxes

<div class="counts"><div class="cell">First set<strong>12 items</strong></div><div class="cell">Second set<strong>24 items</strong></div></div>

<div class="label">One line without wrapping</div>

| Category | Value |
| --- | ---: |
| Alpha<br>Beta | 36 |

---
# Local fallback

The unsupported circle affects only the following diagram.

<svg viewBox="0 0 400 180" width="400" height="180" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="180" fill="#eef4ff"/><circle cx="100" cy="90" r="40" fill="#f90"/><text x="180" y="90">Raster label</text></svg>

This text remains editable.<br><br>
