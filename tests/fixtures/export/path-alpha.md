---
marp: true
style: |
  section { padding:40px; font-family:Arial; }
  svg { display:block; width:1000px; height:500px; overflow:visible; }
---
# One path: uniform translucent stroke

<svg viewBox="0 0 1000 500"><path d="M100 100 H300 V300 H100 Z M200 100 H400 V300 H200 Z" fill="none" stroke="red" stroke-width="24" stroke-opacity="0.5"/></svg>

---
# Separate paths: darker overlap

<svg viewBox="0 0 1000 500"><path d="M100 100 H300 V300 H100 Z" fill="none" stroke="red" stroke-width="24" stroke-opacity="0.5"/><path d="M200 100 H400 V300 H200 Z" fill="none" stroke="red" stroke-width="24" stroke-opacity="0.5"/></svg>

---
# One path: closed and open subpaths

<svg viewBox="0 0 1000 500"><path d="M100 100 H300 V300 H100 Z M200 100 H400 V300" fill="none" stroke="red" stroke-width="24" stroke-opacity="0.5"/></svg>
