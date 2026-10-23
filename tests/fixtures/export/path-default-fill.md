---
marp: true
style: |
  section { padding:40px; font-family:Arial; }
  svg { display:block; width:1000px; height:450px; overflow:visible; }
---
<!-- Default black fill on a single line must not rasterize either label. -->

<svg viewBox="0 0 800 360"><rect x="40" y="50" width="190" height="80" fill="#eff6ff"/><rect x="350" y="50" width="190" height="80" fill="#eff6ff"/><text x="80" y="100" font-size="28">Source</text><path d="M 230 90 L 350 90" stroke="#2563eb" stroke-width="4"/><text x="390" y="100" font-size="28">Target</text></svg>

---
<!-- Explicit fill:none control: identical paint to slide 1. -->

<svg viewBox="0 0 800 360"><rect x="40" y="50" width="190" height="80" fill="#eff6ff"/><rect x="350" y="50" width="190" height="80" fill="#eff6ff"/><text x="80" y="100" font-size="28">Source</text><path d="M 230 90 L 350 90" fill="none" stroke="#2563eb" stroke-width="4"/><text x="390" y="100" font-size="28">Target</text></svg>

---
<!-- Collinear vertices, backtracking, closed and independent subpaths. -->

<svg viewBox="0 0 800 360"><text x="40" y="50" font-size="28">Source</text><path d="M100 90 H200 H150 H350" stroke="#2563eb" stroke-width="4"/><path d="M100 140 L150 165 L200 190 L300 240" stroke="#2563eb" stroke-width="4"/><path d="M400 90 V200 V150 Z" stroke="#2563eb" stroke-width="4"/><path d="M450 90 H650 M700 90 V240" stroke="#2563eb" stroke-width="4"/><text x="540" y="290" font-size="28">Target</text></svg>

---
<!-- Implicitly closed elbow has area: retain atomic raster fallback. -->

<svg viewBox="0 0 800 360"><text x="40" y="50" font-size="28">Source</text><path d="M230 90 H350 V210" stroke="#2563eb" stroke-width="4"/><text x="390" y="250" font-size="28">Target</text></svg>

---
<!-- A bow tie has zero signed area, but its lobes still paint black. -->

<svg viewBox="0 0 800 360"><text x="40" y="50" font-size="28">Source</text><path d="M230 90 L350 210 L230 210 L350 90" stroke="#2563eb" stroke-width="4"/><text x="390" y="250" font-size="28">Target</text></svg>
