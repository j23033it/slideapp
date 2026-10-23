import { Marp } from '@marp-team/marp-core'

/** Opt-in for a preview/export pair that supports diagrams; never html:true.
 * No scripts, external references, animation or foreignObject are admitted.
 * Unsupported safe primitives remain available for per-diagram raster fallback.
 */
export const svgHtmlAllowlist = {
  ...Marp.html,
  svg: ['id', 'class', 'style', 'xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio'],
  ...Object.fromEntries(['g', 'rect', 'path', 'text', 'tspan', 'circle', 'ellipse', 'line', 'polygon', 'polyline'].map(tag => [tag,
    ['id', 'class', 'style', 'transform', 'x', 'y', 'dx', 'dy', 'width', 'height', 'rx', 'ry', 'cx', 'cy', 'r', 'x1', 'x2', 'y1', 'y2', 'd', 'points', 'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'text-anchor', 'font-family', 'font-size', 'font-weight', 'marker-start', 'marker-mid', 'marker-end', 'opacity']])),
  defs: [], title: [], desc: [],
  marker: ['id', 'viewBox', 'refX', 'refY', 'markerWidth', 'markerHeight', 'markerUnits', 'orient'],
}
