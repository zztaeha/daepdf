import type { ColorAlpha, BorderRadius, Corner, BoxShadow, Gradient, GradientStop, ConicGradient } from '../types/index.js'
import { PX_PER_PT } from './types.js'

// keepZeroAlpha: a fill/border color that's fully transparent is correctly
// "nothing to paint" (the default, null) — but a gradient STOP that's fully
// transparent is real, load-bearing data (position AND color both matter for
// interpolation), not something to silently drop. Gradient-stop parsing
// passes true; every other caller (fills, borders, etc.) keeps the default.
export function parseColorAlpha(css: string, keepZeroAlpha = false): ColorAlpha | null {
  if (!css || css === 'transparent') return keepZeroAlpha ? [0, 0, 0, 0] : null
  const m = css.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?/)
  if (!m) {
    const modern = parseColor4(css)
    if (modern) return modern[3] === 0 && !keepZeroAlpha ? null : modern
    return namedColor(css)
  }
  const a = m[4] !== undefined ? Math.round(+m[4] * 255) : 255
  if (a === 0 && !keepZeroAlpha) return null
  return [+m[1]!, +m[2]!, +m[3]!, a]
}

// CSS Color 4. getComputedStyle preserves these functions rather than folding
// them to rgb(), so anything written in oklch() or color() reached the old
// comma-only regex, failed it, and was dropped as "nothing to paint".

const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)))

// linear-light component to sRGB's transfer function
const gam = (v: number): number => v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055

function linearSrgbToBytes(r: number, g: number, b: number, a: number): ColorAlpha {
  return [clamp255(gam(r)), clamp255(gam(g)), clamp255(gam(b)), Math.max(0, Math.min(255, Math.round(a * 255)))]
}

// Ottosson's OKLab, via the cube of the LMS response
function oklabToLinearSrgb(L: number, aa: number, bb: number): [number, number, number] {
  const l = (L + 0.3963377774 * aa + 0.2158037573 * bb) ** 3
  const m = (L - 0.1055613458 * aa - 0.0638541728 * bb) ** 3
  const s = (L - 0.0894841775 * aa - 1.2914855480 * bb) ** 3
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ]
}

// CIE Lab is defined against D50 in CSS; the matrix below folds the Bradford
// adaptation to D65 and the sRGB primaries into one step.
function labToLinearSrgb(L: number, aa: number, bb: number): [number, number, number] {
  const K = 24389 / 27, E = 216 / 24389
  const fy = (L + 16) / 116, fx = fy + aa / 500, fz = fy - bb / 200
  const f = (t: number, w: number) => (t ** 3 > E ? t ** 3 : (116 * t - 16) / K) * w
  const x = f(fx, 0.9642956764295677), y = (L > K * E ? ((L + 16) / 116) ** 3 : L / K), z = f(fz, 0.8251046025104602)
  return [
    3.1341359569958707 * x - 1.6173863321612538 * y - 0.4906619460083532 * z,
    -0.978795502912089 * x + 1.9161404054726447 * y + 0.03344273116131949 * z,
    0.07195537988411677 * x - 0.2289768264158322 * y + 1.4053400825966042 * z,
  ]
}

function p3ToLinearSrgb(r: number, g: number, b: number): [number, number, number] {
  const lin = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  return [
    1.2249401762805587 * R - 0.2249401762805586 * G,
    -0.04205697751790684 * R + 1.0420569775179068 * G,
    -0.019637081008086 * R - 0.07863825739195 * G + 1.0982753384000616 * B,
  ]
}

const num = (t: string | undefined, pctOf = 1): number =>
  t === undefined ? NaN : t.endsWith('%') ? parseFloat(t) / 100 * pctOf : parseFloat(t)

// "a b c / d" or "a, b, c, d" -> components plus alpha
function components(inner: string): { c: string[]; alpha: number } | null {
  const [main = '', alphaPart] = inner.split('/')
  const c = main.trim().split(/[\s,]+/).filter(Boolean)
  if (c.length < 3) return null
  const alpha = alphaPart !== undefined ? num(alphaPart.trim())
              : c.length > 3 ? num(c[3]) : 1
  if (!Number.isFinite(alpha)) return null
  return { c, alpha: Math.max(0, Math.min(1, alpha)) }
}

function parseColor4(css: string): ColorAlpha | null {
  const m = css.trim().match(/^([a-z]+)\(([^)]*)\)$/i)
  if (!m) return null
  const fn = (m[1] ?? '').toLowerCase()
  const parts = components(m[2] ?? '')
  if (!parts) return null
  const { c, alpha } = parts
  const n = (i: number, pctOf = 1) => num(c[i], pctOf)

  // color() names its space in the first slot, so it is dispatched before the
  // numeric check the other functions need.
  if (fn === 'color') {
    const space = (c[0] ?? '').toLowerCase()
    const v = components((m[2] ?? '').replace(/^\s*[a-zA-Z0-9-]+\s*/, ''))
    if (!v || !v.c.slice(0, 3).every(t => Number.isFinite(parseFloat(t)))) return null
    const [r, g, b] = [num(v.c[0]), num(v.c[1]), num(v.c[2])]
    const toLinear = (x: number) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
    if (space === 'srgb') return linearSrgbToBytes(toLinear(r), toLinear(g), toLinear(b), v.alpha)
    if (space === 'srgb-linear') return linearSrgbToBytes(r, g, b, v.alpha)
    if (space === 'display-p3') return linearSrgbToBytes(...p3ToLinearSrgb(r, g, b), v.alpha)
    return null
  }

  if (!c.slice(0, 3).every(t => Number.isFinite(parseFloat(t)))) return null

  if (fn === 'rgb' || fn === 'rgba') {
    // percentages are of 255 here, bare numbers already are 0-255
    const v = (i: number) => { const t = c[i] ?? ''; return t.endsWith('%') ? parseFloat(t) / 100 * 255 : parseFloat(t) }
    return [
      Math.max(0, Math.min(255, Math.round(v(0)))),
      Math.max(0, Math.min(255, Math.round(v(1)))),
      Math.max(0, Math.min(255, Math.round(v(2)))),
      Math.round(alpha * 255),
    ]
  }
  if (fn === 'oklab') return linearSrgbToBytes(...oklabToLinearSrgb(n(0), n(1), n(2)), alpha)
  if (fn === 'oklch') {
    const h = n(2) * Math.PI / 180
    return linearSrgbToBytes(...oklabToLinearSrgb(n(0), n(1) * Math.cos(h), n(1) * Math.sin(h)), alpha)
  }
  if (fn === 'lab') return linearSrgbToBytes(...labToLinearSrgb(n(0, 100), n(1), n(2)), alpha)
  if (fn === 'lch') {
    const h = n(2) * Math.PI / 180
    return linearSrgbToBytes(...labToLinearSrgb(n(0, 100), n(1) * Math.cos(h), n(1) * Math.sin(h)), alpha)
  }
  return null
}


const _namedColors: Record<string, ColorAlpha> = {
  black: [0,0,0,255], white: [255,255,255,255], red: [255,0,0,255],
  green: [0,128,0,255], blue: [0,0,255,255], gray: [128,128,128,255],
  grey: [128,128,128,255], yellow: [255,255,0,255], orange: [255,165,0,255],
  purple: [128,0,128,255], pink: [255,192,203,255], brown: [165,42,42,255],
  cyan: [0,255,255,255], magenta: [255,0,255,255], lime: [0,255,0,255],
  navy: [0,0,128,255], teal: [0,128,128,255], maroon: [128,0,0,255],
  silver: [192,192,192,255], indigo: [75,0,130,255], violet: [238,130,238,255],
  transparent: [0,0,0,0],
}

function namedColor(name: string): ColorAlpha | null {
  return _namedColors[name.toLowerCase()] ?? null
}

export function splitByTopLevelComma(s: string): string[] {
  const parts: string[] = []
  let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) { if (cur.trim()) parts.push(cur.trim()); cur = '' }
    else cur += ch
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

// splits "calc(100% - 10px) 20px" into its two components — a plain \s+ split
// would break inside the calc() parentheses
export function splitPositionPair(v: string): string[] {
  return v.trim().split(/\s+(?![^()]*\))/)
}

// "in oklab", "in hsl longer hue": the space a gradient interpolates in. The PDF interpolates
// in sRGB either way, so the clause is dropped instead of being misread as a stop or direction.
const INTERPOLATION = /\s*\bin\s+[a-z][a-z0-9-]*(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?\s*/i

function withoutInterpolation(parts: string[]): string[] {
  const head = parts[0]
  if (head === undefined || !INTERPOLATION.test(head)) return parts
  const rest = head.replace(INTERPOLATION, ' ').trim()
  return rest ? [rest, ...parts.slice(1)] : parts.slice(1)
}

// A stop without a position gets NaN here; fixupStopPositions spreads it once px positions
// have resolved against the box. Hints ("30%") are not stops and are skipped.
function parseCSSGradientStops(parts: string[]): GradientStop[] {
  const stops: GradientStop[] = []
  for (const part of parts) {
    // token 0 is the color, the rest are positions ("red 20% 40%" is a double-position
    // stop: the same color at both). A position the color parser would choke on (px,
    // calc) must never take the whole stop down with it — losing one stop can silently
    // kill the entire gradient once fewer than two remain.
    const toks = splitPositionPair(part)
    const c = parseColorAlpha(toks[0] ?? '', true)
    if (!c) continue
    const posToks = toks.slice(1, 3)
    if (!posToks.length) {
      stops.push({ color: c, position: NaN })
      continue
    }
    for (const tok of posToks) {
      const pctM = tok.match(/^(-?[\d.]+)%$/)
      const pxM  = tok.match(/^(-?[\d.]+)px$/)
      if (pctM)     stops.push({ color: c, position: +pctM[1]! / 100 })
      else if (pxM) stops.push({ color: c, position: NaN, posPx: +pxM[1]! })
      // calc()/em: unresolvable, so it takes an implicit position
      else          stops.push({ color: c, position: NaN })
    }
  }
  return stops
}

// CSS Images 3 §3.5.3: a missing first/last position is 0/1, a position below an earlier one
// is raised to it, and each run without one spreads evenly between its neighbors.
function fixupStopPositions(stops: GradientStop[]): GradientStop[] {
  const out = stops.map(st => ({ ...st }))
  const first = out[0], last = out.at(-1)
  if (!first || !last) return out
  if (Number.isNaN(first.position)) first.position = 0
  if (Number.isNaN(last.position)) last.position = 1
  let max = -Infinity
  for (const st of out) if (!Number.isNaN(st.position)) { st.position = Math.max(st.position, max); max = st.position }
  for (let i = 1; i < out.length; i++) {
    if (!Number.isNaN(out[i]!.position)) continue
    let j = i
    while (Number.isNaN(out[j]!.position)) j++
    const a = out[i - 1]!.position, b = out[j]!.position
    for (let k = i; k < j; k++) out[k]!.position = a + (b - a) * (k - i + 1) / (j - i + 1)
    i = j
  }
  return out
}

// Repeating gradients (linear/radial/conic alike): tile the stop pattern across
// [0,1], the same fractional domain regardless of what physically maps to it
// (gradient-line length, shading radius, or full turn). The tile boundary keeps
// both the previous tile's last stop and the next tile's first stop at the same
// position — that coincidence IS the hard color restart repeating-gradient's
// author sees (downstream normalization nudges them apart by an invisible
// epsilon so a shading function's /Bounds stays strictly increasing).
export function tileStops(stops: GradientStop[], repeating: boolean | undefined): GradientStop[] {
  if (!repeating || stops.length < 2) return stops
  const pat    = stops
  const s0     = pat[0]!.position
  const period = pat.at(-1)!.position - s0
  if (period <= 1e-4) return stops

  // A budget is needed – the period can be as small as 1e-4 – but 200 stops ran
  // out at position 0.4 for a 0.4% pattern, leaving most of the box painted in
  // one flat color. 2000 covers any repeating gradient down to a 0.05% period,
  // which is finer than anything a printed page resolves.
  const MAX_TILED_STOPS = 2000
  const out: GradientStop[] = []
  let done = false
  for (let k = Math.floor(-s0 / period); !done && out.length < MAX_TILED_STOPS; k++) {
    for (const st of pat) {
      const p = st.position + k * period
      out.push({ color: st.color, position: p })
      if (p >= 1) { done = true; break }
    }
  }
  // Finer than the budget: stretch the final stop to the end of the gradient
  // line. The tail is coarser than the author asked for, which is a smaller
  // error than leaving the rest of the box a single color.
  const tail = out.at(-1)
  if (!done && tail) out[out.length - 1] = { ...tail, position: 1 }
  // stops entirely below 0 add nothing — keep the last one for correct
  // interpolation at the 0 edge (downstream clamps it to 0)
  const firstIdx = Math.max(0, out.findIndex(st => st.position > 0) - 1)
  return out.slice(firstIdx)
}

export function parseCSSGradient(css: string): Gradient | null {
  const linM = css.match(/^(repeating-)?linear-gradient\((.+)\)$/s)
  if (linM) {
    const repeating = !!linM[1]
    const parts = withoutInterpolation(splitByTopLevelComma((linM[2] ?? '').trim()))
    let angle = 180
    let corner: string | undefined
    const head = parts[0] ?? ''
    const degMatch = head.match(/^(-?[\d.]+)deg$/)
    const toMatch  = head.match(/^to\s+(top|bottom|left|right)(?:\s+(top|bottom|left|right))?$/)
    if (degMatch) {
      angle = +degMatch[1]!
      parts.shift()
    } else if (toMatch) {
      const words = [toMatch[1], toMatch[2]].filter(Boolean) as string[]
      const vert  = words.find(kw => kw === 'top' || kw === 'bottom')
      const horiz = words.find(kw => kw === 'left' || kw === 'right')
      if (vert && horiz) {
        // computed styles may serialize either keyword order ("to right top") —
        // normalize, and tag the corner so the true angle can be resolved against
        // the painted box's aspect ratio (45° multiples only hold for squares)
        corner = `${vert} ${horiz}`
        angle  = { 'top right': 45, 'bottom right': 135, 'bottom left': 225, 'top left': 315 }[corner]!
      } else {
        angle = { bottom: 180, top: 0, right: 90, left: 270 }[words[0] ?? ''] ?? 180
      }
      parts.shift()
    }
    const stops = parseCSSGradientStops(parts)
    if (stops.length >= 2) return { type: 'linear', angle, corner, repeating: repeating || undefined, stops }
  }

  const radM = css.match(/^(repeating-)?radial-gradient\((.+)\)$/s)
  if (radM) {
    const repeating = !!radM[1]
    const parts = withoutInterpolation(splitByTopLevelComma((radM[2] ?? '').trim()))
    // computed style serializes the preamble as "[circle] [size] [at x y]", with ellipse
    // (the default) left out and keyword positions already turned into percentages
    let circle = false, size: string[] | undefined, position: [string, string] | undefined
    const head = parts[0] ?? ''
    if (!parseColorAlpha(splitPositionPair(head)[0] ?? '', true)) {
      const [shapeSize = '', at] = head.split(/\s*\bat\s+/)
      const toks = shapeSize.trim().split(/\s+/).filter(Boolean)
      const sizeToks = toks.filter(t => t !== 'circle' && t !== 'ellipse')
      // a single length can only size a circle
      circle = toks.includes('circle') || (sizeToks.length === 1 && /\d/.test(sizeToks[0]!))
      if (sizeToks.length) size = sizeToks
      if (at) { const p = splitPositionPair(at); position = [p[0] ?? '50%', p[1] ?? '50%'] }
      parts.shift()
    }
    const stops = parseCSSGradientStops(parts)
    if (stops.length >= 2) return { type: 'radial', circle: circle || undefined, size, position, repeating: repeating || undefined, stops }
  }

  return null
}

// conic stop positions are angles (deg or % of a turn), normalized to 0..1
export function parseCSSConicGradient(css: string): ConicGradient | null {
  const m = css.match(/^(repeating-)?conic-gradient\((.+)\)$/s)
  if (!m) return null
  const repeating = !!m[1]
  const parts = withoutInterpolation(splitByTopLevelComma((m[2] ?? '').trim()))
  let fromDeg = 0, position: [string, string] | undefined

  const pre = (parts[0] ?? '').match(/^(?:from\s+(-?[\d.]+)deg)?\s*(?:at\s+(.+))?$/)
  if (pre && (pre[1] !== undefined || pre[2] !== undefined)) {
    if (pre[1] !== undefined) fromDeg = +pre[1]
    if (pre[2] !== undefined) { const p = splitPositionPair(pre[2]); position = [p[0] ?? '50%', p[1] ?? '50%'] }
    parts.shift()
  }

  // angles (deg or % of a turn) normalized to 0..1; implicit ones spread by the CSS fixup
  const stops: GradientStop[] = []
  for (const part of parts) {
    const toks = splitPositionPair(part)
    const c = parseColorAlpha(toks[0] ?? '', true)
    if (!c) continue
    const posToks = toks.slice(1, 3)
    if (!posToks.length) { stops.push({ color: c, position: NaN }); continue }
    for (const tok of posToks) {
      const degM = tok.match(/^(-?[\d.]+)deg$/)
      const pctM = tok.match(/^(-?[\d.]+)%$/)
      stops.push({ color: c, position: degM ? +degM[1]! / 360 : pctM ? +pctM[1]! / 100 : NaN })
    }
  }
  if (stops.length < 2) return null
  return { fromDeg, position, repeating: repeating || undefined, stops: fixupStopPositions(stops) }
}

export function parseCSSBoxShadow(css: string): BoxShadow[] {
  if (!css || css === 'none') return []
  const shadows: BoxShadow[] = []

  for (const part of splitByTopLevelComma(css)) {
    const tokens  = part.trim().split(/\s+/)
    let inset     = false
    const lengths: number[] = []
    const colorTokens: string[] = []

    for (const tok of tokens) {
      if (tok === 'inset') { inset = true; continue }
      const pxM = tok.match(/^-?[\d.]+px$/)
      if (pxM) { lengths.push(parseFloat(tok) / PX_PER_PT); continue }
      colorTokens.push(tok)
    }

    const colorStr = colorTokens.join(' ')
    const color    = parseColorAlpha(colorStr, true) ?? ([0, 0, 0, 180] as ColorAlpha)
    // a transparent shadow (a focus ring at rest, say) paints nothing
    if (color[3] === 0) continue

    if (lengths.length >= 2) {
      shadows.push({
        x: lengths[0]!, y: lengths[1]!,
        blur:   lengths[2] ?? 0,
        spread: lengths[3],
        color, inset,
      })
    }
  }
  return shadows
}

function radiusComponent(str: string, ref: number): number {
  const ptM = str.match(/^(-?[\d.]+)pt$/)
  if (ptM) return Math.max(0, +ptM[1]!)
  return Math.max(0, resolveLength(str, ref) ?? 0)
}

// The CSS overlap constraint: scale every radius down by the largest f ≤ 1 that
// keeps adjacent corners from overlapping (this is what turns border-radius:9999px
// into a pill). h-components compete for width, v-components for height; the single
// smallest factor applies to all components together, per spec.
function overlapScale(tl: Corner, tr: Corner, br: Corner, bl: Corner, w: number, h: number): number {
  return Math.min(1,
    ...([[w, tl.h + tr.h], [w, bl.h + br.h], [h, tl.v + bl.v], [h, tr.v + br.v]] as [number, number][])
      .filter(([, sum]) => sum > 0)
      .map(([limit, sum]) => limit / sum))
}

// dims (pt) substitutes for the element rect when there is no element to measure —
// pseudo-element boxes have computed styles but no DOM node to getBoundingClientRect
export function parseBorderRadius(s: CSSStyleDeclaration, el?: Element, dims?: { w: number; h: number }): BorderRadius | undefined {
  const rect = el?.getBoundingClientRect()
  const elW = rect ? rect.width  / PX_PER_PT : dims?.w ?? 0
  const elH = rect ? rect.height / PX_PER_PT : dims?.h ?? 0

  // computed border-*-radius is "H" or "H V". A single percentage still resolves
  // per-axis (h against width, v against height) — that's what makes
  // border-radius:50% an ellipse on a non-square box, per spec.
  const parseCorner = (val: string): Corner => {
    const parts = splitPositionPair(val)
    const hStr  = parts[0] ?? val
    const vStr  = parts[1] ?? hStr
    return { h: radiusComponent(hStr, elW), v: radiusComponent(vStr, elH) }
  }

  const tl = parseCorner(s.borderTopLeftRadius)
  const tr = parseCorner(s.borderTopRightRadius)
  const br = parseCorner(s.borderBottomRightRadius)
  const bl = parseCorner(s.borderBottomLeftRadius)

  if (elW > 0 && elH > 0) {
    const f = overlapScale(tl, tr, br, bl, elW, elH)
    if (f < 1) {
      for (const c of [tl, tr, br, bl]) { c.h *= f; c.v *= f }
    }
  }

  const corners = [tl, tr, br, bl]
  if (corners.every(c => c.h === 0 && c.v === 0)) return undefined
  if (corners.every(c => c.h === tl.h && c.v === tl.h)) return { all: tl.h }
  return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl }
}

// the same overlap constraint parseBorderRadius applies, but against an arbitrary
// box — an inline element's per-line fragments can be smaller than the radius the
// union rect allowed, and an unclamped radius builds a self-crossing bezier
export function clampRadiusToBox(radius: BorderRadius | undefined, w: number, h: number): BorderRadius | undefined {
  if (!radius || w <= 0 || h <= 0) return radius
  const a = radius.all ?? 0
  const c = (x?: Corner): Corner => x ? { h: x.h, v: x.v } : { h: a, v: a }
  const tl = c(radius.topLeft), tr = c(radius.topRight)
  const br = c(radius.bottomRight), bl = c(radius.bottomLeft)
  const f = overlapScale(tl, tr, br, bl, w, h)
  if (f >= 1) return radius
  for (const corner of [tl, tr, br, bl]) { corner.h *= f; corner.v *= f }
  return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl }
}

// Inner curve after insetting each side (border widths, padding): per CSS, a
// corner's h component shrinks by the adjacent vertical edge's inset (left or
// right side), its v component by the adjacent horizontal edge's (top/bottom).
// Components clamp at square; all-square collapses to undefined.
export function insetBorderRadius(
  radius: BorderRadius | undefined,
  iT: number, iR: number, iB: number, iL: number,
): BorderRadius | undefined {
  if (!radius) return undefined
  const a = radius.all ?? 0
  const inset = (c: Corner | undefined, ih: number, iv: number): Corner => {
    const base = c ?? { h: a, v: a }
    return { h: Math.max(0, base.h - ih), v: Math.max(0, base.v - iv) }
  }
  const tl = inset(radius.topLeft,     iL, iT)
  const tr = inset(radius.topRight,    iR, iT)
  const br = inset(radius.bottomRight, iR, iB)
  const bl = inset(radius.bottomLeft,  iL, iB)
  if ([tl, tr, br, bl].every(c => c.h <= 0 || c.v <= 0)) return undefined
  return { topLeft: tl, topRight: tr, bottomRight: br, bottomLeft: bl }
}

// parseColorAlpha returns null for both "not a color I can parse" and "fully
// transparent" — callers that fall back to a default color on null need to tell
// the two apart, or transparent renders as the fallback
export function isTransparentColor(css: string): boolean {
  return parseColorAlpha(css, true)?.[3] === 0
}

export function pxToPt(s: string): number {
  const m = s.match(/^(-?[\d.]+)px$/)
  return m ? +m[1]! / PX_PER_PT : 0
}

// A length in pt, against `space` for percentages: px, %, and the calc(a% ± bpx) that
// mixed values and 4-value positions compute to. Null for anything else.
export function resolveLength(val: string, space: number): number | null {
  const pctM = val.match(/^(-?[\d.]+)%$/)
  if (pctM) return space * (+pctM[1]! / 100)
  const pxM = val.match(/^(-?[\d.]+)px$/)
  if (pxM) return +pxM[1]! / PX_PER_PT
  const calcM = val.match(/^calc\((-?[\d.]+)%\s*([+-])\s*(-?[\d.]+)px\)$/)
  if (!calcM) return null
  const base = space * (+calcM[1]! / 100)
  const off  = +calcM[3]! / PX_PER_PT
  return calcM[2] === '+' ? base + off : base - off
}

// A position component in pt; anything unresolvable centers, like an omitted one
export function parsePositionComponent(val: string | undefined, space: number): number {
  return (val ? resolveLength(val, space) : null) ?? space / 2
}

// CSS radial ending shape, in pt. Keywords measure from the center to the box's sides or
// corners; an ellipse through a corner keeps its side-keyword aspect ratio, scaled by √2.
function radialExtent(size: string[] | undefined, circle: boolean, cx: number, cy: number, w: number, h: number): [number, number] {
  const near: [number, number] = [Math.min(cx, w - cx), Math.min(cy, h - cy)]
  const far:  [number, number] = [Math.max(cx, w - cx), Math.max(cy, h - cy)]
  const kw = !size ? 'farthest-corner' : size.length === 1 && !/\d/.test(size[0]!) ? size[0]! : null
  if (kw) {
    const [sx, sy] = kw.startsWith('closest') ? near : far
    if (!circle) return kw.endsWith('corner') ? [sx * Math.SQRT2, sy * Math.SQRT2] : [sx, sy]
    const r = kw.endsWith('corner') ? Math.hypot(sx, sy) : kw.startsWith('closest') ? Math.min(sx, sy) : Math.max(sx, sy)
    return [r, r]
  }
  const rx = parsePositionComponent(size![0], w)
  return [rx, size![1] ? parsePositionComponent(size![1], h) : rx]
}

// What only resolves against the painted box: corner angles (45° multiples hold only for
// squares), a radial gradient's center and ending shape, and px-positioned stops.
export function resolveGradientBox(gradient: Gradient, w: number, h: number): Gradient {
  if (w <= 0 || h <= 0) return { ...gradient, stops: fixupStopPositions(gradient.stops) }

  if (gradient.type === 'linear' && gradient.corner) {
    const a = Math.atan2(h, w) * 180 / Math.PI
    const cornerAngle: Record<string, number> = {
      'top right': a, 'bottom right': 180 - a, 'bottom left': 180 + a, 'top left': 360 - a,
    }
    gradient = { ...gradient, angle: cornerAngle[gradient.corner] ?? gradient.angle }
  }

  if (gradient.type === 'radial' && gradient.rx === undefined) {
    const cx = parsePositionComponent(gradient.position?.[0], w)
    const cy = parsePositionComponent(gradient.position?.[1], h)
    const [rx, ry] = radialExtent(gradient.size, !!gradient.circle, cx, cy, w, h)
    gradient = {
      type: 'radial', cx: cx / w, cy: cy / h, rx: Math.max(rx, 0.01) / w, ry: Math.max(ry, 0.01) / h,
      repeating: gradient.repeating, stops: gradient.stops,
    }
  }

  if (gradient.stops.some(st => st.posPx !== undefined)) {
    // the gradient ray: the line's length for linear, the horizontal radius for radial
    const rad = gradient.type === 'linear' ? gradient.angle * Math.PI / 180 : 0
    const linePt = gradient.type === 'linear'
      ? Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad))
      : (gradient.rx ?? 0.5) * w
    if (linePt > 0) {
      gradient = { ...gradient, stops: gradient.stops.map(st =>
        st.posPx !== undefined
          ? { color: st.color, position: (st.posPx / PX_PER_PT) / linePt }
          : st
      ) }
    }
  }

  gradient = { ...gradient, stops: fixupStopPositions(gradient.stops) }

  // repeating gradients tile their stops across [0, 1], a fraction of the gradient line
  // (linear) or of the radius (radial) alike
  if (gradient.repeating) {
    gradient = { ...gradient, repeating: undefined, stops: tileStops(gradient.stops, true) }
  }

  return gradient
}
