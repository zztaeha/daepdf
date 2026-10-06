import type { BoxShadow, Corner, ResolvedRadius } from '../types/index.js'
import { anyRadius } from '../types/index.js'
import type { PdfDoc } from '../pdf_doc/index.js'

// a shadow layer expands the silhouette outward — rounded corners grow with it,
// square corners stay square (growing a zero radius would round them)
function grownCorner(c: Corner, by: number): Corner {
  if (c.h <= 0 || c.v <= 0) return { h: 0, v: 0 }
  return { h: Math.max(0, c.h + by), v: Math.max(0, c.v + by) }
}

// opacity and blend: the element's own, which apply to its shadows as to the rest of it
export function emitShadows(
  doc: PdfDoc,
  shadows: BoxShadow[],
  x: number, y: number, w: number, h: number,
  rr: ResolvedRadius,
  opacity = 1, blend?: string,
): void {
  const rounded = anyRadius(rr)
  for (const sh of shadows) {
    const sx  = x + sh.x, sy = y + sh.y
    const ext = sh.spread ?? 0
    // capped — an unclamped author blur value would otherwise emit a
    // proportionally unbounded number of border_ring/rounded_rect draw ops
    // per shadow layer; 60 steps (120pt of blur) is already well past where
    // additional bands are visually distinguishable
    const steps = Math.min(60, Math.max(1, Math.ceil(sh.blur / 2)))
    // The 0.4 below is there because a blur is approximated by stacking layers
    // whose alphas accumulate. A single layer accumulates with nothing, so a
    // shadow with no blur – a solid offset copy of the silhouette – came out at
    // 40% of the alpha the author asked for. Layer counts of 2 and 3 are still
    // under strength for the same reason; correcting the whole ramp would move
    // every blurred shadow in the codebase and there is no visual harness right
    // now to catch a regression, so only the no-falloff case is handled here.
    const layerAlpha = (i: number): number =>
      opacity * sh.color[3] / 255 * (steps === 1 ? 1 : (i / steps) * 0.4)

    if (sh.inset) {
      // Inset: clip to box interior so the shadow layers only appear inside the box
      doc.save_graphics_state()
      if (rounded) {
        doc.set_clip_rounded_rect(x, y, w, h, rr.tl, rr.tr, rr.br, rr.bl)
      } else {
        doc.set_clip_rect(x, y, w, h)
      }
    } else {
      // Outer: the spec clips the shadow out of the border-box area — without this,
      // the stacked layers visibly tint the interior of any box whose background is
      // transparent or translucent (an opaque background merely hid them)
      doc.save_graphics_state()
      doc.set_clip_outside_rounded_rect(x, y, w, h, rr.tl, rr.tr, rr.br, rr.bl)
    }

    // real alpha compositing (already used elsewhere for CSS opacity via ExtGState)
    // over whatever is actually underneath, instead of pre-blending the shadow color
    // toward a hardcoded white background — which showed a visible white halo/fringe
    // on any non-white surface.
    doc.set_fill_color(sh.color[0], sh.color[1], sh.color[2])
    if (sh.inset) {
      // an inset shadow darkens inward from each edge — an expanded rect clipped to
      // the box would tint the whole box uniformly instead. Overlapping rings of
      // growing width accumulate alpha toward the edge, approximating the falloff.
      // A negative spread can push the band width below zero, which would invert the
      // even-odd ring fill — clamp it away.
      for (let i = steps; i >= 1; i--) {
        const alpha = layerAlpha(i)
        const band  = Math.max(0, (sh.blur / steps) * (steps - i + 1) * 0.5 + ext)
        if (!band) continue
        doc.set_alpha(alpha, blend)
        doc.border_ring(sx, sy, w, h, rr.tl, rr.tr, rr.br, rr.bl, band)
      }
    } else {
      // a rounded box's shadow follows the rounded silhouette — square layers poke
      // out visibly past the corners; the radius grows with each layer's expansion
      // (never below zero: a negative spread larger than the blur would otherwise
      // build a self-crossing path or a negative-size rect)
      for (let i = steps; i >= 1; i--) {
        const alpha  = layerAlpha(i)
        const expand = (sh.blur / steps) * (steps - i + 1) * 0.5
        const grow   = expand + ext
        const gw = w + grow * 2, gh = h + grow * 2
        if (gw <= 0 || gh <= 0) continue
        doc.set_alpha(alpha, blend)
        if (rounded) {
          doc.rounded_rect(sx - grow, sy - grow, gw, gh,
            grownCorner(rr.tl, grow), grownCorner(rr.tr, grow),
            grownCorner(rr.br, grow), grownCorner(rr.bl, grow))
        } else {
          doc.rect(sx - grow, sy - grow, gw, gh)
        }
      }
    }
    doc.set_alpha(1.0)

    doc.restore_graphics_state()
  }
}
