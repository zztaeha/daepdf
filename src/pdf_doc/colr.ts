import type { Box, ColorFace, ColorLine, ColorRef, ColrGlyph, Paint, Point } from '../daegun/colorfonts.js'
import { IDENTITY, composeAffine, invertAffine, type Affine } from '../types/affine.js'
import type { InternalCtx } from './types.js'
import { outlinePath, type Outline } from './outlines.js'
import { buildFunction, normalizeStops, type Stop5 } from './build_resources.js'
import { deflate } from './deflate.js'
import { hpf } from './utils.js'

type RGBA = [number, number, number, number]

// Shadings, graphics states and group forms COLR glyphs draw with, deduplicated so a repeated
// emoji costs one set. A form's object number is unknown until it's written, so a graphics state
// refers to it by a placeholder resolved at write time.
export class ColrResources {
  readonly shadings: { dict: string; data: Uint8Array | null; oid: number }[] = []
  readonly gstates: string[] = []
  readonly forms: { ops: string; bbox: Box; group: string; oid: number }[] = []
  private readonly names = new Map<string, string>()

  private dedupe(key: string, add: () => string): string {
    let name = this.names.get(key)
    if (!name) { name = add(); this.names.set(key, name) }
    return name
  }

  shading(dict: string, data: Uint8Array | null): string {
    return this.dedupe(`s${dict}${data ? latin1(data) : ''}`, () => `CSh${this.shadings.push({ dict, data, oid: 0 }) - 1}`)
  }

  gstate(dict: string): string {
    return this.dedupe(`g${dict}`, () => `CGS${this.gstates.push(dict) - 1}`)
  }

  form(ops: string, bbox: Box, group: string): string {
    return this.dedupe(`f${group}|${bbox.map(num).join(' ')}|${ops}`, () => `CFm${this.forms.push({ ops, bbox, group, oid: 0 }) - 1}`)
  }

  static formRef(name: string): string { return `\u0000${name.slice(3)}\u0000` }

  resolve(dict: string): string {
    return dict.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `${this.forms[+i]!.oid} 0 R`)
  }
}

export function putColrResources(ctx: InternalCtx): void {
  const res = ctx.colrRes
  for (const s of res.shadings) {
    // a plain dictionary goes in an object stream, compressed with the rest
    if (!s.data) { s.oid = ctx.queueForObjStm(`<< ${s.dict} >>`); continue }
    s.oid = ctx.newObject()
    const body = deflate(s.data)
    ctx.out(`<< ${s.dict} /Filter /FlateDecode /Length ${ctx.encryptedLength(body.length)} >>`)
    ctx.out('stream'); ctx.outBytes(body); ctx.out('endstream'); ctx.out('endobj')
  }
  // Each form lists only what it uses; inner forms come first, so whatever a form names already
  // has its object number
  for (const f of res.forms) {
    const used = (re: RegExp) => [...new Set([...f.ops.matchAll(re)].map(m => m[1]!))]
    const entries = (key: string, names: string[], ref: (n: string) => string) =>
      names.length ? `/${key} << ${names.map(n => `/${n} ${ref(n)}`).join(' ')} >> ` : ''
    const resources = entries('Shading', used(/\/(CSh\d+) sh/g), n => `${res.shadings[+n.slice(3)]!.oid} 0 R`) +
      entries('ExtGState', used(/\/(CGS\d+) gs/g), n => res.resolve(res.gstates[+n.slice(3)]!)) +
      entries('XObject', used(/\/(CFm\d+) Do/g), n => `${res.forms[+n.slice(3)]!.oid} 0 R`)
    const body = deflate(new TextEncoder().encode(f.ops))
    f.oid = ctx.newObject()
    ctx.out(`<< /Type /XObject /Subtype /Form /FormType 1 /BBox [${f.bbox.map(num).join(' ')}] ${f.group}`)
    ctx.out(`/Resources << ${resources}>> /Filter /FlateDecode /Length ${ctx.encryptedLength(body.length)} >>`)
    ctx.out('stream'); ctx.outBytes(body); ctx.out('endstream'); ctx.out('endobj')
  }
}

export interface ColrEnv {
  face: ColorFace
  weight: number
  opsz: number
  // the text color, for palette index 0xFFFF
  fg: [number, number, number]
  res: ColrResources
  outline(gid: number): Outline | null
}

const GROUP = '/Group << /Type /Group /S /Transparency >>'
const ISOLATED = '/Group << /Type /Group /S /Transparency /I true >>'
const GRAY_GROUP = '/Group << /Type /Group /S /Transparency /CS /DeviceGray >>'
const BLEND: Record<number, string> = {
  12: 'Screen', 13: 'Screen', 14: 'Overlay', 15: 'Darken', 16: 'Lighten', 17: 'ColorDodge', 18: 'ColorBurn',
  19: 'HardLight', 20: 'SoftLight', 21: 'Difference', 22: 'Exclusion', 23: 'Multiply',
  24: 'Hue', 25: 'Saturation', 26: 'Color', 27: 'Luminosity',
}
// the composite modes drawn through a soft mask
const MASKED = new Set([5, 6, 7, 8, 9, 10, 11])
const WEDGE_DEG = 5

// One color glyph as a transparency-group form, so the opacity it's drawn under applies to the
// glyph as a whole. place maps font units to the form's space: null keeps font units, for a form
// drawn anywhere through cm. Returns null when the glyph draws nothing.
export function colrGlyphForm(glyph: ColrGlyph, gid: number, env: ColrEnv, place: Affine | null): { name: string; usesFg: boolean } | null {
  const u = env.face.upem
  const p = new Painter(env, glyph.clip ?? [-u, -u, 2 * u, 2 * u], place ?? IDENTITY)
  const ops = p.paint(glyph.paint, IDENTITY, new Set([gid]))
  if (!ops) return null
  return { name: env.res.form(`${p.regionPath} W n\n${ops}`, p.regionBox, GROUP), usesFg: p.usesFg }
}

// Quartz (Preview, Safari) clips a soft mask set under a scaled or moved CTM to the page box put
// through that CTM, so a glyph needing one is drawn in page space, its masks set at the identity.
export function colrNeedsMask(glyph: ColrGlyph, env: ColrEnv): boolean {
  const seen = new Set<Paint>()
  const translucent = (line: ColorLine) => line.stops.some(s =>
    s.color.alpha < 1 || (s.color.index !== 0xFFFF && (env.face.palette[s.color.index]?.[3] ?? 0) < 1))
  const walk = (p: Paint): boolean => {
    if (seen.has(p)) return false
    seen.add(p)
    switch (p.kind) {
      case 'layers': return p.paints.some(walk)
      case 'solid': return false
      case 'linear': case 'radial': case 'sweep': return translucent(p.line)
      case 'glyph': case 'transform': return walk(p.paint)
      case 'composite': return MASKED.has(p.mode) || walk(p.source) || walk(p.backdrop)
      case 'colrGlyph': {
        const g = env.face.glyph(p.gid, env.weight, env.opsz)
        return !!g && walk(g.paint)
      }
    }
  }
  return walk(glyph.paint)
}

class Painter {
  usesFg = false
  readonly regionPath: string
  readonly regionBox: Box

  // region is the glyph's clip box in font units; place maps font units to the target space
  constructor(private readonly env: ColrEnv, private readonly region: Box, private readonly place: Affine) {
    this.regionPath = path(region, place)
    this.regionBox = bounds(region, place)
  }

  // m maps the current paint space to font units
  paint(p: Paint, m: Affine, visiting: Set<number>): string {
    switch (p.kind) {
      case 'layers': return p.paints.map(c => this.paint(c, m, visiting)).join('')
      case 'solid': {
        const c = this.color(p.color)
        return c[3] <= 0 ? '' : `q ${this.alpha(c[3])}${rgb(c)} rg ${this.regionPath} f Q\n`
      }
      case 'glyph': {
        // the outline as a path, not as clipping text: text here would copy along with the glyph
        const outline = this.env.outline(p.gid)
        if (!outline?.length) return ''
        const inner = this.paint(p.paint, m, visiting)
        return inner && `q ${outlinePath(outline, composeAffine(this.place, m))} W n\n${inner}Q\n`
      }
      case 'colrGlyph': {
        if (visiting.has(p.gid)) return ''
        const g = this.env.face.glyph(p.gid, this.env.weight, this.env.opsz)
        if (!g) return ''
        const inner = this.paint(g.paint, m, new Set([...visiting, p.gid]))
        return inner && g.clip ? `q ${path(g.clip, composeAffine(this.place, m))} W n\n${inner}Q\n` : inner
      }
      case 'transform': return this.paint(p.paint, composeAffine(m, p.m), visiting)
      case 'composite': return this.composite(p.mode, p.source, p.backdrop, m, visiting)
      case 'linear': return this.linear(p.line, p.p0, p.p1, p.p2, m)
      case 'radial': return this.radial(p.line, p.c0, p.r0, p.c1, p.r1, m)
      case 'sweep': return this.sweep(p.line, p.center, p.start, p.end, m)
    }
  }

  private color(c: ColorRef): RGBA {
    if (c.index === 0xFFFF) { this.usesFg = true; return [...this.env.fg, c.alpha] }
    const pal = this.env.face.palette[c.index]
    return pal ? [pal[0], pal[1], pal[2], pal[3] * c.alpha] : [0, 0, 0, 0]
  }

  private alpha(a: number): string {
    return a >= 1 ? '' : `/${this.env.res.gstate(`<< /Type /ExtGState /ca ${num(a)} /CA ${num(a)} >>`)} gs `
  }

  // the region in paint space, or null when the transform collapses it
  private box(m: Affine): Box | null {
    const inv = invertAffine(m)
    return inv && bounds(this.region, inv)
  }

  private group(ops: string, group = ISOLATED): string { return this.env.res.form(ops, this.regionBox, group) }

  private maskState(form: string, type: 'Alpha' | 'Luminosity'): string {
    return this.env.res.gstate(`<< /Type /ExtGState /SMask << /Type /Mask /S /${type} /G ${ColrResources.formRef(form)} >> >>`)
  }

  private composite(mode: number, source: Paint, backdrop: Paint, m: Affine, visiting: Set<number>): string {
    if (mode === 0) return ''
    const src = this.paint(source, m, visiting), dst = mode === 1 ? '' : this.paint(backdrop, m, visiting)
    const draw = (ops: string, gs: string) => ops && `q /${gs} gs /${this.group(ops)} Do Q\n`
    const alphaOf = (ops: string) => this.maskState(this.group(ops), 'Alpha')
    // a luminosity mask of white with the operand's shape in black: 1 - its alpha
    const outsideOf = (ops: string) => this.maskState(this.group(
      `q 1 g ${this.regionPath} f Q\nq /${alphaOf(ops)} gs 0 g ${this.regionPath} f Q\n`, GRAY_GROUP), 'Luminosity')
    const inside = (a: string, b: string) => b ? draw(a, alphaOf(b)) : ''
    const outside = (a: string, b: string) => b ? draw(a, outsideOf(b)) : a
    switch (mode) {
      case 1: return src
      case 2: return dst
      case 3: return dst + src
      case 4: return src + dst
      case 5: return inside(src, dst)
      case 6: return inside(dst, src)
      case 7: return outside(src, dst)
      case 8: return outside(dst, src)
      // exact wherever alpha is 0 or 1, which vector shapes are away from their edges
      case 9: return dst + inside(src, dst)
      case 10: return src + inside(dst, src)
      case 11: return outside(src, dst) + outside(dst, src)
    }
    const blend = BLEND[mode]
    if (!blend || !src) return dst
    if (!dst) return src
    const bm = this.env.res.gstate(`<< /Type /ExtGState /BM /${blend} >>`)
    return `/${this.group(`${dst}q /${bm} gs /${this.group(src)} Do Q\n`)} Do\n`
  }

  private linear(line: ColorLine, p0: Point, p1: Point, p2: Point, m: Affine): string {
    const box = this.box(m)
    // colors run along p0p1 and hold along lines parallel to p0p2: the axis is p0p1 projected
    // onto the normal of p0p2
    const nx = p0[1] - p2[1], ny = p2[0] - p0[0], nn = nx * nx + ny * ny
    if (!box || nn === 0) return ''
    const k = ((p1[0] - p0[0]) * nx + (p1[1] - p0[1]) * ny) / nn
    const vx = nx * k, vy = ny * k, vv = vx * vx + vy * vy
    if (vv === 0) return ''
    const ts = corners(box).map(([x, y]) => ((x - p0[0]) * vx + (y - p0[1]) * vy) / vv)
    const t0 = Math.min(...ts), t1 = Math.max(...ts)
    const at = (t: number) => `${coord(p0[0] + t * vx)} ${coord(p0[1] + t * vy)}`
    return this.shade(line, t0, t1, `/ShadingType 2 /Coords [${at(t0)} ${at(t1)}]`, m)
  }

  private radial(line: ColorLine, c0: Point, r0: number, c1: Point, r1: number, m: Affine): string {
    const box = this.box(m)
    if (!box) return ''
    const dcx = c1[0] - c0[0], dcy = c1[1] - c0[1], dr = r1 - r0
    const a = dcx * dcx + dcy * dcy - dr * dr
    // the largest t whose circle, of non-negative radius, passes through the point
    const tAt = (x: number, y: number): number | null => {
      const px = x - c0[0], py = y - c0[1]
      const b = px * dcx + py * dcy + r0 * dr, c = px * px + py * py - r0 * r0
      const disc = b * b - a * c
      const roots = Math.abs(a) < 1e-9 ? (b === 0 ? [] : [c / (2 * b)])
        : disc < 0 ? [] : [(b + Math.sqrt(disc)) / a, (b - Math.sqrt(disc)) / a]
      const ok = roots.filter(t => r0 + t * dr >= 0)
      return ok.length ? Math.max(...ok) : null
    }
    let t0 = Infinity, t1 = -Infinity
    const N = 32
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const t = tAt(box[0] + (box[2] - box[0]) * i / N, box[1] + (box[3] - box[1]) * j / N)
      if (t !== null) { t0 = Math.min(t0, t); t1 = Math.max(t1, t) }
    }
    if (!(t1 >= t0)) return ''
    const pad = (t1 - t0) * 0.02 + 1e-6
    t0 -= pad; t1 += pad
    if (dr > 0) t0 = Math.max(t0, -r0 / dr)
    if (dr < 0) t1 = Math.min(t1, -r0 / dr)
    if (!(t1 > t0)) return ''
    const at = (t: number) => `${coord(c0[0] + t * dcx)} ${coord(c0[1] + t * dcy)} ${coord(Math.max(0, r0 + t * dr))}`
    return this.shade(line, t0, t1, `/ShadingType 3 /Coords [${at(t0)} ${at(t1)}]`, m)
  }

  // axial and radial: one function over [t0, t1], with an alpha soft mask when any stop is translucent
  private shade(line: ColorLine, t0: number, t1: number, geometry: string, m: Affine): string {
    const stops = this.lineStops(line, t0, t1)
    if (!stops) return ''
    const dict = (cs: string, pick: (s: Stop5) => number[]) =>
      `/ColorSpace /${cs} ${geometry} /Extend [true true] ${buildFunction(normalizeStops(stops), pick)}`
    const color = this.fill(dict('DeviceRGB', s => [s[1], s[2], s[3]]), null, m)
    if (stops.every(s => s[4] >= 1)) return color
    return this.masked(color, this.fill(dict('DeviceGray', s => [s[4]]), null, m))
  }

  // sh fills the clip; a pattern would do the same, but Quartz places a pattern in a form wrongly
  private fill(dict: string, data: Uint8Array | null, m: Affine): string {
    return `q ${composeAffine(this.place, m).map(num).join(' ')} cm /${this.env.res.shading(dict, data)} sh Q\n`
  }

  private masked(ops: string, alphaOps: string): string {
    return `q /${this.maskState(this.group(alphaOps, GRAY_GROUP), 'Luminosity')} gs\n${ops}Q\n`
  }

  // A sweep has no PDF shading of its own: a mesh of Coons patches, one wedge per few degrees and
  // at every stop, each running between the colors at its two edges.
  private sweep(line: ColorLine, center: Point, start: number, end: number, m: Affine): string {
    const box = this.box(m)
    const resolved = this.resolve(line)
    if (!box || !resolved) return ''
    const [cx, cy] = center
    const radius = Math.max(...corners(box).map(([x, y]) => Math.hypot(x - cx, y - cy))) * 1.02 + 1
    const span = end - start
    let colorAt: (deg: number) => RGBA | null
    const seams = new Set<number>([0, 360])
    for (let d = WEDGE_DEG; d < 360; d += WEDGE_DEG) seams.add(d)
    const first = resolved.pos[0]!, last = resolved.pos.at(-1)!
    // with coincident angles or stops there's nothing to repeat or reflect; only pad draws
    if ((Math.abs(span) < 1e-9 || last - first < 1e-9) && line.extend !== 0) return ''
    if (Math.abs(span) < 1e-9) {
      colorAt = deg => deg < start ? resolved.cols[0]! : resolved.cols.at(-1)!
      if (start > 0 && start < 360) seams.add(start)
    } else {
      colorAt = deg => sampleLine(resolved, line.extend, (deg - start) / span)
      const ta = -start / span, tb = (360 - start) / span
      for (const t of lineEvents(resolved, line.extend, Math.min(ta, tb), Math.max(ta, tb))) {
        const deg = start + t * span
        if (deg > 0 && deg < 360) seams.add(deg)
      }
    }
    const edges = [...seams].sort((a, b) => a - b)
    const wedges: { a: number; b: number; ca: RGBA; cb: RGBA }[] = []
    const eps = 1e-7
    for (let i = 0; i + 1 < edges.length; i++) {
      const a = edges[i]!, b = edges[i + 1]!
      if (b - a < 1e-9) continue
      const ca = colorAt(Math.min(b, a + eps)), cb = colorAt(Math.max(a, b - eps))
      if (ca && cb) wedges.push({ a, b, ca, cb })
    }
    if (!wedges.length) return ''
    const decode = `${num(cx - radius)} ${num(cx + radius)} ${num(cy - radius)} ${num(cy + radius)}`
    const mesh = (gray: boolean) => this.fill(
      `/ShadingType 6 /ColorSpace /${gray ? 'DeviceGray' : 'DeviceRGB'} /BitsPerCoordinate 16 /BitsPerComponent 16 /BitsPerFlag 8 /Decode [${decode} ${gray ? '0 1' : '0 1 0 1 0 1'}]`,
      coonsMesh(wedges, cx, cy, radius, gray), m)
    const color = mesh(false)
    if (wedges.every(w => w.ca[3] >= 1 && w.cb[3] >= 1)) return color
    // grouped: renderers paint a mesh as overlapping pieces, each through the mask, so their
    // alpha would pile up where they meet
    return this.masked(`/${this.group(color)} Do\n`, mesh(true))
  }

  private resolve(line: ColorLine): Resolved | null {
    if (!line.stops.length) return null
    return { pos: line.stops.map(s => s.offset), cols: line.stops.map(s => this.color(s.color)) }
  }

  // The color line over [t0, t1] as normalized stops: every stop and period edge in range, with
  // samples between them since PDF functions interpolate straight and COLR premultiplied
  private lineStops(line: ColorLine, t0: number, t1: number): Stop5[] | null {
    const r = this.resolve(line)
    if (!r || !(t1 > t0)) return null
    const first = r.pos[0]!, last = r.pos.at(-1)!
    if (line.extend !== 0 && last - first < 1e-9) return null
    const events = [t0, ...lineEvents(r, line.extend, t0, t1).filter(t => t > t0 && t < t1), t1]
    const out: Stop5[] = []
    const eps = (t1 - t0) * 1e-9
    const push = (t: number, c: RGBA | null) => { if (c) out.push([(t - t0) / (t1 - t0), c[0], c[1], c[2], c[3]]) }
    for (let i = 0; i < events.length; i++) {
      const t = events[i]!
      const left = i > 0 ? sampleLine(r, line.extend, t - eps) : null
      const right = i + 1 < events.length ? sampleLine(r, line.extend, t + eps) : null
      push(t, left ?? right)
      if (left && right && !same(left, right)) push(t, right)
      const next = events[i + 1]
      if (next === undefined || !right) continue
      const end = sampleLine(r, line.extend, next - eps)
      // equal alphas interpolate the same either way
      if (!end || Math.abs(end[3] - right[3]) < 1e-6) continue
      for (let k = 1; k < SAMPLES; k++) { const s = t + (next - t) * k / SAMPLES; push(s, sampleLine(r, line.extend, s)) }
    }
    return out
  }
}

interface Resolved { pos: number[]; cols: RGBA[] }

const SAMPLES = 8

// The color at t on the line, extended per its mode (0 pad, 1 repeat, 2 reflect)
function sampleLine(r: Resolved, extend: number, t: number): RGBA | null {
  const first = r.pos[0]!, last = r.pos.at(-1)!, len = last - first
  if (len < 1e-9) return t < first ? r.cols[0]! : r.cols.at(-1)!
  let u = Math.min(last, Math.max(first, t))
  if (extend !== 0) {
    const k = Math.floor((t - first) / len)
    let f = t - first - k * len
    if (extend === 2 && k % 2 !== 0) f = len - f
    u = first + f
  }
  let i = 0
  while (i + 2 < r.pos.length && u >= r.pos[i + 1]!) i++
  const p0 = r.pos[i]!, p1 = r.pos[i + 1]!
  if (u <= p0) return r.cols[i]!
  if (u >= p1) return r.cols[i + 1]!
  return mix(r.cols[i]!, r.cols[i + 1]!, (u - p0) / (p1 - p0))
}

// premultiplied in sRGB; a fully transparent end keeps the other end's color
function mix(a: RGBA, b: RGBA, f: number): RGBA {
  const alpha = a[3] + (b[3] - a[3]) * f
  if (alpha <= 0) return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, 0]
  const c = (k: number) => (a[k]! * a[3] + (b[k]! * b[3] - a[k]! * a[3]) * f) / alpha
  return [c(0), c(1), c(2), alpha]
}

// stop positions and period edges between t0 and t1, capped so a tiny period can't run away
function lineEvents(r: Resolved, extend: number, t0: number, t1: number): number[] {
  const first = r.pos[0]!, last = r.pos.at(-1)!, len = last - first
  if (extend === 0 || len < 1e-9) return r.pos.filter(p => p > t0 && p < t1)
  const out: number[] = []
  const k0 = Math.floor((t0 - first) / len), k1 = Math.min(Math.floor((t1 - first) / len), k0 + 2048)
  for (let k = k0; k <= k1; k++) {
    const startT = first + k * len
    out.push(startT)
    for (const p of r.pos) out.push(extend === 2 && k % 2 !== 0 ? startT + (last - p) : startT + (p - first))
  }
  return out.filter(t => t > t0 && t < t1).sort((a, b) => a - b)
}

// ShadingType 6 data: per wedge, a flag, twelve control points (center to the edge at a, the arc,
// back to the center, and the collapsed fourth side), then the four corner colors
function coonsMesh(wedges: { a: number; b: number; ca: RGBA; cb: RGBA }[], cx: number, cy: number, r: number, gray: boolean): Uint8Array {
  const comps = gray ? 1 : 3
  const out = new Uint8Array(wedges.length * (1 + 48 + 4 * comps * 2))
  const v = new DataView(out.buffer)
  let o = 0
  const point = (x: number, y: number) => {
    v.setUint16(o, Math.round(Math.min(1, Math.max(0, (x - cx + r) / (2 * r))) * 65535)); o += 2
    v.setUint16(o, Math.round(Math.min(1, Math.max(0, (y - cy + r) / (2 * r))) * 65535)); o += 2
  }
  const color = (c: RGBA) => {
    for (const x of gray ? [c[3]] : [c[0], c[1], c[2]]) { v.setUint16(o, Math.round(Math.min(1, Math.max(0, x)) * 65535)); o += 2 }
  }
  for (const w of wedges) {
    const a = w.a * Math.PI / 180, b = w.b * Math.PI / 180
    const k = 4 / 3 * Math.tan((b - a) / 4) * r
    const ax = cx + r * Math.cos(a), ay = cy + r * Math.sin(a), bx = cx + r * Math.cos(b), by = cy + r * Math.sin(b)
    out[o++] = 0
    point(cx, cy); point(cx + (ax - cx) / 3, cy + (ay - cy) / 3); point(cx + (ax - cx) * 2 / 3, cy + (ay - cy) * 2 / 3); point(ax, ay)
    point(ax - k * Math.sin(a), ay + k * Math.cos(a)); point(bx + k * Math.sin(b), by - k * Math.cos(b)); point(bx, by)
    point(cx + (bx - cx) * 2 / 3, cy + (by - cy) * 2 / 3); point(cx + (bx - cx) / 3, cy + (by - cy) / 3); point(cx, cy)
    point(cx, cy); point(cx, cy)
    color(w.ca); color(w.ca); color(w.cb); color(w.cb)
  }
  return out
}

function apply(m: Affine, [x, y]: Point): Point { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] }
function corners(b: Box): Point[] { return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]] }
function path(b: Box, m: Affine): string {
  const [p0, ...rest] = corners(b).map(c => apply(m, c))
  return `${coord(p0![0])} ${coord(p0![1])} m ${rest.map(([x, y]) => `${coord(x)} ${coord(y)} l`).join(' ')} h`
}
function bounds(b: Box, m: Affine): Box {
  const ps = corners(b).map(c => apply(m, c))
  return [Math.min(...ps.map(p => p[0])), Math.min(...ps.map(p => p[1])), Math.max(...ps.map(p => p[0])), Math.max(...ps.map(p => p[1]))]
}
function rgb(c: RGBA): string { return `${hpf(c[0])} ${hpf(c[1])} ${hpf(c[2])}` }
function same(a: RGBA, b: RGBA): boolean { return a.every((x, i) => Math.abs(x - b[i]!) < 1e-6) }
function latin1(b: Uint8Array): string { let s = ''; for (const x of b) s += String.fromCharCode(x); return s }

// six decimals for matrix entries, which hpf's three would round enough to bend a rotation; two for
// coordinates (in points or font units), finer than anything a page shows
export function num(n: number): string { return fixed(n, 6) }
export function coord(n: number): string { return fixed(n, 2) }
function fixed(n: number, digits: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(digits).replace(/\.?0+$/, '').replace(/^-0$/, '0')
}
