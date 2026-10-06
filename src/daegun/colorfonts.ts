// Color fonts as the PDF painter needs them: COLR paints resolved for an instance (the engine reads
// v0 layers only), plus the glyph count and axis coordinates that drawing from outlines takes.

import type { Affine } from '../types/affine.js'

export type Point = [number, number]
// index 0xFFFF is the text color
export interface ColorRef { index: number; alpha: number }
export interface ColorStop { offset: number; color: ColorRef }
export interface ColorLine { extend: number; stops: ColorStop[] }

export type Paint =
  | { kind: 'layers'; paints: Paint[] }
  | { kind: 'solid'; color: ColorRef }
  | { kind: 'linear'; line: ColorLine; p0: Point; p1: Point; p2: Point }
  | { kind: 'radial'; line: ColorLine; c0: Point; r0: number; c1: Point; r1: number }
  // angles in degrees, counter-clockwise from +x
  | { kind: 'sweep'; line: ColorLine; center: Point; start: number; end: number }
  | { kind: 'glyph'; gid: number; paint: Paint }
  | { kind: 'colrGlyph'; gid: number }
  | { kind: 'transform'; m: Affine; paint: Paint }
  | { kind: 'composite'; mode: number; source: Paint; backdrop: Paint }

export type Box = [number, number, number, number]
export interface ColrGlyph { paint: Paint; clip: Box | null }

export interface ColorFace {
  upem: number
  numGlyphs: number
  // palette 0, straight sRGB in 0..1
  palette: [number, number, number, number][]
  // normalized axis coordinates for a weight and optical size (0: the font's default)
  coords(weight: number, opsz: number): number[]
  // the glyph's paint: COLRv1's where it has one, else its COLR v0 layers as one; null if neither
  glyph(gid: number, weight: number, opsz: number): ColrGlyph | null
}

interface Axis { tag: string; min: number; def: number; max: number; avar: [number, number][] }

const NO_VAR = 0xFFFFFFFF
// the spec's suggested limit, which also stops a layer list that reaches itself
const MAX_DEPTH = 64
const MAX_NODES = 100_000

const faces = new Map<string, { weight: number; face: ColorFace }[]>()
// fonts drawing in color from bitmaps (sbix, CBDT), by name:style
const bitmapFonts = new Set<string>()

// Keyed as the engine keys a face: italic from OS/2 fsSelection bit 0 or head macStyle bit 1
// (oblique and italicAngle play no part), weight from usWeightClass.
export function noteColorFont(name: string, bytes: Uint8Array, ttcIndex = 0): void {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    const base = v.getUint32(0) === 0x74746366 ? v.getUint32(12 + 4 * ttcIndex) : 0
    const tables = new Map<string, DataView>()
    for (let i = 0, n = v.getUint16(base + 4); i < n; i++) {
      const rec = base + 12 + i * 16
      const tag = String.fromCharCode(...bytes.subarray(rec, rec + 4))
      tables.set(tag, new DataView(bytes.buffer, bytes.byteOffset + v.getUint32(rec + 8), v.getUint32(rec + 12)))
    }
    const head = tables.get('head'), os2 = tables.get('OS/2')
    const italic = !!(os2 && os2.getUint16(62) & 1) || !!(head && head.getUint16(44) & 2)
    const weight = os2 ? os2.getUint16(4) : 400
    const key = `${name.toLowerCase()}:${italic ? 'italic' : 'normal'}`
    if (tables.has('sbix') || tables.has('CBDT')) bitmapFonts.add(key); else bitmapFonts.delete(key)
    const list = (faces.get(key) ?? []).filter(f => f.weight !== weight)
    const colr = tables.get('COLR'), cpal = tables.get('CPAL'), maxp = tables.get('maxp')
    if (head && colr && cpal && maxp) {
      list.push({ weight, face: new Colr(copy(colr), head.getUint16(18), maxp.getUint16(4), readPalette(cpal),
        readAxes(tables.get('fvar'), tables.get('avar'))) })
    }
    if (list.length) faces.set(key, list); else faces.delete(key)
  } catch {
    // a font the engine took but this can't read keeps its plain outlines
  }
}

export function isColorFont(name: string, style: string): boolean {
  const key = `${name.toLowerCase()}:${style.toLowerCase()}`
  return faces.has(key) || bitmapFonts.has(key)
}

export function colorFace(name: string, style: string, weight: number): ColorFace | null {
  const list = faces.get(`${name.toLowerCase()}:${style.toLowerCase()}`)
  if (!list) return null
  let best = list[0]!
  for (const f of list) if (Math.abs(f.weight - weight) < Math.abs(best.weight - weight)) best = f
  return best.face
}

function copy(t: DataView): DataView {
  return new DataView(new Uint8Array(t.buffer, t.byteOffset, t.byteLength).slice().buffer)
}

function readPalette(t: DataView): [number, number, number, number][] {
  const count = t.getUint16(2), recs = t.getUint32(8), first = t.getUint16(12)
  return Array.from({ length: count }, (_, i) => {
    const o = recs + (first + i) * 4
    return [t.getUint8(o + 2) / 255, t.getUint8(o + 1) / 255, t.getUint8(o) / 255, t.getUint8(o + 3) / 255]
  })
}

function readAxes(fvar: DataView | undefined, avar: DataView | undefined): Axis[] {
  if (!fvar) return []
  const at = fvar.getUint16(4), count = fvar.getUint16(8), size = fvar.getUint16(10)
  const axes = Array.from({ length: count }, (_, i): Axis => {
    const o = at + i * size
    const tag = String.fromCharCode(fvar.getUint8(o), fvar.getUint8(o + 1), fvar.getUint8(o + 2), fvar.getUint8(o + 3))
    return { tag, min: fvar.getInt32(o + 4) / 65536, def: fvar.getInt32(o + 8) / 65536, max: fvar.getInt32(o + 12) / 65536, avar: [] }
  })
  if (avar && avar.getUint16(6) === count) {
    let o = 8
    for (const axis of axes) {
      const n = avar.getUint16(o); o += 2
      for (let k = 0; k < n; k++, o += 4) axis.avar.push([avar.getInt16(o) / 16384, avar.getInt16(o + 2) / 16384])
    }
  }
  return axes
}

function normalize(axes: Axis[], weight: number, opsz: number): number[] {
  return axes.map(a => {
    const user = a.tag === 'wght' ? weight : a.tag === 'opsz' && opsz > 0 ? opsz : a.def
    const v = Math.min(a.max, Math.max(a.min, user))
    let n = v < a.def ? (v - a.def) / (a.def - a.min || 1) : v > a.def ? (v - a.def) / (a.max - a.def || 1) : 0
    const map = a.avar
    for (let k = 1; k < map.length; k++) {
      const [f0, t0] = map[k - 1]!, [f1, t1] = map[k]!
      if (n <= f1) { n = f1 === f0 ? t1 : t0 + (n - f0) * (t1 - t0) / (f1 - f0); break }
    }
    return Math.round(n * 16384) / 16384
  })
}

class Colr implements ColorFace {
  private readonly base = new Map<number, number>()
  private readonly v0 = new Map<number, ColrGlyph>()
  private readonly cache = new Map<string, ColrGlyph | null>()

  constructor(private readonly d: DataView, readonly upem: number, readonly numGlyphs: number,
              readonly palette: [number, number, number, number][], private readonly axes: Axis[]) {
    const list = d.getUint16(0) >= 1 ? d.getUint32(14) : 0
    for (let i = 0, n = list ? d.getUint32(list) : 0; i < n; i++) {
      const rec = list + 4 + i * 6
      this.base.set(d.getUint16(rec), list + d.getUint32(rec + 2))
    }
    const records = d.getUint32(4), layers = d.getUint32(8), layerCount = d.getUint16(12)
    for (let i = 0, n = d.getUint16(2); i < n; i++) {
      const rec = records + i * 6, first = d.getUint16(rec + 2), count = d.getUint16(rec + 4)
      const paints: Paint[] = []
      for (let k = first; k < first + count && k < layerCount; k++) {
        const at = layers + k * 4
        paints.push({ kind: 'glyph', gid: d.getUint16(at), paint: { kind: 'solid', color: { index: d.getUint16(at + 2), alpha: 1 } } })
      }
      this.v0.set(d.getUint16(rec), { paint: { kind: 'layers', paints }, clip: null })
    }
  }

  coords(weight: number, opsz: number): number[] { return normalize(this.axes, weight, opsz) }

  glyph(gid: number, weight: number, opsz: number): ColrGlyph | null {
    const at = this.base.get(gid)
    if (at === undefined) return this.v0.get(gid) ?? null
    const coords = this.coords(weight, opsz)
    const key = `${gid}|${coords.join(',')}`
    let hit = this.cache.get(key)
    if (hit === undefined) {
      try {
        const r = new Reader(this.d, coords)
        hit = { paint: r.paint(at, 0), clip: r.clip(gid) }
      } catch {
        hit = null
      }
      this.cache.set(key, hit)
    }
    return hit
  }
}

// One glyph's read: paints are shared by offset, so a graph reusing a subtree stays small
class Reader {
  private readonly memo = new Map<number, Paint>()
  private nodes = 0
  private readonly store: VarStore | null

  constructor(private readonly d: DataView, coords: number[]) {
    const at = d.getUint32(30)
    this.store = at && coords.some(c => c !== 0) ? new VarStore(d, at, coords) : null
  }

  private u24(o: number): number { return this.d.getUint16(o) << 8 | this.d.getUint8(o + 2) }
  private f2(o: number, base: number, k: number): number { return (this.d.getInt16(o) + this.delta(base, k)) / 16384 }
  private fw(o: number, base: number, k: number): number { return this.d.getInt16(o) + this.delta(base, k) }
  private ufw(o: number, base: number, k: number): number { return this.d.getUint16(o) + this.delta(base, k) }
  private child(o: number, depth: number): Paint { return this.paint(o + this.u24(o + 1), depth + 1) }

  paint(o: number, depth: number): Paint {
    const memo = this.memo.get(o)
    if (memo) return memo
    if (depth > MAX_DEPTH || ++this.nodes > MAX_NODES) throw new Error('COLR graph too deep or too large')
    const p = this.read(o, depth)
    this.memo.set(o, p)
    return p
  }

  private read(o: number, depth: number): Paint {
    const d = this.d, format = d.getUint8(o)
    const isVar = format % 2 === 1 && format > 2 && format < 32
    // where a variable paint keeps its VarIndexBase, by format
    const baseAt = (off: number) => isVar ? d.getUint32(o + off) : NO_VAR
    const sub = () => this.child(o, depth)
    const transformed = (m: Affine): Paint => ({ kind: 'transform', m, paint: sub() })
    const around = (m: Affine, cx: number, cy: number): Affine =>
      [m[0], m[1], m[2], m[3], cx - m[0] * cx - m[2] * cy, cy - m[1] * cx - m[3] * cy]
    switch (format) {
      case 1: {
        const n = d.getUint8(o + 1), first = d.getUint32(o + 2), list = d.getUint32(18)
        const paints: Paint[] = []
        for (let i = first; i < first + n; i++) paints.push(this.paint(list + d.getUint32(list + 4 + i * 4), depth + 1))
        return { kind: 'layers', paints }
      }
      case 2: case 3:
        return { kind: 'solid', color: { index: d.getUint16(o + 1), alpha: this.f2(o + 3, baseAt(5), 0) } }
      case 4: case 5: {
        const b = baseAt(16)
        return {
          kind: 'linear', line: this.line(o + this.u24(o + 1), format === 5),
          p0: [this.fw(o + 4, b, 0), this.fw(o + 6, b, 1)], p1: [this.fw(o + 8, b, 2), this.fw(o + 10, b, 3)],
          p2: [this.fw(o + 12, b, 4), this.fw(o + 14, b, 5)],
        }
      }
      case 6: case 7: {
        const b = baseAt(16)
        return {
          kind: 'radial', line: this.line(o + this.u24(o + 1), format === 7),
          c0: [this.fw(o + 4, b, 0), this.fw(o + 6, b, 1)], r0: this.ufw(o + 8, b, 2),
          c1: [this.fw(o + 10, b, 3), this.fw(o + 12, b, 4)], r1: this.ufw(o + 14, b, 5),
        }
      }
      case 8: case 9: {
        const b = baseAt(12)
        // stored with a bias of 1.0 so that +360° fits the F2Dot14 range
        return {
          kind: 'sweep', line: this.line(o + this.u24(o + 1), format === 9),
          center: [this.fw(o + 4, b, 0), this.fw(o + 6, b, 1)],
          start: (this.f2(o + 8, b, 2) + 1) * 180, end: (this.f2(o + 10, b, 3) + 1) * 180,
        }
      }
      case 10:
        return { kind: 'glyph', gid: d.getUint16(o + 4), paint: sub() }
      case 11:
        return { kind: 'colrGlyph', gid: d.getUint16(o + 1) }
      case 12: case 13: {
        const t = o + this.u24(o + 4), b = format === 13 ? d.getUint32(t + 24) : NO_VAR
        const m = Array.from({ length: 6 }, (_, k) => (d.getInt32(t + k * 4) + this.delta(b, k)) / 65536) as Affine
        return transformed(m)
      }
      case 14: case 15: {
        const b = baseAt(8)
        return transformed([1, 0, 0, 1, this.fw(o + 4, b, 0), this.fw(o + 6, b, 1)])
      }
      case 16: case 17: {
        const b = baseAt(8)
        return transformed([this.f2(o + 4, b, 0), 0, 0, this.f2(o + 6, b, 1), 0, 0])
      }
      case 18: case 19: {
        const b = baseAt(12)
        return transformed(around([this.f2(o + 4, b, 0), 0, 0, this.f2(o + 6, b, 1), 0, 0], this.fw(o + 8, b, 2), this.fw(o + 10, b, 3)))
      }
      case 20: case 21: {
        const s = this.f2(o + 4, baseAt(6), 0)
        return transformed([s, 0, 0, s, 0, 0])
      }
      case 22: case 23: {
        const b = baseAt(10), s = this.f2(o + 4, b, 0)
        return transformed(around([s, 0, 0, s, 0, 0], this.fw(o + 6, b, 1), this.fw(o + 8, b, 2)))
      }
      case 24: case 25:
        return transformed(rotation(this.f2(o + 4, baseAt(6), 0) * 180))
      case 26: case 27: {
        const b = baseAt(10)
        return transformed(around(rotation(this.f2(o + 4, b, 0) * 180), this.fw(o + 6, b, 1), this.fw(o + 8, b, 2)))
      }
      case 28: case 29: {
        const b = baseAt(8)
        return transformed(skew(this.f2(o + 4, b, 0) * 180, this.f2(o + 6, b, 1) * 180))
      }
      case 30: case 31: {
        const b = baseAt(12)
        return transformed(around(skew(this.f2(o + 4, b, 0) * 180, this.f2(o + 6, b, 1) * 180), this.fw(o + 8, b, 2), this.fw(o + 10, b, 3)))
      }
      case 32:
        return {
          kind: 'composite', mode: d.getUint8(o + 4),
          source: this.paint(o + this.u24(o + 1), depth + 1), backdrop: this.paint(o + this.u24(o + 5), depth + 1),
        }
      default:
        throw new Error(`unknown paint format ${format}`)
    }
  }

  private line(o: number, isVar: boolean): ColorLine {
    const d = this.d, n = d.getUint16(o + 1), size = isVar ? 10 : 6
    const stops = Array.from({ length: n }, (_, i): ColorStop => {
      const s = o + 3 + i * size, b = isVar ? d.getUint32(s + 6) : NO_VAR
      return { offset: this.f2(s, b, 0), color: { index: d.getUint16(s + 2), alpha: this.f2(s + 4, b, 1) } }
    })
    // sorted by offset, keeping the font's order among equal offsets (a hard stop)
    return { extend: d.getUint8(o), stops: stops.map((s, i) => [s, i] as const).sort((a, b) => a[0].offset - b[0].offset || a[1] - b[1]).map(([s]) => s) }
  }

  clip(gid: number): Box | null {
    const d = this.d, list = d.getUint32(22)
    if (!list) return null
    for (let i = 0, n = d.getUint32(list + 1); i < n; i++) {
      const rec = list + 5 + i * 7
      if (gid < d.getUint16(rec) || gid > d.getUint16(rec + 2)) continue
      const o = list + this.u24(rec + 4), b = d.getUint8(o) === 2 ? d.getUint32(o + 9) : NO_VAR
      return [this.fw(o + 1, b, 0), this.fw(o + 3, b, 1), this.fw(o + 5, b, 2), this.fw(o + 7, b, 3)]
    }
    return null
  }

  // the ItemVariationStore delta for VarIndexBase + k, in the field's own units
  private delta(base: number, k: number): number {
    if (base === NO_VAR || !this.store) return 0
    const d = this.d, map = d.getUint32(26)
    let idx = base + k
    if (map) {
      const format = d.getUint8(map), entry = d.getUint8(map + 1)
      const count = format === 0 ? d.getUint16(map + 2) : d.getUint32(map + 2)
      const size = (entry >> 4 & 3) + 1, innerBits = (entry & 15) + 1
      const at = map + (format === 0 ? 4 : 6) + Math.min(idx, count - 1) * size
      let v = 0
      for (let b = 0; b < size; b++) v = v * 256 + d.getUint8(at + b)
      idx = Math.floor(v / 2 ** innerBits) * 65536 + v % 2 ** innerBits
    }
    return this.store.delta(Math.floor(idx / 65536), idx % 65536)
  }
}

// An ItemVariationStore (COLR's, or CFF2's) at one normalized instance
export class VarStore {
  private cached: Float64Array | null = null

  constructor(private readonly d: DataView, private readonly at: number, private readonly coords: number[]) {}

  // per region, how much of it the instance takes
  scalars(): Float64Array {
    if (this.cached) return this.cached
    const d = this.d, list = this.at + d.getUint32(this.at + 2)
    const axisCount = d.getUint16(list), regionCount = d.getUint16(list + 2)
    const out = new Float64Array(regionCount)
    for (let r = 0; r < regionCount; r++) {
      let scalar = 1
      for (let a = 0; a < axisCount; a++) {
        const o = list + 4 + (r * axisCount + a) * 6
        const start = d.getInt16(o) / 16384, peak = d.getInt16(o + 2) / 16384, end = d.getInt16(o + 4) / 16384
        const c = this.coords[a] ?? 0
        if (peak === 0 || start > peak || peak > end || (start < 0 && end > 0) || c === peak) continue
        if (c <= start || c >= end) { scalar = 0; break }
        scalar *= c < peak ? (c - start) / (peak - start) : (end - c) / (end - peak)
      }
      out[r] = scalar
    }
    return this.cached = out
  }

  private data(outer: number): number | null {
    return outer < this.d.getUint16(this.at + 6) ? this.at + this.d.getUint32(this.at + 8 + outer * 4) : null
  }

  // the region indexes one ItemVariationData subtable's deltas run over
  regions(outer: number): number[] {
    const data = this.data(outer)
    if (data === null) return []
    return Array.from({ length: this.d.getUint16(data + 4) }, (_, r) => this.d.getUint16(data + 6 + r * 2))
  }

  delta(outer: number, inner: number): number {
    const d = this.d, data = this.data(outer)
    if (data === null) return 0
    const items = d.getUint16(data), wordField = d.getUint16(data + 2), regionCount = d.getUint16(data + 4)
    if (inner >= items) return 0
    const long = (wordField & 0x8000) !== 0, words = wordField & 0x7FFF
    const wide = long ? 4 : 2, narrow = long ? 2 : 1
    const rowSize = words * wide + (regionCount - words) * narrow
    const scalars = this.scalars()
    let at = data + 6 + regionCount * 2 + inner * rowSize, sum = 0
    for (let r = 0; r < regionCount; r++) {
      const delta = r < words ? (long ? d.getInt32(at) : d.getInt16(at)) : (long ? d.getInt16(at) : d.getInt8(at))
      at += r < words ? wide : narrow
      sum += delta * (scalars[d.getUint16(data + 6 + r * 2)] ?? 0)
    }
    return sum
  }
}

function rotation(deg: number): Affine {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r)
  return [c, s, -s, c, 0, 0]
}

// a positive x skew leans the y axis counter-clockwise, toward -x
function skew(xDeg: number, yDeg: number): Affine {
  return [1, Math.tan(yDeg * Math.PI / 180), Math.tan(-xDeg * Math.PI / 180), 1, 0, 0]
}
