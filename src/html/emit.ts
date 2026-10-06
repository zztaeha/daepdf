import type {
  Color, ColorAlpha, Gradient, ConicGradient, BorderRadius, Corner, FontRef, PathSeg,
  TextCommand, RectCommand, LineCommand, LinkCommand, ImageCommand, FieldCommand, PathCommand,
} from '../types/index.js'
import { LINK_SCHEMES } from '../types/index.js'
import { measure_string_width } from '../../engine.js'
import { PX_PER_PT, domRectToPt, paginate, paginateSpan, stackOpacity, stackBlend, tagStructAnnot, type WalkerCtx } from './types.js'
import {
  parseColorAlpha, parseCSSBoxShadow, parseCSSGradient, parseCSSConicGradient,
  parseBorderRadius, clampRadiusToBox, insetBorderRadius, pxToPt, splitByTopLevelComma, isTransparentColor, resolveGradientBox,
} from './css.js'
import { isSlanted, resolveFontRef, splitByFontCoverage } from './fonts.js'
import { counterText } from './counters.js'
import { hasBorderImage } from './borderimage.js'
import { emitBgImage, type BgImage } from './images.js'
import { canvasToPngBytes, fillConic } from './canvaspaint.js'

type Side = 'Top' | 'Right' | 'Bottom' | 'Left'
const perSide = <T>(f: (d: Side) => T): [T, T, T, T] => [f('Top'), f('Right'), f('Bottom'), f('Left')]

// also used for text-decoration-style, the only caller that can ever produce
// 'wavy' – CSS border-style never has that value
function normBorderStyle(s: string): 'solid' | 'dashed' | 'dotted' | 'wavy' {
  if (s === 'dashed') return 'dashed'
  if (s === 'dotted') return 'dotted'
  if (s === 'wavy') return 'wavy'
  return 'solid'
}

const BORDER_3D = new Set(['inset', 'outset', 'groove', 'ridge'])

// A rounded rect as path segments, y down; a corner with either radius at 0 is square
function roundedRectOps(x: number, y: number, w: number, h: number, r: BorderRadius | undefined): PathSeg[] {
  const K = 0.5523, a = r?.all ?? 0
  const c = (k?: Corner): Corner => { const v = k ?? { h: a, v: a }; return v.h > 0 && v.v > 0 ? v : { h: 0, v: 0 } }
  const tl = c(r?.topLeft), tr = c(r?.topRight), br = c(r?.bottomRight), bl = c(r?.bottomLeft)
  return [
    { op: 'm', args: [x + tl.h, y] },
    { op: 'l', args: [x + w - tr.h, y] },
    { op: 'c', args: [x + w - tr.h + tr.h * K, y, x + w, y + tr.v - tr.v * K, x + w, y + tr.v] },
    { op: 'l', args: [x + w, y + h - br.v] },
    { op: 'c', args: [x + w, y + h - br.v + br.v * K, x + w - br.h + br.h * K, y + h, x + w - br.h, y + h] },
    { op: 'l', args: [x + bl.h, y + h] },
    { op: 'c', args: [x + bl.h - bl.h * K, y + h, x, y + h - bl.v + bl.v * K, x, y + h - bl.v] },
    { op: 'l', args: [x, y + tl.v] },
    { op: 'c', args: [x, y + tl.v - tl.v * K, x + tl.h - tl.h * K, y, x + tl.h, y] },
  ]
}

// Chrome paints an unstyled control natively (1px gray border, 2px corners; a gray square or
// circle for a checkbox or radio) whatever its UA border says, until a border or background is set
const NATIVE_BORDER: ColorAlpha = [118, 118, 118, 255]
const BUTTON_TYPES = new Set(['button', 'submit', 'reset'])
function nativeControl(el: Element, s: CSSStyleDeclaration): 'box' | 'checkbox' | 'radio' | null {
  if ((s as any).appearance === 'none') return null
  const tag = el.tagName.toUpperCase()
  const type = tag === 'INPUT' ? (el as HTMLInputElement).type : ''
  if (type === 'checkbox' || type === 'radio') return s.borderTopStyle === 'none' ? type : null
  if (tag !== 'INPUT' && tag !== 'BUTTON' && tag !== 'SELECT' && tag !== 'TEXTAREA') return null
  const uaBackground = tag === 'BUTTON' || BUTTON_TYPES.has(type) ? 'rgb(239, 239, 239)' : 'rgb(255, 255, 255)'
  if (s.backgroundColor !== uaBackground || s.backgroundImage !== 'none') return null
  const ua = s.borderTopStyle === 'inset' || s.borderTopStyle === 'outset' ||
    (s.borderTopStyle === 'solid' && s.borderTopWidth === '1px' && s.borderTopColor === 'rgb(118, 118, 118)')
  return ua ? 'box' : null
}

// Blink's Color::Dark()/Light(): scale the channels so the brightest moves by 0.33
const scaleRGB = ([r, g, b, a]: ColorAlpha, k: number): ColorAlpha =>
  [Math.floor(r / 255 * k * 255.99998), Math.floor(g / 255 * k * 255.99998), Math.floor(b / 255 * k * 255.99998), a]
function darker(c: ColorAlpha): ColorAlpha {
  const v = Math.max(c[0], c[1], c[2]) / 255
  return v === 1 && c[0] === c[1] && c[1] === c[2] ? [171, 171, 171, c[3]] : scaleRGB(c, v ? Math.max(0, (v - 0.33) / v) : 0)
}
function lighter(c: ColorAlpha): ColorAlpha {
  const v = Math.max(c[0], c[1], c[2]) / 255
  return v ? scaleRGB(c, Math.min(1, v + 0.33) / v) : [84, 84, 84, c[3]]
}
const luminance = ([r, g, b]: ColorAlpha): number => {
  const lin = (ch: number) => { const v = ch / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const TOO_DARK  = luminance([32, 32, 32, 255])
const TOO_LIGHT = luminance([235, 235, 235, 255])

// The shadowed and lit edge colors Chrome paints for inset/outset/groove/ridge
function border3dShades(c: ColorAlpha): { dark: ColorAlpha; light: ColorAlpha } {
  const lum = luminance(c)
  if (lum <= TOO_DARK) { const dark = lighter(c); return { dark, light: lighter(dark) } }
  return { dark: darker(c), light: lum > TOO_LIGHT ? c : lighter(c) }
}

// Bands of one side as [from, to] depth fractions, each shadowed or lit: top/left are
// shadowed for inset, bottom/right for outset; groove and ridge split the width in two
function border3dBands(style: string, side: number): [number, number, boolean][] {
  const topLeft = side === 0 || side === 3
  if (style === 'inset')  return [[0, 1, topLeft]]
  if (style === 'outset') return [[0, 1, !topLeft]]
  const outerDark = style === 'groove' ? topLeft : !topLeft
  return [[0, 0.5, outerDark], [0.5, 1, !outerDark]]
}

// A3 (bidi): strong-RTL Unicode blocks (Hebrew, Arabic + its extensions/
// presentation forms, Syriac, Thaana, N'Ko, Samaritan, Mandaic — deliberately
// bounded, not a full UAX#9 bidi-class table, since only "is this paragraph
// direction-homogeneous" needs answering here, not full-spec classification)
const RTL_RANGES: [number, number][] = [
  [0x0591, 0x08FF], // Hebrew through Arabic Extended-A
  [0xFB1D, 0xFDFF], // Hebrew + Arabic presentation forms-A
  [0xFE70, 0xFEFF], // Arabic presentation forms-B
]
function isStrongRTL(cp: number): boolean {
  return RTL_RANGES.some(([a, b]) => cp >= a && cp <= b)
}

// A character's own direction: strong RTL script, or digits and other letters (which run left
// to right even inside RTL text); null for neutrals, which take their neighbors' direction
function charDirection(ch: string): 'ltr' | 'rtl' | null {
  // digits first: Arabic-Indic ones sit inside the RTL script ranges yet still run left to right
  if (/\p{Nd}/u.test(ch)) return 'ltr'
  if (isStrongRTL(ch.codePointAt(0)!)) return 'rtl'
  return /\p{L}/u.test(ch) ? 'ltr' : null
}

// `text` split where the direction changes; neutrals join the run before them (or after,
// at the start), and an all-neutral text takes the paragraph's direction
function directionRuns(text: string, paraDir: 'ltr' | 'rtl'): { text: string; dir: 'ltr' | 'rtl' }[] {
  const runs: { text: string; dir: 'ltr' | 'rtl' | null }[] = []
  for (const ch of text) {
    const dir = charDirection(ch), last = runs.at(-1)
    if (last && (dir === null || last.dir === null || dir === last.dir)) { last.text += ch; last.dir ??= dir; continue }
    runs.push({ text: ch, dir })
  }
  return runs.map(r => ({ text: r.text, dir: r.dir ?? paraDir }))
}

// True when `text` mixes a strong-RTL script with a strong-LTR letter — the
// case rustybuzz's own per-call script/direction auto-detection (guess_
// segment_properties) can't handle within ONE shape_text call, since it picks
// a single direction for the whole buffer. The browser's own layout already
// resolves this correctly per word (real Unicode Bidi Algorithm) — captureTextNode's
// existing per-word emission (see `perWord` below) reuses each word's own
// already-correct DOM rect for position AND already shapes each word through
// its own separate, single-script `shape_text` call, so forcing per-word mode
// for a mixed line is the complete fix, not a partial one: no new shaping or
// reordering logic needed, confirmed by direct inspection of real output
// (a forced-justify mixed-bidi line correctly interleaves LTR/RTL word
// positions matching the browser's own bidi-resolved layout) before this was
// wired in as the general fix for ANY bidi-mixed line, not just justified ones.
function hasBidiMix(text: string): boolean {
  let sawRTL = false, sawLTR = false
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (isStrongRTL(cp)) sawRTL = true
    else if (/\p{L}/u.test(ch)) sawLTR = true
    if (sawRTL && sawLTR) return true
  }
  return false
}

// parseColor() (RGB only) drops rgba()'s alpha entirely, rendering any partially
// transparent fill/stroke/text color fully opaque. Split it into the RGB triple plus
// a 0-1 alpha and fold that into the command's own `opacity`, the same mechanism
// already used for CSS `opacity` — real alpha compositing via ExtGState, not a fake blend.
function splitColorAlpha(ca: ColorAlpha | null): { color: Color | null; alpha: number } {
  if (!ca) return { color: null, alpha: 1 }
  return { color: [ca[0], ca[1], ca[2]], alpha: ca[3] / 255 }
}

function combineOpacity(base: number | undefined, extra: number): number | undefined {
  const combined = (base ?? 1) * extra
  return combined < 1 ? combined : undefined
}

// Conic gradients have no PDF shading equivalent (axial/radial only) — rasterize
// through a canvas at 3× (≈216 dpi, matching svg.ts). Cached by definition + size;
// same-page repeats (badges, chips) reuse the bytes and the PDF embeds them once.
const _conicCache = new Map<string, Uint8Array | null>()

function rasterizeConic(cg: ConicGradient, wPt: number, hPt: number): Uint8Array | null {
  if (wPt <= 0 || hPt <= 0) return null
  const key = `${JSON.stringify(cg)}|${wPt.toFixed(2)}|${hPt.toFixed(2)}`
  const hit = _conicCache.get(key)
  if (hit !== undefined) return hit

  let out: Uint8Array | null = null
  const dpr = 3
  const canvas  = document.createElement('canvas')
  canvas.width  = Math.max(1, Math.round(wPt * dpr))
  canvas.height = Math.max(1, Math.round(hPt * dpr))
  const c2d = canvas.getContext('2d')
  if (c2d && typeof c2d.createConicGradient === 'function') {
    fillConic(c2d, cg, canvas.width, canvas.height, wPt, hPt)
    out = canvasToPngBytes(canvas)
  }
  _conicCache.set(key, out)
  return out
}

// box-decoration-break: 'slice' zeroes the corners on a fragment's CUT side(s) —
// left for any line fragment but the first, right for any but the last. A middle
// fragment gets both, i.e. fully square. 'clone' (the caller's job to detect and
// simply not call this) keeps every corner, matching a standalone complete box.
function suppressRadiusSide(radius: BorderRadius | undefined, suppressLeft: boolean, suppressRight: boolean): BorderRadius | undefined {
  if (!radius || (!suppressLeft && !suppressRight)) return radius
  const a = radius.all ?? 0
  const c = (x?: Corner): Corner => x ? { h: x.h, v: x.v } : { h: a, v: a }
  const tl = c(radius.topLeft), tr = c(radius.topRight)
  const br = c(radius.bottomRight), bl = c(radius.bottomLeft)
  if (suppressLeft)  { tl.h = 0; tl.v = 0; bl.h = 0; bl.v = 0 }
  if (suppressRight) { tr.h = 0; tr.v = 0; br.h = 0; br.v = 0 }
  return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl }
}

export function emitBox(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx, bgImages?: Map<number, BgImage>): void {
  const isInline = s.display === 'inline'
  const rects    = isInline
    ? Array.from((el as HTMLElement).getClientRects())
    : [el.getBoundingClientRect()]

  const opacity = stackOpacity(ctx)
  const blend   = stackBlend(ctx)
  const boxDecorationBreak = (s as any).boxDecorationBreak === 'clone' ? 'clone' : 'slice'

  for (const [rectIndex, domRect] of rects.entries()) {
    if (domRect.width < 0.5 && domRect.height < 0.5) continue
    const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)

    const { color: bgColor, alpha: bgAlpha } = splitColorAlpha(parseColorAlpha(s.backgroundColor))
    // inline fragments can be smaller than the union rect the radius was clamped
    // against — re-clamp per fragment
    const baseRadius = isInline
      ? clampRadiusToBox(parseBorderRadius(s, el), w, h)
      : parseBorderRadius(s, el)
    const shadows = parseCSSBoxShadow(s.boxShadow)
    const bgImg   = s.backgroundImage

    // An inline box wrapped across multiple lines is fragmented along the INLINE
    // axis (left/right) — under the CSS default 'slice', only the true left edge
    // (first fragment) and true right edge (last fragment) get their corner/
    // border; a fragment's "wrong" side, or both sides for a middle fragment, are
    // square, as if the box continues past an artificial cut. Top/bottom are
    // NOT cut edges for inline fragmentation (each line is already a complete
    // line box along that axis), so they're unaffected either way. A BLOCK
    // element spanning multiple PAGES is handled separately below — the default
    // slice behavior there already falls out of drawing one continuous absolute
    // shape and letting each page's own MediaBox reveal its true portion
    // (verified directly against rendered output; see task-map.md's B12 notes),
    // so no corner suppression is needed for that case.
    const fragmented    = isInline && rects.length > 1 && boxDecorationBreak === 'slice'
    // the cut sides are the start of every fragment but the first and the end of every
    // one but the last; in RTL the start is the right side
    const startCut      = fragmented && rectIndex > 0
    const endCut        = fragmented && rectIndex < rects.length - 1
    const suppressLeft  = s.direction === 'rtl' ? endCut : startCut
    const suppressRight = s.direction === 'rtl' ? startCut : endCut
    const native = nativeControl(el, s)
    const radius = native === 'radio' ? { all: Math.min(w, h) / 2 }
      : native ? { all: pxToPt('2px') }
      : suppressRadiusSide(baseRadius, suppressLeft, suppressRight)

    const bWidths       = perSide(d => native ? pxToPt('1px') : pxToPt((s as any)[`border${d}Width`]))
    const bColorAlphas  = perSide(d => native ? NATIVE_BORDER : parseColorAlpha((s as any)[`border${d}Color`]))
    const bStyles       = perSide(d => native ? 'solid' : (s as any)[`border${d}Style`] as string)

    const allSame = bWidths.every(v => v === bWidths[0]) &&
      bStyles.every(v => v === bStyles[0]) &&
      bColorAlphas.every(c => JSON.stringify(c) === JSON.stringify(bColorAlphas[0]))
    // border_ring is a solid even-odd fill with no dash support — dashed/dotted must
    // take the line branch, which carries the dash pattern (corners go square there:
    // an approximation, but the dash pattern is the author-visible intent). 'double'
    // (the classic accounting rule) goes there too, drawn as two thin sub-lines.
    // A fragmented (sliced) box also forces the line branch regardless of style —
    // border_ring always draws all four sides as one ring, with no way to omit
    // just the cut side(s) the way the per-side line loop below can.
    const uniformSolid = !fragmented && allSame && bStyles[0] !== 'dashed' && bStyles[0] !== 'dotted' && bStyles[0] !== 'double' &&
      !BORDER_3D.has(bStyles[0])

    // background-clip: 'text' can't clip a box fill to glyph outlines in a PDF — the
    // box paints nothing but its shadow (captureTextNode substitutes the text color
    // instead); padding-box/content-box shrink the paint area and its radius. The
    // shadow always belongs to the border box, so it splits into its own command
    // whenever the fill area differs. background-clip is a per-layer list; the
    // background-color clips to the LAST layer's value per spec.
    const bgClipList = String((s as any).webkitBackgroundClip || s.backgroundClip || 'border-box')
      .split(',').map(t => t.trim())
    const bgClipText = bgClipList[bgClipList.length - 1] === 'text'
    const paintsFill = !bgClipText && !!bgColor

    // outline draws as a ring outside the border box, offset by outline-offset
    // (which may be negative, pulling the outline inside the box). Left as a
    // full ring on every fragment even when sliced — cut-edge suppression for
    // outline would need the same "stroke only some sides" primitive border
    // does not have either, and outline+inline-wrap+radius is a rare enough
    // combination that this is a documented approximation, not a fix target.
    const oWidth  = pxToPt(s.outlineWidth || '0px')
    const oStyle  = s.outlineStyle
    const oColorA = (oWidth > 0 && oStyle && oStyle !== 'none') ? parseColorAlpha(s.outlineColor) : null
    const oGrow   = oColorA ? pxToPt(s.outlineOffset || '0px') + oWidth : 0
    let oRadius: typeof radius
    if (oColorA && radius) {
      const a = radius.all ?? 0
      // rounded corners grow with the outline's offset ring; square corners stay square
      const grown = (c?: Corner): Corner => {
        const base = c ?? { h: a, v: a }
        if (base.h <= 0 || base.v <= 0) return { h: 0, v: 0 }
        return { h: Math.max(0, base.h + oGrow), v: Math.max(0, base.v + oGrow) }
      }
      oRadius = {
        topLeft:     grown(radius.topLeft),
        topRight:    grown(radius.topRight),
        bottomRight: grown(radius.bottomRight),
        bottomLeft:  grown(radius.bottomLeft),
      }
    }

    // Background color, then image layers last to first, each clipped to its own
    // background-clip box, all under the border; per height, for clone fragments
    interface BgLayer { gradient?: Gradient; conicSrc?: Uint8Array; url?: BgImage; index?: number; box: { dx: number; dy: number; w: number; h: number; radius?: BorderRadius | undefined } }
    const computeGeom = (effH: number) => {
      const clipBoxFor = (kind: string) => {
        const box = { dx: 0, dy: 0, w, h: effH, radius }
        if (kind !== 'padding-box' && kind !== 'content-box') return box
        const pad = kind === 'content-box'
        const iT = bWidths[0] + (pad ? pxToPt(s.paddingTop    || '0px') : 0)
        const iR = bWidths[1] + (pad ? pxToPt(s.paddingRight  || '0px') : 0)
        const iB = bWidths[2] + (pad ? pxToPt(s.paddingBottom || '0px') : 0)
        const iL = bWidths[3] + (pad ? pxToPt(s.paddingLeft   || '0px') : 0)
        if (!iT && !iR && !iB && !iL) return box
        return {
          dx: iL, dy: iT,
          w: Math.max(0, w - iL - iR), h: Math.max(0, effH - iT - iB),
          radius: insetBorderRadius(radius, iT, iR, iB, iL),
        }
      }
      const colorClip = bgClipList.at(-1) ?? 'border-box'
      const fillBox   = clipBoxFor(colorClip)
      const fillInset = fillBox.dx !== 0 || fillBox.dy !== 0 || fillBox.w !== w || fillBox.h !== effH

      const bgLayers: BgLayer[] = []
      if (bgImg && bgImg !== 'none') {
        const layerList = splitByTopLevelComma(bgImg)
        for (let i = layerList.length - 1; i >= 0; i--) {
          const kind = bgClipList[i % bgClipList.length] ?? 'border-box'
          if (kind === 'text') continue
          const url = bgImages?.get(i)
          if (url) {
            // url() layers on inline fragments paint once, as they always have
            if (rectIndex === 0) bgLayers.push({ url, index: i, box: clipBoxFor(kind) })
            continue
          }
          const layer = (layerList[i] ?? '').trim()
          const g = parseCSSGradient(layer)
          if (g) {
            const box = clipBoxFor(kind)
            if (box.w > 0 && box.h > 0) bgLayers.push({ gradient: resolveGradientBox(g, box.w, box.h), box })
            continue
          }
          const cg = parseCSSConicGradient(layer)
          if (cg) {
            const box = clipBoxFor(kind)
            const src = rasterizeConic(cg, box.w, box.h)
            if (src) bgLayers.push({ conicSrc: src, box })
          }
        }
      }
      return { fillBox, fillInset, bgLayers }
    }

    const spans = paginateSpan(y, h, ctx.pageH)
    // box-decoration-break:clone on a BLOCK element spanning multiple pages: each
    // page-fragment becomes an independent, complete box at its OWN local height
    // (not the full element height), full border/radius on all sides — unlike
    // default 'slice', which keeps drawing the one full-height absolute shape at
    // every page and lets that page's own MediaBox reveal only its true portion.
    const blockClone = !isInline && boxDecorationBreak === 'clone' && spans.length > 1
    const defaultGeom = blockClone ? null : computeGeom(h)

    // A box taller than one page draws its full, unmodified shape once per page it
    // touches — each page's own MediaBox naturally clips it to the right visible
    // slice, so the fill/border continues seamlessly across the break instead of
    // being lost past the first page's bottom edge. (blockClone overrides this.)
    for (const { page, y: ly } of spans) {
      let by = ly, bh = h
      if (blockClone) {
        const fragTop    = Math.max(0, ly)
        const fragBottom = Math.min(ctx.pageH, ly + h)
        bh = fragBottom - fragTop
        if (bh <= 0.01) continue
        by = fragTop
      }
      const { fillBox, fillInset, bgLayers } = blockClone ? computeGeom(bh) : defaultGeom!

      // shadows ignore the background's alpha and wrap its layers, so they split off when the fill
      // can't carry them: outer ones under the background, inset ones over every layer
      const splitShadow = shadows.length > 0 && (bgClipText || fillInset || bgAlpha < 1 || bgLayers.length > 0)
      const shadowRect = (list: typeof shadows) => list.length && ctx.commands.push({
        type: 'rect', page, x, y: by, w, h: bh,
        fill: null, shadow: list, radius,
        opacity, blend,
      } as RectCommand)
      if (splitShadow) shadowRect(shadows.filter(sh => !sh.inset))
      if (paintsFill || (shadows.length && !splitShadow)) {
        // rgba()'s own alpha only applies to the plain solid fill — gradient stops
        // and shadow colors already carry their own alpha independently
        ctx.commands.push({
          type: 'rect', page,
          x: x + fillBox.dx, y: by + fillBox.dy, w: fillBox.w, h: fillBox.h,
          fill:     paintsFill ? bgColor : null,
          shadow:   splitShadow ? undefined : (shadows.length ? shadows : undefined),
          radius:   fillBox.radius,
          opacity: combineOpacity(opacity, bgAlpha),
          blend,
        } as RectCommand)
      }

      for (const L of bgLayers) {
        const lx = x + L.box.dx, lyy = by + L.box.dy
        if (L.gradient) {
          ctx.commands.push({
            type: 'rect', page,
            x: lx, y: lyy, w: L.box.w, h: L.box.h,
            fill: null, gradient: L.gradient,
            radius: L.box.radius,
            opacity, blend,
          } as RectCommand)
        } else if (L.conicSrc) {
          const rounded = !!L.box.radius
          if (rounded) ctx.commands.push({ type: 'clip-push', page, x: lx, y: lyy, w: L.box.w, h: L.box.h, radius: L.box.radius })
          ctx.commands.push({
            type: 'image', page, src: L.conicSrc, format: 'png',
            x: lx, y: lyy, w: L.box.w, h: L.box.h,
            opacity, blend,
          } as ImageCommand)
          if (rounded) ctx.commands.push({ type: 'clip-pop', page })
        } else if (L.url) {
          emitBgImage(el, L.url, ctx, L.index!, splitByTopLevelComma(bgImg).length, page)
        }
      }
      if (splitShadow) shadowRect(shadows.filter(sh => sh.inset))

      // border-image, when its source resolves, paints OVER the normal CSS
      // border entirely (border-style/color still exist for layout only) —
      // the actual image tiles are async (fetch/canvas crop), so they're
      // emitted separately from walk.ts's emitBorderImage, not inline here
      if (!hasBorderImage(s)) {
      if (uniformSolid && bWidths[0] > 0 && bStyles[0] !== 'none' && bColorAlphas[0]) {
        const { color: strokeColor, alpha: strokeAlpha } = splitColorAlpha(bColorAlphas[0])
        ctx.commands.push({
          type: 'rect', page, x, y: by, w, h: bh,
          fill: null,
          stroke: strokeColor,
          strokeWidth: bWidths[0],
          radius, opacity: combineOpacity(opacity, strokeAlpha), blend,
        } as RectCommand)
      } else if (!fragmented && allSame && radius && bWidths[0] > 0 && bColorAlphas[0] &&
                 (bStyles[0] === 'dashed' || bStyles[0] === 'dotted')) {
        // uniform dashed/dotted with rounded corners: a stroked path carries the
        // dash pattern around the curve — the four-line branch would square them
        const { color: strokeColor, alpha: strokeAlpha } = splitColorAlpha(bColorAlphas[0])
        ctx.commands.push({
          type: 'rect', page, x, y: by, w, h: bh,
          fill: null,
          stroke: strokeColor,
          strokeWidth: bWidths[0],
          strokeStyle: bStyles[0],
          radius, opacity: combineOpacity(opacity, strokeAlpha), blend,
        } as RectCommand)
      } else {
        // each side's line runs at `off` from its own outer edge, perpendicular to it
        const sideLine = (i: number, off: number) =>
          i === 0 ? { x1: x,           y1: by + off,      x2: x + w,       y2: by + off      } :
          i === 1 ? { x1: x + w - off, y1: by,            x2: x + w - off, y2: by + bh       } :
          i === 2 ? { x1: x,           y1: by + bh - off, x2: x + w,       y2: by + bh - off } :
                    { x1: x + off,     y1: by,            x2: x + off,     y2: by + bh       }
        // solid and 3D sides fill as bands mitered into their neighbors, as browsers paint
        // them; a fragment's cut side has no width to miter against
        const [mT, bR, mB, bL] = bWidths
        const mR = suppressRight ? 0 : bR, mL = suppressLeft ? 0 : bL
        const corner = (k: number, f: number): [number, number] =>
          k === 0 ? [x + f * mL,     by + f * mT]      :
          k === 1 ? [x + w - f * mR, by + f * mT]      :
          k === 2 ? [x + w - f * mR, by + bh - f * mB] :
                    [x + f * mL,     by + bh - f * mB]
        const quad = (i: number, f0: number, f1: number): PathSeg[] =>
          [corner(i, f0), corner((i + 1) % 4, f0), corner((i + 1) % 4, f1), corner(i, f1)].map(([px, py], j) => ({ op: j ? 'l' : 'm', args: [px, py] }))
        // a rounded box fills the ring between the band's two curves, clipped to the side's
        // mitered quad, so the corners stay round and split where the browser splits them
        const ring = (f0: number, f1: number): PathSeg[] => {
          const inset = (f: number) => roundedRectOps(x + f * mL, by + f * mT, w - f * (mL + mR), bh - f * (mT + mB),
            insetBorderRadius(radius, f * mT, f * mR, f * mB, f * mL))
          return [...inset(f0), ...(w - f1 * (mL + mR) > 0 && bh - f1 * (mT + mB) > 0 ? inset(f1) : [])]
        }
        const band = (i: number, f0: number, f1: number, ca: ColorAlpha) => {
          const { color: c, alpha: a } = splitColorAlpha(ca)
          const paint = { fill: c!, opacity: combineOpacity(opacity, a), blend }
          if (!radius) { ctx.commands.push({ type: 'path', page, ops: quad(i, f0, f1), ...paint } as PathCommand); return }
          // the miter lines run on past the inner corners, to the box's middle or to where they meet
          const horizontal = i === 0 || i === 2
          const depth = horizontal ? (i === 0 ? mT : mB) : (i === 3 ? mL : mR)
          const across = horizontal ? mL + mR : mT + mB
          const reach = Math.min((horizontal ? bh : w) / 2 / depth, across > 0 ? (horizontal ? w : bh) / across : Infinity)
          ctx.commands.push({ type: 'clip-push', page, path: quad(i, 0, Math.max(1, reach)) })
          ctx.commands.push({ type: 'path', page, ops: ring(f0, f1), evenOdd: true, ...paint } as PathCommand)
          ctx.commands.push({ type: 'clip-pop', page })
        }
        for (let i = 0; i < 4; i++) {
          // a fragment's cut side draws no border line at all — the box
          // visually continues past it, there is no true edge there to stroke
          if ((i === 3 && suppressLeft) || (i === 1 && suppressRight)) continue
          const bw = bWidths[i]!, bStyle = bStyles[i]!, bCA = bColorAlphas[i]
          if (bw > 0 && bStyle !== 'none' && bCA) {
            if (bStyle === 'solid') { band(i, 0, 1, bCA); continue }
            if (BORDER_3D.has(bStyle)) {
              const shades = border3dShades(bCA)
              for (const [f0, f1, dark] of border3dBands(bStyle, i)) band(i, f0, f1, dark ? shades.dark : shades.light)
              continue
            }
            const { color: lineColor, alpha: lineAlpha } = splitColorAlpha(bCA)
            const lineOpacity = combineOpacity(opacity, lineAlpha)
            // double = two sub-lines of a third the width at the outer and inner
            // thirds of the border band, with the middle third left open
            if (bStyle === 'double' && bw >= 2) {
              const t = bw
              for (const off of [t / 6, t * 5 / 6]) {
                ctx.commands.push({
                  type: 'line', page, ...sideLine(i, off),
                  width: t / 3, color: lineColor!,
                  lineStyle: 'solid',
                  opacity: lineOpacity, blend,
                } as LineCommand)
              }
              continue
            }
            ctx.commands.push({
              type: 'line', page, ...sideLine(i, bw / 2),
              width: bw, color: lineColor!,
              lineStyle: normBorderStyle(bStyle),
              opacity: lineOpacity, blend,
            } as LineCommand)
          }
        }
      }
      }

      if (oColorA && w + oGrow * 2 > 0 && bh + oGrow * 2 > 0) {
        const { color: oc, alpha: oa } = splitColorAlpha(oColorA)
        ctx.commands.push({
          type: 'rect', page,
          x: x - oGrow, y: by - oGrow, w: w + oGrow * 2, h: bh + oGrow * 2,
          fill: null,
          stroke: oc,
          strokeWidth: oWidth,
          strokeStyle: (oStyle === 'dashed' || oStyle === 'dotted') ? oStyle : undefined,
          radius: oRadius,
          opacity: combineOpacity(opacity, oa),
          blend,
        } as RectCommand)
      }
    }
  }
}

function applyTextTransform(text: string, transform: string): string {
  if (transform === 'uppercase')  return text.toUpperCase()
  if (transform === 'lowercase')  return text.toLowerCase()
  // \b\w is ASCII-only — "över" or "état" would stay lowercase while the preview
  // capitalizes them. Apostrophes are word-internal ("don't" → "Don't", not "Don'T").
  if (transform === 'capitalize') return text.replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, p, c) => p + c.toUpperCase())
  return text
}

// The nearest ancestor clamping its lines (-webkit-line-clamp), which counts the lines of
// its block descendants too
function lineClampBox(el: Element, cache: Map<Element, Element | null>): Element | null {
  const hit = cache.get(el)
  if (hit !== undefined) return hit
  const clamp = (getComputedStyle(el) as any).webkitLineClamp as string | undefined
  const found = clamp && clamp !== 'none' ? el : el.parentElement ? lineClampBox(el.parentElement, cache) : null
  cache.set(el, found)
  return found
}

// ::first-letter/::first-line apply to the block's opening text — this node
// carries them only if nothing (element or non-blank text) precedes it
function isFirstContentOfBlock(textNode: Text): boolean {
  let n = textNode.previousSibling
  while (n) {
    if (n.nodeType === Node.ELEMENT_NODE) return false
    if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim()) return false
    n = n.previousSibling
  }
  return true
}

// getComputedStyle(el, pseudo) resolves even when no rule matched — the only
// signal a rule EXISTS is a computed value differing from the element's own
function pseudoTextOverride(el: Element, which: '::first-letter' | '::first-line', s: CSSStyleDeclaration): CSSStyleDeclaration | null {
  const p = getComputedStyle(el, which)
  const differs = p.fontSize !== s.fontSize || p.fontFamily !== s.fontFamily ||
    p.fontWeight !== s.fontWeight || p.fontStyle !== s.fontStyle ||
    p.color !== s.color || p.letterSpacing !== s.letterSpacing ||
    p.textTransform !== s.textTransform ||
    (which === '::first-letter' && p.cssFloat !== 'none')
  return differs ? p : null
}

interface LineStyle {
  fontRef:     { name: string; style: string; weight: number }
  sizePt:      number
  color:       Color
  textOpacity: number | undefined
  lsPt:        number | undefined
}

// Flex/grid containers wrap each contiguous in-flow text run in its own
// anonymous item — but a plain element inserted among the children is NOT
// part of that run, so it becomes a SEPARATE item, independently aligned
// (e.g. align-items:center centers a zero-height anchor on its own, landing
// at the container's cross-axis center rather than on the real text's own
// baseline). A wrapper wasn't needed before because the common case (block/
// inline text) has no such grouping to break — a sibling span there just
// joins the same line box as everything else.
function baselineNeedsWrapper(parentEl: Element): boolean {
  const d = getComputedStyle(parentEl).display
  return d === 'flex' || d === 'inline-flex' || d === 'grid' || d === 'inline-grid'
}

// Reads a text run's real on-screen baseline Y (viewport px) via a zero-size
// `vertical-align:baseline` anchor. In a flex/grid parentEl, the anchor is
// wrapped together with textNode in one shared inline box first, so both
// remain a single flex/grid item and the anchor inherits the run's own line
// box instead of being centered as an independent, contentless item.
function measureBaselineY(parentEl: Element, textNode: Text, before: boolean): number {
  const anchor = parentEl.ownerDocument.createElement('span')
  anchor.style.cssText = 'display:inline;font-size:0;line-height:0;vertical-align:baseline;'
  if (!baselineNeedsWrapper(parentEl)) {
    parentEl.insertBefore(anchor, before ? textNode : textNode.nextSibling)
    const y = anchor.getBoundingClientRect().top
    parentEl.removeChild(anchor)
    return y
  }
  const wrapper = parentEl.ownerDocument.createElement('span')
  wrapper.style.cssText = 'display:inline;'
  parentEl.insertBefore(wrapper, textNode)
  if (before) { wrapper.appendChild(anchor); wrapper.appendChild(textNode) }
  else        { wrapper.appendChild(textNode); wrapper.appendChild(anchor) }
  const y = anchor.getBoundingClientRect().top
  parentEl.insertBefore(textNode, wrapper)
  parentEl.removeChild(wrapper)
  return y
}

// Chrome and WebKit slant an upright face by a fixed 0.25 when the family has no italic
function syntheticSkew(s: CSSStyleDeclaration, font: FontRef): number | undefined {
  if (!isSlanted(s.fontStyle) || /italic|oblique/i.test(font.style) || (s as any).fontSynthesisStyle === 'none') return undefined
  return 0.25
}

const SMALL_CAPS_SCALE = 0.7

// Chrome's synthesis for a font without small-cap glyphs: lowercase becomes uppercase at 0.7×
// (small-caps), everything does (all-small-caps), or all but lowercase shrinks (unicase)
function smallCapsPieces(text: string, s: CSSStyleDeclaration): { text: string; small: boolean }[] | null {
  const mode = s.fontVariantCaps
  const isLower = (c: string) => c !== c.toUpperCase()
  let small: (c: string) => boolean, upper = true
  if (mode === 'small-caps' || mode === 'petite-caps') small = isLower
  else if (mode === 'all-small-caps' || mode === 'all-petite-caps') small = () => true
  else if (mode === 'unicase') { small = c => !isLower(c); upper = false }
  else return null
  const pieces: { text: string; small: boolean }[] = []
  for (const c of text) {
    const sm = small(c), out = sm && upper ? c.toUpperCase() : c
    const last = pieces[pieces.length - 1]
    if (last && last.small === sm) last.text += out
    else pieces.push({ text: out, small: sm })
  }
  return pieces
}

const fontKey = (s: CSSStyleDeclaration): string =>
  `${s.fontFamily}|${s.fontSize}|${s.fontWeight}|${s.fontStyle}|${s.fontStretch}|${(s as any).fontSizeAdjust ?? ''}`

// A text run's baseline sits a fixed distance below its glyph-box top for a given font, so the
// probe runs once per font in the capture; glyphTop is the first line's top in viewport px.
function baselineOffset(parentEl: Element, textNode: Text, s: CSSStyleDeclaration, glyphTop: number, ctx: WalkerCtx): number {
  const key = fontKey(s)
  let offset = ctx.baselineOffsets.get(key)
  if (offset === undefined) {
    offset = measureBaselineY(parentEl, textNode, true) - glyphTop
    ctx.baselineOffsets.set(key, offset)
  }
  return offset
}

// A4 (vertical writing modes): a deliberately scoped-down sibling of
// captureTextNode below, for `writing-mode: vertical-rl/lr` blocks. Supports
// plain colored text down a column; does NOT attempt decorations, shadows,
// ellipsis, first-letter/line, or per-character font fallback — those are
// all real, separate features whose horizontal implementations don't
// translate onto a rotated axis for free, and combining "rare CSS feature"
// with "rare writing mode" isn't worth the added complexity this pass.
// Multi-page vertical columns are also out of scope (assumed to fit one page).
export function captureVerticalTextNode(
  textNode: Text,
  s:        CSSStyleDeclaration,
  ctx:      WalkerCtx,
): void {
  const raw = textNode.textContent
  if (!raw.trim()) return
  if (s.visibility === 'hidden' || s.visibility === 'collapse') return

  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts)
  if (!fontRef) {
    const fam = (s.fontFamily.split(',')[0] ?? '').replace(/["']/g, '').trim()
    console.warn(`[daepdf] Font "${fam}" is not registered – vertical text skipped. Declare it with @font-face in the template's <style> (TTF, OTF or TTC).`)
    return
  }

  const sizePx = parseFloat(s.fontSize) || 16
  const sizePt = sizePx / PX_PER_PT
  const { color: rgb, alpha } = splitColorAlpha(parseColorAlpha(s.color))
  const color: Color = rgb ?? [0, 0, 0]
  const opacity = combineOpacity(stackOpacity(ctx), alpha)
  const blend   = stackBlend(ctx)

  const chars = [...raw]
  const range = textNode.ownerDocument.createRange()
  interface CharHit { ch: string; rect: DOMRect }
  const hits: CharHit[] = []
  let charIdx = 0
  for (const ch of chars) {
    range.setStart(textNode, charIdx)
    range.setEnd(textNode, charIdx + ch.length)
    const r = range.getBoundingClientRect()
    charIdx += ch.length
    if (r.width < 0.01 && r.height < 0.01) continue
    hits.push({ ch, rect: r })
  }
  if (!hits.length) return

  // a column is a run of consecutive characters at one x, as a line is at one y
  interface ColumnGroup { chars: CharHit[]; left: number; minTop: number }
  const columns: ColumnGroup[] = []
  for (const hit of hits) {
    const left = hit.rect.left
    const current = columns.at(-1)
    if (current && Math.abs(current.left - left) < 3) {
      current.chars.push(hit)
      current.minTop = Math.min(current.minTop, hit.rect.top)
    } else {
      columns.push({ chars: [hit], left, minTop: hit.rect.top })
    }
  }

  // vertical-rl columns progress right-to-left, vertical-lr left-to-right —
  // each column's own explicit position makes this ordering immaterial to
  // correctness, kept only for deterministic/readable command output
  columns.sort((a, b) => s.writingMode === 'vertical-lr' ? a.left - b.left : b.left - a.left)

  for (const col of columns) {
    const text = col.chars.map(c => c.ch).join('')
    if (!text.trim()) continue
    const colLeft  = Math.min(...col.chars.map(c => c.rect.left))
    const colRight = Math.max(...col.chars.map(c => c.rect.right))
    // the LEFT edge, not the center — PDF vertical writing positions the
    // text matrix at the glyph's "horizontal origin" (the same left-edge
    // reference normal horizontal Tj uses) and the viewer itself shifts by
    // the font's own v1x (half the glyph's width, from /W2's per-spec
    // default) to find the centered "vertical origin" — passing the center
    // here would double that offset
    const colX     = (colLeft - ctx.containerRect.left) / PX_PER_PT
    const colTopPx = col.minTop - ctx.containerRect.top

    const { page, y: ly } = paginate(colTopPx / PX_PER_PT, ctx.pageH)
    ctx.commands.push({
      type: 'text', page, text, vertical: true,
      x: colX, y: ly,
      font: fontRef.name, style: fontRef.style, weight: fontRef.weight,
      size: sizePt, color,
      maxWidth: (colRight - colLeft) / PX_PER_PT,
      opacity, blend,
    } as TextCommand)
  }
}

export function captureTextNode(
  textNode: Text,
  parentEl: Element,
  s:        CSSStyleDeclaration,
  ctx:      WalkerCtx,
): void {
  const raw = textNode.textContent
  if (!raw.trim()) return
  // visibility is the parent's — hidden text still occupies space but never paints
  if (s.visibility === 'hidden' || s.visibility === 'collapse') return

  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts)
  if (!fontRef) {
    const fam = (s.fontFamily.split(',')[0] ?? '').replace(/["']/g, '').trim()
    console.warn(`[daepdf] Font "${fam}" is not registered – text skipped. Declare it with @font-face in the template's <style> (TTF, OTF or TTC).`)
    return
  }

  const sizePx  = parseFloat(s.fontSize) || 16
  const sizePt  = sizePx / PX_PER_PT
  // -webkit-text-fill-color overrides color for painting (it defaults to the color
  // value) — the gradient-text pattern almost always uses text-fill-color:transparent
  const colorSrc = String((s as any).webkitTextFillColor || s.color)
  const colorAlphaVal = parseColorAlpha(colorSrc)
  const { color: colorRgb, alpha: colorAlpha } = splitColorAlpha(colorAlphaVal)
  let color    = colorRgb ?? ([0, 0, 0] as Color)
  let drawText = true
  // a transparent paint color parses to null exactly like "no color" — without this it
  // falls back to opaque black. background-clip:text (transparent text over a gradient)
  // is approximated with the first gradient stop / background color as the text color,
  // since a PDF box fill can't be clipped to glyph outlines.
  if (colorAlphaVal === null && isTransparentColor(colorSrc)) {
    let sub: Color | null = null
    const clipsText = String((s as any).webkitBackgroundClip || s.backgroundClip || '').includes('text')
    if (clipsText) {
      if (s.backgroundImage && s.backgroundImage !== 'none') {
        for (const layer of splitByTopLevelComma(s.backgroundImage)) {
          const g = parseCSSGradient(layer.trim())
          const gs0 = g?.stops[0]
          if (gs0) { sub = [gs0.color[0], gs0.color[1], gs0.color[2]]; break }
        }
      }
      if (!sub) {
        const bg = parseColorAlpha(s.backgroundColor)
        if (bg) sub = [bg[0], bg[1], bg[2]]
      }
    }
    if (sub) color = sub
    // image-clipped text has no color to substitute — readable black beats invisible
    else if (!clipsText) drawText = false
  }
  const lsPt    = s.letterSpacing === 'normal' ? undefined : pxToPt(s.letterSpacing) || undefined
  const wsPt    = s.wordSpacing   === 'normal' ? undefined : pxToPt(s.wordSpacing)   || undefined
  const txform  = s.textTransform
  const opacity  = stackOpacity(ctx)
  const blend    = stackBlend(ctx)
  const textOpacity = combineOpacity(opacity, colorAlpha)

  // -webkit-text-stroke — PDF strokes glyph outlines natively (render mode 1/2);
  // a transparent fill with a stroke means stroke-only (mode 1), not invisible text
  const tsWidthPt = pxToPt(String((s as any).webkitTextStrokeWidth || '0px'))
  const tsCA      = tsWidthPt > 0 ? parseColorAlpha(String((s as any).webkitTextStrokeColor || '')) : null
  const textStroke = tsCA ? { color: [tsCA[0], tsCA[1], tsCA[2]] as Color, width: tsWidthPt } : null
  let strokeOnly = false
  if (textStroke && !drawText) { drawText = true; strokeOnly = true }

  // text-decoration paints across descendants but is NOT inherited — computed style on
  // a <span> inside an underlined <a> reports "none", so read the ancestor chain up to
  // the nearest propagation boundary (out-of-flow, float, atomic inline), as browsers do
  interface Deco {
    part: string; color: Color; alpha: number; lineStyle: 'solid' | 'dashed' | 'dotted' | 'wavy'
    thicknessPt?: number | undefined; underlineOffsetPt?: number | undefined
  }
  const decos: Deco[] = []
  {
    const seen = new Set<string>()
    let decoEl: Element | null = parentEl
    let decoStyle = s
    while (decoEl) {
      const dl = decoStyle.textDecorationLine
      if (dl && dl !== 'none') {
        for (const part of dl.split(' ')) {
          if (seen.has(part)) continue
          seen.add(part)
          // an explicitly transparent decoration color means invisible — only fall
          // back to the text color when the value merely failed to parse
          const dcRaw = decoStyle.textDecorationColor
          const ca = parseColorAlpha(dcRaw) ?? (isTransparentColor(dcRaw) ? null : parseColorAlpha(decoStyle.color))
          if (!ca) continue
          // authored px values override the heuristics; auto/from-font keep them
          const thM = (decoStyle.textDecorationThickness || '').match(/^(-?[\d.]+)px$/)
          const uoM = ((decoStyle as any).textUnderlineOffset || '').match(/^(-?[\d.]+)px$/)
          decos.push({
            part,
            color: [ca[0], ca[1], ca[2]],
            alpha: ca[3] / 255,
            lineStyle: normBorderStyle(decoStyle.textDecorationStyle),
            thicknessPt:       thM?.[1] ? Math.max(0.1, +thM[1] / PX_PER_PT) : undefined,
            underlineOffsetPt: uoM?.[1] ? +uoM[1] / PX_PER_PT : undefined,
          })
        }
      }
      const d = decoStyle.display
      if (decoStyle.position === 'absolute' || decoStyle.position === 'fixed' ||
          decoStyle.cssFloat !== 'none' ||
          d === 'inline-block' || d === 'inline-table' || d === 'inline-flex' || d === 'inline-grid') break
      decoEl = decoEl.parentElement
      if (!decoEl || decoEl === decoEl.ownerDocument.body) break
      decoStyle = getComputedStyle(decoEl)
    }
  }

  if (!drawText && !decos.length) return

  // ::first-letter / ::first-line style overrides for the block's opening text.
  // The browser already laid the styled glyphs out — every rect measured below
  // reflects the pseudo styling; only the EMITTED font/size/color must follow.
  const blockish = s.display === 'block' || s.display === 'list-item' ||
    s.display === 'flow-root' || s.display === 'table-cell'
  const firstContent = blockish && isFirstContentOfBlock(textNode)
  const flStyle  = firstContent && drawText ? pseudoTextOverride(parentEl, '::first-letter', s) : null
  const fllStyle = firstContent && drawText ? pseudoTextOverride(parentEl, '::first-line', s) : null

  // first letter = leading punctuation + one letter/digit + combining marks; it
  // gets its own TextCommand, so the word scan below starts past it
  let flStart = 0, flEnd = 0
  if (flStyle) {
    const flM = raw.match(/^(\s*)([\p{P}\p{S}]*[\p{L}\p{N}][̀-ͯ]*)/u)
    if (flM) { flStart = (flM[1] ?? '').length; flEnd = flStart + (flM[2] ?? '').length }
  }

  const range = textNode.ownerDocument.createRange()

  // a <wbr>-chunked long word continues across text nodes — its continuation chunk
  // must not be treated as a fresh word start by text-transform: capitalize
  const continuesWord = textNode.previousSibling?.nodeName === 'WBR'

  interface WordHit { text: string; rect: DOMRect; start: number; len: number }
  const wordHits: WordHit[] = []
  const re = /\S+/g
  re.lastIndex = flEnd
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    try {
      range.setStart(textNode, m.index)
      range.setEnd(textNode, m.index + m[0].length)
    } catch {
      continue
    }
    const midWordChunk = txform === 'capitalize' && m.index === 0 && continuesWord
    const frags = Array.from(range.getClientRects()).filter(fr => fr.width > 0.1 && fr.height > 0.1)
    if (frags.length <= 1) {
      const r = frags[0] ?? range.getBoundingClientRect()
      if (r.width < 0.1 && r.height < 0.1) continue
      wordHits.push({
        text: midWordChunk ? m[0] : applyTextTransform(m[0], txform),
        rect: r, start: m.index, len: m[0].length,
      })
      continue
    }
    // the word wraps across line boxes (long token / CJK run) — its bounding rect is
    // the useless union of all fragments. Segment it per line via per-char tops so
    // each piece lands on its own line at its own measured position.
    let segStart = m.index
    let prevTop: number | null = null
    // Chrome reports the character after a soft-hyphen break with the hyphen's rect first,
    // so a segment keeps only its own line's rects, and a character its last one
    const closeSegment = (endIdx: number) => {
      if (endIdx <= segStart || prevTop === null) return
      range.setStart(textNode, segStart)
      range.setEnd(textNode, endIdx)
      const onLine = Array.from(range.getClientRects()).filter(fr => Math.abs(fr.top - prevTop!) <= 3 && (fr.width > 0.1 || fr.height > 0.1))
      if (!onLine.length) return
      const left = Math.min(...onLine.map(fr => fr.left)), top = Math.min(...onLine.map(fr => fr.top))
      const sr = new DOMRect(left, top, Math.max(...onLine.map(fr => fr.right)) - left, Math.max(...onLine.map(fr => fr.bottom)) - top)
      const slice = raw.slice(segStart, endIdx)
      // capitalize only applies at a word start — a mid-word segment must not re-capitalize
      const capAtStart = segStart === m!.index && !midWordChunk
      const segText = (txform !== 'capitalize' || capAtStart) ? applyTextTransform(slice, txform) : slice
      wordHits.push({ text: segText, rect: sr, start: segStart, len: endIdx - segStart })
    }
    for (let ci = 0; ci < m[0].length; ci++) {
      range.setStart(textNode, m.index + ci)
      range.setEnd(textNode, m.index + ci + 1)
      const cr = Array.from(range.getClientRects()).at(-1)
      if (!cr || (cr.width < 0.01 && cr.height < 0.01)) continue
      if (prevTop !== null && Math.abs(cr.top - prevTop) > 3) {
        closeSegment(m.index + ci)
        segStart = m.index + ci
      }
      prevTop = cr.top
    }
    closeSegment(m.index + m[0].length)
  }

  // A6 (hyphenation glyph): `hyphens: auto`'s browser-inserted hyphen at a line
  // break is a rendering-only decoration, never part of the DOM text — without
  // this, the emitted PDF silently drops the trailing "-" a wrapped word shows
  // on screen. Detected here, not against the hyphenation dictionary's exact
  // break point (not queryable): two consecutive wordHits are actually one
  // continuous source word split by a MID-WORD wrap when the next hit picks up
  // exactly where this one ends (no whitespace was skipped — `\S+` can't match
  // two tokens with zero gap) AND lands on a different line. Appending '-'
  // directly to the wordHit's own text means both the joined-line (`lineOut`)
  // and per-word emission paths pick it up for free, since both read straight
  // from `wordHits[i].text` — no separate handling needed for either.
  for (let i = 0; i < wordHits.length - 1; i++) {
    const cur = wordHits[i]!, next = wordHits[i + 1]!
    if (next.start !== cur.start + cur.len || Math.abs(next.rect.top - cur.rect.top) <= 3) continue
    // a soft hyphen the line broke at is drawn as a hyphen, whatever the hyphens value
    if (cur.text.endsWith('\u00AD')) cur.text = cur.text.slice(0, -1) + '-'
    else if (s.hyphens === 'auto') cur.text += '-'
  }

  if (!wordHits.length && !flEnd) return

  // Words come in text order, so a line is a run of them at one height (lines in other
  // columns can share that height)
  interface LineGroup { words: WordHit[]; minX: number; top: number }
  const lines: LineGroup[] = []
  for (const hit of wordHits) {
    const top = hit.rect.top
    const current = lines.at(-1)
    if (current && Math.abs(current.top - top) < 3) {
      current.words.push(hit)
      current.minX = Math.min(current.minX, hit.rect.left)
    } else {
      lines.push({ words: [hit], minX: hit.rect.left, top })
    }
  }

  // first-letter/first-line styling changes the first line's own metrics, so it measures directly
  const firstLineTop = lines[0]?.top ?? null
  const firstBaselineY = (flStyle || fllStyle || firstLineTop === null)
    ? measureBaselineY(parentEl, textNode, true) - ctx.containerRect.top
    : firstLineTop - ctx.containerRect.top + baselineOffset(parentEl, textNode, s, firstLineTop, ctx)

  if (flEnd > 0) {
    const flRange = textNode.ownerDocument.createRange()
    flRange.setStart(textNode, flStart)
    flRange.setEnd(textNode, flEnd)
    const flRect = flRange.getBoundingClientRect()
    if (flRect.width > 0.1 && flRect.height > 0.1) {
      const flFont   = resolveFontRef(flStyle!.fontFamily, flStyle!.fontWeight, flStyle!.fontStyle, ctx.fontMap, ctx.registeredFonts) ?? fontRef
      const flSizePx = parseFloat(flStyle!.fontSize) || sizePx
      const flCA     = parseColorAlpha(String((flStyle as any).webkitTextFillColor || flStyle!.color))
      // an inline drop cap sits on the first line's shared baseline (that IS
      // inline layout); a floated one lives in its own box, so approximate its
      // baseline from the glyph box center, matching text()'s 'middle' math
      const floated    = flStyle!.cssFloat !== 'none'
      const baselinePx = floated
        ? (flRect.top + flRect.bottom) / 2 - ctx.containerRect.top + flSizePx * 0.35
        : firstBaselineY
      const { page, y: ly } = paginate(baselinePx / PX_PER_PT, ctx.pageH)
      ctx.commands.push({
        type: 'text', page,
        text: applyTextTransform(raw.slice(flStart, flEnd), flStyle!.textTransform),
        x: (flRect.left - ctx.containerRect.left) / PX_PER_PT, y: ly,
        font: flFont.name, style: flFont.style, weight: flFont.weight,
        size: flSizePx / PX_PER_PT,
        color: flCA ? [flCA[0], flCA[1], flCA[2]] as Color : color,
        maxWidth: flRect.width / PX_PER_PT + flSizePx / PX_PER_PT,
        opacity: combineOpacity(opacity, flCA ? flCA[3] / 255 : colorAlpha),
        skew: syntheticSkew(flStyle!, flFont),
        blend,
      } as TextCommand)
    }
  }
  if (!lines.length) return

  // justify stretches inter-word gaps and pre preserves space runs — a line joined
  // with single spaces loses both, drifting further right the longer the line gets.
  // Each word already has its own measured rect, so emit words individually instead.
  // word-spacing also forces per-word emission: the browser's word rects already
  // carry the widened gaps
  const wsMode  = s.whiteSpace
  // a bidi-mixed run (e.g. "Invoice مرحبا 123") also needs per-word emission —
  // see hasBidiMix's own comment for why this is a complete fix, not a partial one
  const paraDir: 'ltr' | 'rtl' = s.direction === 'rtl' ? 'rtl' : 'ltr'
  const perWord = s.textAlign === 'justify' || wsMode === 'pre' || wsMode === 'pre-wrap' || wsMode === 'break-spaces' ||
    wsPt !== undefined || hasBidiMix(raw)

  // computed text-shadow shares box-shadow's serialization (color first, px lengths)
  const tShadows = parseCSSBoxShadow(s.textShadow)

  // text-overflow: ellipsis — the browser paints "…" where our overflow clip would
  // hard-cut glyphs mid-shape. Only kicks in when the parent actually overflows.
  // RTL puts the ellipsis on the left; a hard clip beats truncating the wrong side.
  let ellipsisLimitPx = Infinity
  if (drawText && s.textOverflow === 'ellipsis' && wsMode === 'nowrap' && s.direction !== 'rtl') {
    const ox = s.overflowX
    if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') {
      const pe = parentEl as HTMLElement
      if (pe.scrollWidth > pe.clientWidth + 1) {
        const pr = pe.getBoundingClientRect()
        ellipsisLimitPx = pr.left + pe.clientLeft + pe.clientWidth - (parseFloat(s.paddingRight) || 0)
      }
    }
  }

  // -webkit-line-clamp: the last line the clamping box shows gets the ellipsis when lines of
  // this node follow it out of view (all lines are laid out; the box clips the rest)
  let clampLine = -1, clampRightPx = Infinity
  const clampEl = drawText ? lineClampBox(parentEl, ctx.clampBoxes) : null
  if (clampEl) {
    const cr = clampEl.getBoundingClientRect(), ccs = getComputedStyle(clampEl)
    const bottom = cr.top + clampEl.clientTop + clampEl.clientHeight - (parseFloat(ccs.paddingBottom) || 0)
    let lastShown = -1
    for (const [li, l] of lines.entries()) if (Math.max(...l.words.map(w => w.rect.bottom)) <= bottom + 1) lastShown = li
    if (lastShown >= 0 && lastShown < lines.length - 1) {
      clampLine = lastShown
      clampRightPx = cr.left + clampEl.clientLeft + clampEl.clientWidth - (parseFloat(ccs.paddingRight) || 0)
    }
  }

  // constant offset from a line's top to its own baseline, for this font/size — real
  // fonts' natural line-height varies from any fixed multiplier (the old code assumed
  // sizePx*1.2 for CSS line-height:normal), so extrapolating later lines' Y as
  // lineIndex*lineHeightPx drifted further off with every additional line. Using each
  // line's own measured top plus this constant instead needs no line-height guess at all.
  const ascentOffset = firstBaselineY - (firstLineTop! - ctx.containerRect.top)

  const baseStyle: LineStyle = { fontRef, sizePt, color, textOpacity, lsPt }
  let fllResolved: LineStyle | null = null
  // a first-line override changes the top-to-baseline distance for line 1 only —
  // the start probe measured line 1's baseline, so a second probe after the node
  // (in the last, normally-styled line) supplies the offset for the other lines
  let ascentOffsetRest = ascentOffset
  if (fllStyle && lines.length) {
    const fllFont   = resolveFontRef(fllStyle.fontFamily, fllStyle.fontWeight, fllStyle.fontStyle, ctx.fontMap, ctx.registeredFonts) ?? fontRef
    const fllSizePx = parseFloat(fllStyle.fontSize) || sizePx
    const fllCA     = parseColorAlpha(String((fllStyle as any).webkitTextFillColor || fllStyle.color))
    fllResolved = {
      fontRef: fllFont,
      sizePt:  fllSizePx / PX_PER_PT,
      color:   fllCA ? [fllCA[0], fllCA[1], fllCA[2]] as Color : color,
      textOpacity: combineOpacity(opacity, fllCA ? fllCA[3] / 255 : colorAlpha),
      lsPt: fllStyle.letterSpacing === 'normal' ? undefined : pxToPt(fllStyle.letterSpacing) || undefined,
    }
    if (lines.length > 1) {
      const lastBaselineY = measureBaselineY(parentEl, textNode, false) - ctx.containerRect.top
      const lastLineTop = lines.at(-1)!.top
      ascentOffsetRest = lastBaselineY - (lastLineTop - ctx.containerRect.top)
    }
  }

  for (const [li, line] of lines.entries()) {
    const st   = li === 0 && fllResolved ? fllResolved : baseStyle
    // ::first-line overrides font-family too — per-character fallback must walk
    // THAT family list, not the node's own, or it fails to find fonts the
    // override itself would have covered
    const famSrc = li === 0 && fllResolved ? fllStyle! : s
    const lineAscent = li === 0 ? ascentOffset : (fllResolved ? ascentOffsetRest : ascentOffset)
    const lineText = line.words.map(w => w.text).join(' ')
    if (!lineText.trim()) continue

    const xPx       = line.minX - ctx.containerRect.left
    const yPx        = (line.top - ctx.containerRect.top) + lineAscent
    const xPt        = xPx / PX_PER_PT
    const yPt        = yPx / PX_PER_PT
    const rightEdge  = Math.max(...line.words.map(w => w.rect.right))
    const wPt        = (rightEdge - ctx.containerRect.left) / PX_PER_PT - xPt

    const { page, y: ly } = paginate(yPt, ctx.pageH)

    // how far a run advances: its glyphs at their (small-caps) sizes plus letter and word spacing
    const pieceWidth = (txt: string, font: FontRef, size: number) =>
      measure_string_width(txt, font.name, font.style, font.weight, 0, size) + (st.lsPt ?? 0) * [...txt].length +
      (wsPt ?? 0) * (txt.match(/[ \u00A0]/g)?.length ?? 0)
    const runWidth = (txt: string, font: FontRef) => (smallCapsPieces(txt, famSrc) ?? [{ text: txt, small: false }])
      .reduce((sum, pc) => sum + pieceWidth(pc.text, font, pc.small ? st.sizePt * SMALL_CAPS_SCALE : st.sizePt), 0)

    // truncated to the longest prefix that fits with the ellipsis, measured with the font:
    // WebKit collapses the hidden part of an ellipsized line, so its rects all seem to fit
    let lineOut   = lineText
    let truncated = false
    const limitPx = li === clampLine ? clampRightPx : ellipsisLimitPx
    if (limitPx !== Infinity) {
      const width = (t: string) => runWidth(t, st.fontRef) * PX_PER_PT
      const avail = limitPx - line.minX - width('…')
      const chars = [...lineText]
      if (li === clampLine || width(lineText) > limitPx - line.minX) {
        truncated = true
        let lo = 0, hi = chars.length
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1
          if (width(chars.slice(0, mid).join('')) <= avail) lo = mid
          else hi = mid - 1
        }
        // if even the first character is past the limit, an earlier sibling node
        // already carries the ellipsis — emit nothing here
        lineOut = avail > 0 ? chars.slice(0, lo).join('').trimEnd() + '…' : ''
      }
      if (!lineOut) continue
    }

    // dir: the run's own direction, when it differs from the paragraph's (digits in RTL text)
    const emitRun = (txt: string, tx: number, maxW: number, font: FontRef, ws?: number, dir = paraDir) => {
      const pieces = smallCapsPieces(txt, famSrc)
      if (!pieces) { emitPiece(txt, tx, maxW, font, st.sizePt, ws, dir); return }
      let px = tx
      for (const pc of pieces) {
        const size = pc.small ? st.sizePt * SMALL_CAPS_SCALE : st.sizePt
        const w = pieceWidth(pc.text, font, size)
        emitPiece(pc.text, px, w, font, size, ws, dir)
        px += w
      }
    }

    const emitPiece = (txt: string, tx: number, maxW: number, font: FontRef, sizePt: number, ws: number | undefined, dir: 'ltr' | 'rtl') => {
      const skew = syntheticSkew(famSrc, font)
      for (let si = tShadows.length - 1; si >= 0; si--) {
        const sh = tShadows[si]!
        ctx.commands.push({
          type: 'text', page, text: txt,
          x: tx + sh.x, y: ly + sh.y,
          font: font.name, style: font.style, weight: font.weight,
          size: sizePt, color: [sh.color[0], sh.color[1], sh.color[2]] as Color,
          maxWidth: maxW,
          direction: dir,
          letterSpacing: st.lsPt, wordSpacing: ws, skew,
          // blur is approximated by knocking the shadow's alpha down
          opacity: combineOpacity(opacity, sh.color[3] / 255 * (sh.blur ? 0.55 : 1)),
          blend,
        } as TextCommand)
      }
      ctx.commands.push({
        type: 'text', page, text: txt,
        x: tx, y: ly,
        font: font.name, style: font.style, weight: font.weight,
        size: sizePt, color: st.color,
        maxWidth: maxW,
        direction: dir,
        letterSpacing: st.lsPt, wordSpacing: ws, skew,
        opacity: st.textOpacity,
        stroke: textStroke?.color,
        strokeWidth: textStroke?.width,
        strokeOnly: textStroke ? strokeOnly : undefined,
        blend,
      } as TextCommand)
    }

    const fontRuns = (txt: string) =>
      splitByFontCoverage(txt, st.fontRef, famSrc.fontFamily, famSrc.fontWeight, famSrc.fontStyle, ctx.fontMap, ctx.registeredFonts)

    // per-character font fallback (a codepoint st.fontRef doesn't cover falls
    // back to a font that does) splits txt into per-font runs, each emitted at
    // its own cumulative x; RTL text needing it goes word by word (emitRtlWord)
    const emitTextCmd = (txt: string, tx: number, maxW: number, ws?: number) => {
      if (s.direction === 'rtl') { emitRun(txt, tx, maxW, st.fontRef, ws); return }
      const runs = fontRuns(txt)
      if (runs.length === 1) { emitRun(txt, tx, maxW, st.fontRef, ws); return }
      let runX = tx
      for (const run of runs) {
        const runWidthPt = runWidth(run.text, run.font)
        emitRun(run.text, runX, runWidthPt, run.font, ws)
        runX += runWidthPt
      }
    }

    // RTL text mixing fonts or directions (digits run left to right) goes run by run, each shaped
    // alone where the browser put it: shaping the whole line right to left would reverse digits
    const emitRtlWord = (wd: WordHit) => {
      const runs = fontRuns(wd.text).flatMap(run => directionRuns(run.text, paraDir).map(r => ({ ...r, font: run.font })))
      const x = (wd.rect.left - ctx.containerRect.left) / PX_PER_PT, w = wd.rect.width / PX_PER_PT
      if (runs.length === 1) { emitRun(wd.text, x, w, runs[0]!.font, undefined, runs[0]!.dir); return }
      // a transformed or hyphenated word no longer lines up with its source offsets
      if (wd.text.length !== wd.len) { emitRun(wd.text, x, w, st.fontRef); return }
      const runRange = textNode.ownerDocument.createRange()
      let off = wd.start
      for (const run of runs) {
        runRange.setStart(textNode, off)
        runRange.setEnd(textNode, off + run.text.length)
        const r = Array.from(runRange.getClientRects()).find(fr => Math.abs(fr.top - wd.rect.top) < 3) ?? runRange.getBoundingClientRect()
        emitRun(run.text, (r.left - ctx.containerRect.left) / PX_PER_PT, r.width / PX_PER_PT, run.font, undefined, run.dir)
        off += run.text.length
      }
    }
    const lineDirs = new Set([...lineOut].map(charDirection))
    const rtlByWord = drawText && !truncated && s.direction === 'rtl' &&
      (fontRuns(lineOut).length > 1 || (lineDirs.has('ltr') && lineDirs.has('rtl')))

    // browser positions each word via DOM rects — emit left-aligned at the captured x
    if (drawText && (perWord || rtlByWord) && !truncated) {
      for (const wd of line.words) {
        if (s.direction === 'rtl') emitRtlWord(wd)
        else emitTextCmd(wd.text, (wd.rect.left - ctx.containerRect.left) / PX_PER_PT, wd.rect.width / PX_PER_PT)
      }
    } else if (drawText) {
      emitTextCmd(lineOut, xPt, wPt || st.sizePt * lineOut.length * 0.6, wsPt)
    }

    for (const deco of decos) {
      let dy: number
      if (deco.part === 'underline')         dy = ly + (deco.underlineOffsetPt ?? st.sizePt * 0.15)
      else if (deco.part === 'overline')     dy = ly - st.sizePt * 0.8
      else if (deco.part === 'line-through') dy = ly - st.sizePt * 0.3
      else continue
      ctx.commands.push({
        type: 'line', page,
        x1: xPt, y1: dy, x2: xPt + wPt, y2: dy,
        width: deco.thicknessPt ?? Math.max(0.4, st.sizePt / 14),
        color: deco.color,
        lineStyle: deco.lineStyle,
        opacity: combineOpacity(opacity, deco.alpha),
        blend,
      } as LineCommand)
    }
  }
}

function markerLabel(type: string, index: number): string | null {
  // list-style-type: "→ " computes to the quoted string, shown as is
  const str = type.match(/^"((?:[^"\\]|\\.)*)"$/)
  if (str) return (str[1] ?? '').replace(/\\(.)/g, '$1')
  switch (type) {
    case 'decimal-leading-zero': return `${index < 10 && index >= 0 ? '0' : ''}${index}.`
    // ordinal styles reuse counter() text, with its decimal fallback past their range
    case 'lower-alpha': case 'lower-latin': case 'upper-alpha': case 'upper-latin':
    case 'lower-greek': case 'upper-greek': case 'lower-roman': case 'upper-roman':
      return `${counterText(index, type)}.`
    // CSS treats a counter style it can't resolve as decimal
    default:                  return `${index}.`
  }
}

// Per the HTML living standard: an item's own `value` wins outright; otherwise
// it's one more than the NEAREST preceding list-item sibling's own ordinal
// (which itself may have come from an explicit `value`), not a fixed
// start-plus-position formula blind to any override in between. A prior
// version computed purely from `start + position`, silently ignoring any
// `<li value>` on an earlier sibling — e.g. `<li value="10">`, `<li>` numbered
// the second item "2" (position-based) instead of "11" (value-based).
// Items are numbered in document order, so the walk back stops at the previous item's
// cached ordinal instead of rescanning every sibling (quadratic on long lists).
const ordinals = new WeakMap<Element, number>()

export function listIndex(el: Element): number {
  const index = computeListIndex(el)
  ordinals.set(el, index)
  return index
}

function computeListIndex(el: Element): number {
  const li = el as HTMLLIElement
  if (li.value > 0) return li.value

  const parent = el.parentElement
  const ol = parent?.tagName === 'OL' ? parent as HTMLOListElement : null
  // a reversed list counts down, from the number of items unless start says otherwise
  const step = ol?.reversed ? -1 : 1
  let gap = 0
  let sib: Element | null = el.previousElementSibling
  while (sib) {
    if (getComputedStyle(sib).display === 'list-item') {
      gap++
      const known = ordinals.get(sib) ?? ((sib as HTMLLIElement).value > 0 ? (sib as HTMLLIElement).value : undefined)
      if (known !== undefined) return known + step * gap
    }
    sib = sib.previousElementSibling
  }
  const items = () => Array.from(ol!.children).filter(c => getComputedStyle(c).display === 'list-item').length
  const start = !ol ? 1 : ol.hasAttribute('start') ? ol.start : ol.reversed ? items() : 1
  return start + step * gap
}

// Chrome draws these markers as shapes, so a font without the glyphs doesn't matter. Measured
// across fonts and sizes: a 0.3em disc or square (0.35em circle, 1px ring), bottom 0.15em over
// the baseline, 0.32em + 7px before the content; triangles 0.65 x 0.56em, about 8px before it.
const SHAPE_MARKERS = new Set(['disc', 'circle', 'square', 'disclosure-open', 'disclosure-closed'])

function markerShape(type: string, left: number, baseline: number, em: number): { ops: PathSeg[]; ring?: number } {
  const K = 0.5523
  const ellipse = (cx: number, cy: number, r: number): PathSeg[] => [
    { op: 'm', args: [cx + r, cy] },
    { op: 'c', args: [cx + r, cy + r * K, cx + r * K, cy + r, cx, cy + r] },
    { op: 'c', args: [cx - r * K, cy + r, cx - r, cy + r * K, cx - r, cy] },
    { op: 'c', args: [cx - r, cy - r * K, cx - r * K, cy - r, cx, cy - r] },
    { op: 'c', args: [cx + r * K, cy - r, cx + r, cy - r * K, cx + r, cy] },
  ]
  const poly = (pts: number[][]): PathSeg[] => pts.map(([x, y], i) => ({ op: i ? 'l' : 'm', args: [x!, y!] }))
  if (type === 'disclosure-open') {
    const w = 0.65 * em, h = 0.5625 * em, r = left - 8, b = baseline - 0.05 * em
    return { ops: poly([[r - w, b - h], [r, b - h], [r - w / 2, b]]) }
  }
  if (type === 'disclosure-closed') {
    const w = 0.5625 * em, h = 0.65 * em, r = left - 8 - 0.08 * em
    return { ops: poly([[r - w, baseline - h], [r, baseline - h / 2], [r - w, baseline]]) }
  }
  const d = Math.max(1, Math.round((type === 'circle' ? 0.35 : 0.3) * em))
  const right = left - (0.32 * em + 7), bottom = baseline - 0.15 * em
  if (type === 'square') return { ops: poly([[right - d, bottom - d], [right, bottom - d], [right, bottom], [right - d, bottom]]) }
  // a ring is stroked on its centerline, half the 1px inside the outer edge
  return type === 'circle'
    ? { ops: ellipse(right - d / 2, bottom - d / 2, (d - 1) / 2), ring: 1 }
    : { ops: ellipse(right - d / 2, bottom - d / 2, d / 2) }
}

// ::marker boxes aren't nodes, so markers are drawn here, a small gap before the first line's
// content (after the marker too when it sits inside); RTL mirrors that from the content's right edge
export function emitListMarker(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx): void {
  if (s.display !== 'list-item') return
  const rtl = s.direction === 'rtl'
  const rightEdge = () => el.getBoundingClientRect().right - (parseFloat(s.borderRightWidth) || 0) - (parseFloat(s.paddingRight) || 0)
  const type = s.listStyleType
  if (!type || type === 'none') return

  const ms = getComputedStyle(el, '::marker')
  // an authored ::marker { content: none } suppresses the marker (default is 'normal')
  if (ms.content === 'none') return
  let text: string | null = null
  const strM = ms.content.match(/^"((?:[^"\\]|\\.)*)"$/)
  if (strM?.[1] !== undefined) text = strM[1].replace(/\\(.)/g, '$1')

  if (text === null && SHAPE_MARKERS.has(type)) {
    const start = contentStart(el, s, ctx)
    if (!start) return
    const { color: clr, alpha } = splitColorAlpha(parseColorAlpha(ms.color || s.color))
    const edge = (rtl ? rightEdge() : start.left) - ctx.containerRect.left
    const shape = markerShape(type, rtl ? -edge : edge, start.baseline - ctx.containerRect.top, parseFloat(s.fontSize) || 16)
    const mirror = (seg: PathSeg) => rtl ? { op: seg.op, args: seg.args.map((v, i) => i % 2 ? v : -v) } : seg
    const ops = shape.ops.map(mirror).map(seg => ({ op: seg.op, args: seg.args.map(v => v / PX_PER_PT) }))
    const ys = ops.flatMap(seg => seg.args.filter((_, i) => i % 2 === 1))
    const { page, y: ly } = paginate(Math.min(...ys), ctx.pageH)
    const dy = ly - Math.min(...ys)
    ctx.commands.push({
      type: 'path', page, ops: ops.map(seg => ({ op: seg.op, args: seg.args.map((v, i) => i % 2 ? v + dy : v) })),
      ...(shape.ring ? { stroke: clr ?? [0, 0, 0], strokeWidth: shape.ring / PX_PER_PT } : { fill: clr ?? [0, 0, 0] }),
      opacity: combineOpacity(stackOpacity(ctx), alpha), blend: stackBlend(ctx),
    } as PathCommand)
    return
  }

  if (text === null) {
    text = markerLabel(type, listIndex(el))
    // the suffix is a neutral character, so in RTL it shows on the left: ".1"
    if (text && rtl && text.endsWith('.')) text = '.' + text.slice(0, -1)
  }
  if (!text) return

  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts)
  if (!fontRef) return

  const start = contentStart(el, s, ctx)
  if (!start) return
  const sizePx = parseFloat(s.fontSize) || 16
  const sizePt = sizePx / PX_PER_PT
  const markerW = measure_string_width(text, fontRef.name, fontRef.style, fontRef.weight, 0, sizePt)
  const gapPt   = sizePt * 0.4

  const xPt = rtl
    ? (rightEdge() - ctx.containerRect.left) / PX_PER_PT + gapPt
    : (start.left - ctx.containerRect.left) / PX_PER_PT - gapPt - markerW
  const yPt = (start.baseline - ctx.containerRect.top)  / PX_PER_PT
  const { page, y: ly } = paginate(yPt, ctx.pageH)
  const { color: clr, alpha } = splitColorAlpha(parseColorAlpha(ms.color || s.color))

  ctx.commands.push({
    type: 'text', page,
    text,
    x: xPt, y: ly,
    font: fontRef.name, style: fontRef.style, weight: fontRef.weight,
    size: sizePt, color: clr ?? ([0, 0, 0] as Color),
    maxWidth: markerW + sizePt,
    opacity: combineOpacity(stackOpacity(ctx), alpha),
    skew: syntheticSkew(s, fontRef),
    blend: stackBlend(ctx),
  } as TextCommand)
}

// Where a list item's first line starts and its baseline (viewport px): from the first
// character and the per-font offset when it opens with text, else a probe (a relayout).
function contentStart(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx): { left: number; baseline: number } | null {
  let first = el.firstChild
  while (first?.nodeType === Node.TEXT_NODE && !(first.textContent ?? '').trim()) first = first.nextSibling
  if (first?.nodeType === Node.TEXT_NODE) {
    const text = first as Text
    const raw = text.textContent
    const i = raw.search(/\S/)
    const range = el.ownerDocument.createRange()
    range.setStart(text, i)
    range.setEnd(text, i + ((raw.codePointAt(i) ?? 0) > 0xFFFF ? 2 : 1))
    const r = range.getBoundingClientRect()
    if (r.width > 0 || r.height > 0) return { left: r.left, baseline: r.top + baselineOffset(el, text, s, r.top, ctx) }
  }
  const probe = el.ownerDocument.createElement('span')
  probe.style.cssText = 'display:inline;font-size:0;line-height:0;vertical-align:baseline;visibility:hidden;pointer-events:none;'
  try {
    el.insertBefore(probe, el.firstChild)
    const pr = probe.getBoundingClientRect()
    return { left: pr.left, baseline: pr.top }
  } catch {
    return null
  } finally {
    probe.remove()
  }
}

const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

// The text of an element without the form controls inside it (a select's options would
// otherwise read as part of its label)
function labelText(el: Element): string {
  const copy = el.cloneNode(true) as Element
  for (const control of Array.from(copy.querySelectorAll('input, select, textarea, button'))) control.remove()
  return collapse(copy.textContent)
}

// A form control's accessible name, in the order browsers compute it
function controlName(el: Element, fallback: string): string {
  const doc = el.ownerDocument
  const byIds = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)
    .map(id => doc.getElementById(id)).filter((e): e is HTMLElement => !!e).map(labelText).join(' ')
  const label = (el as HTMLInputElement).labels?.[0]
  return byIds || collapse(el.getAttribute('aria-label')) || (label ? labelText(label) : '') ||
    collapse(el.getAttribute('title')) || collapse(el.getAttribute('placeholder')) || fallback
}

export function emitLinks(el: HTMLAnchorElement, ctx: WalkerCtx): void {
  const raw = el.getAttribute('href')
  if (!raw) return
  // a fragment stays an internal jump; anything else resolves against the page's address,
  // so a relative link still leads somewhere from the PDF
  const href = raw.startsWith('#') ? raw : el.href
  if (!href.startsWith('#') && !LINK_SCHEMES.test(href)) return
  // the link's accessible description: its label, its text or an image's alt, else its target
  const contents = collapse(el.getAttribute('aria-label')) || collapse(el.getAttribute('title')) || collapse(el.textContent) ||
    collapse(el.querySelector('img[alt]')?.getAttribute('alt')) || href
  for (const domRect of Array.from(el.getClientRects())) {
    if (domRect.width < 1 || domRect.height < 1) continue
    const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)
    for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
      // annotation rects aren't auto-clipped by the MediaBox the way drawn content
      // is, so each page's slice needs its own explicit clamped height
      const sliceTop = Math.max(0, ly)
      const sliceH   = Math.min(ctx.pageH, ly + h) - sliceTop
      if (sliceH < 0.5) continue
      ctx.commands.push({ type: 'link', page, href, x, y: sliceTop, w, h: sliceH, structAnnot: tagStructAnnot(ctx, page), contents } as LinkCommand)
    }
  }
}

// D1 (AcroForm): date/time/color/file/range/etc. have no plain-text PDF
// field equivalent worth the effort, and submit/button/reset/hidden/image
// aren't data fields at all — scoped to the controls that map cleanly onto
// /FT /Tx, /Btn, /Ch.
const TEXT_LIKE_INPUT_TYPES = new Set(['text', 'email', 'tel', 'url', 'number', 'password', 'search', ''])

// PDF field flags (/Ff), ISO 32000-1 tables 221, 228 and 232
const FF_READONLY = 1 << 0, FF_MULTILINE = 1 << 12, FF_PASSWORD = 1 << 13, FF_COMBO = 1 << 17, FF_MULTISELECT = 1 << 21

// A form control spanning a page break would need /Kids (multiple widgets
// sharing one field) — real, but a genuine edge case for a typically-small
// input/select; placed on its single primary page only, a documented
// simplification matching the same "not attempted" scope as radio grouping.
export function emitFormField(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx): void {
  const tag = el.tagName.toUpperCase()
  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return
  const { x, y, w, h } = domRectToPt(rect, ctx.containerRect)
  const { page, y: ly } = paginate(y, ctx.pageH)
  const color = parseColorAlpha(s.color)
  const rgb: Color = color ? [color[0], color[1], color[2]] : [0, 0, 0]

  // the DOM's own `name` is the natural source; PdfDoc makes repeats unique
  const name = (el as HTMLInputElement).name || `field${ctx.fieldCounter.n++}`
  const tooltip = controlName(el, name)
  // tagged only once a field is certain, so no structure element points at a missing widget
  const pushField = (cmd: FieldCommand): void => {
    const structAnnot = tagStructAnnot(ctx, page)
    ctx.commands.push(structAnnot === undefined ? { ...cmd, tooltip } : { ...cmd, structAnnot, tooltip })
  }
  // a control the page doesn't let you edit stays uneditable in the PDF
  const readOnly = (el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly ? FF_READONLY : 0

  // Btn (checkbox/radio) draws a pure-vector checkmark — no font involved at
  // all — so this must be dispatched BEFORE the font-resolution gate below.
  // Browsers' own UA stylesheets typically give form controls a non-inherited
  // default control font distinct from the surrounding page's font-family, so
  // gating on a resolved font (needed for Tx/Ch, which actually draw text)
  // silently dropped every checkbox/radio field entirely — confirmed via a
  // real render whose checkboxes never appeared in /AcroForm /Fields at all.
  if (tag === 'INPUT') {
    const inputType = ((el as HTMLInputElement).type || 'text').toLowerCase()
    if (inputType === 'checkbox' || inputType === 'radio') {
      pushField({
        type: 'field', page, x, y: ly, w, h, name,
        font: '', style: '', weight: 400, size: 0, color: rgb,
        fieldType: 'Btn', checked: (el as HTMLInputElement).checked, flags: readOnly || undefined,
      } as FieldCommand)
      return
    }
  }

  // Unlike a plain text node, a form field's /V (value) and /T (name) carry
  // real document data with nothing to do with fonts — an unresolvable font
  // must only blank out the STATIC appearance (add_form_field degrades to an
  // empty AP stream, no /DA), not drop the whole field/widget/AcroForm entry.
  // This matters in practice: browsers give form controls a non-inherited
  // default control font (the same reason Btn is handled above), so an input
  // that doesn't EXPLICITLY repeat font-family on itself — extremely common,
  // since most authors rely on inheriting the page's own font — would
  // otherwise silently lose its entire field, confirmed via a real render.
  const fontRef = resolveFontRef(s.fontFamily, s.fontWeight, s.fontStyle, ctx.fontMap, ctx.registeredFonts)
  const sizePt = fontRef ? (parseFloat(s.fontSize) || 16) / PX_PER_PT : 0
  const base = {
    type: 'field' as const, page, x, y: ly, w, h, name,
    font: fontRef?.name ?? '', style: fontRef?.style ?? '', weight: fontRef?.weight ?? 400, size: sizePt, color: rgb,
  }

  if (tag === 'SELECT') {
    const select = el as HTMLSelectElement
    const opts = Array.from(select.options)
    const sel = opts[select.selectedIndex]
    // a dropdown is a combo box; without the flag viewers draw a list box
    const flags = (select.multiple ? FF_MULTISELECT : select.size > 1 ? 0 : FF_COMBO) | readOnly
    const exportValues = opts.some(o => o.value !== o.text) ? opts.map(o => o.value) : undefined
    pushField({
      ...base, fieldType: 'Ch', flags, value: sel?.value ?? '', display: sel?.text ?? '',
      options: opts.map(o => o.text), exportValues,
    } as FieldCommand)
    return
  }

  if (tag === 'TEXTAREA') {
    pushField({ ...base, fieldType: 'Tx', flags: FF_MULTILINE | readOnly, value: (el as HTMLTextAreaElement).value })
    return
  }

  if (tag === 'INPUT') {
    const input = el as HTMLInputElement
    const inputType = (input.type || 'text').toLowerCase()
    if (inputType === 'password') {
      // the page shows bullets, so the PDF does too; the value itself is never written
      pushField({ ...base, fieldType: 'Tx', flags: FF_PASSWORD | readOnly, value: '', display: '•'.repeat([...input.value].length) })
    } else if (TEXT_LIKE_INPUT_TYPES.has(inputType)) {
      pushField({ ...base, fieldType: 'Tx', flags: readOnly || undefined, value: input.value } as FieldCommand)
    }
  }
}

export function captureAnchor(el: Element, ctx: WalkerCtx): void {
  if (!el.id) return
  // duplicate ids resolve to the first element, like getElementById
  if (ctx.anchors.has(el.id)) return
  const r   = el.getBoundingClientRect()
  const yPt = (r.top - ctx.containerRect.top) / PX_PER_PT
  const { page, y } = paginate(yPt, ctx.pageH)
  ctx.anchors.set(el.id, { page, y })
}
