import { domRectToPt, paginateSpan, stackOpacity, stackBlend, type WalkerCtx } from './types.js'
import { paintNode, canvasToPngBytes } from './canvaspaint.js'
import type { ImageCommand } from '../types/index.js'

export function hasFilter(s: CSSStyleDeclaration): boolean {
  return !!s.filter && s.filter !== 'none'
}

// How far blur() and drop-shadow() paint outside the box, in px: a blur reaches about three
// standard deviations, a shadow its offset plus its own blur
function filterReach(filter: string): number {
  let reach = 0
  for (const m of filter.matchAll(/(blur|drop-shadow)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const px = [...(m[2] ?? '').matchAll(/(-?[\d.]+)px/g)].map(n => Math.abs(parseFloat(n[1]!)))
    reach += m[1] === 'blur' ? 3 * (px[0] ?? 0) : Math.max(px[0] ?? 0, px[1] ?? 0) + 3 * (px[2] ?? 0)
  }
  return Math.ceil(reach)
}

// CSS filter has no PDF operator equivalent, so the element is rasterized
// (see canvaspaint.ts for the painter and why it isn't foreignObject-based),
// on a canvas grown by whatever the filter paints outside the box.
export function emitFilteredElement(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx): void {
  const box = el.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return
  const pad = filterReach(s.filter)
  const domRect = new DOMRect(box.left - pad, box.top - pad, box.width + 2 * pad, box.height + 2 * pad)
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)

  // 3x the CSS pixel size, matching svg.ts's own inline-SVG rasterization DPI
  const dpr = 3
  const cw = Math.max(1, Math.round(domRect.width * dpr))
  const ch = Math.max(1, Math.round(domRect.height * dpr))

  // from the element's own document: paintNode's ctx.font only sees fonts loaded there
  const doc     = el.ownerDocument
  const source  = doc.createElement('canvas')
  source.width  = cw
  source.height = ch
  paintNode(el, source.getContext('2d')!, domRect, dpr)

  // filter applies ONCE to the whole composited element, not per shape —
  // painted unfiltered onto `source` above, then drawn through onto this
  // second canvas with the filter active for that single drawImage call
  const filtered  = doc.createElement('canvas')
  filtered.width  = cw
  filtered.height = ch
  const fctx = filtered.getContext('2d')!
  // canvas filter lengths are canvas pixels, which are dpr times smaller than CSS px here
  fctx.filter = s.filter.replace(/(-?[\d.]+)px/g, (_, n: string) => `${parseFloat(n) * dpr}px`)
  fctx.drawImage(source, 0, 0)

  const src = canvasToPngBytes(filtered)
  if (!src) return /* tainted canvas (e.g. a cross-origin image child) */

  const opacity = stackOpacity(ctx)
  for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
    ctx.commands.push({ type: 'image', page, src, format: 'png', x, y: ly, w, h, opacity, blend: stackBlend(ctx) } as ImageCommand)
  }
}
