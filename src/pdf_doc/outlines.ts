import { subset_font_full } from '../daegun/wasm/daegun.js'
import { VarStore, type ColorFace } from '../daegun/colorfonts.js'
import type { Affine } from '../types/affine.js'
import type { DocFont } from './types.js'
import { coord } from './colr.js'

// A contour as a start point and its segments: [x, y] a line, [x1, y1, x2, y2, x, y] a cubic
export interface Contour { start: [number, number]; segs: number[][] }
export type Outline = Contour[]

interface Point { x: number; y: number; on: boolean }

// Glyph outlines in font units (y up), from the engine's copy of the font at its weight and optical
// size. Color glyphs draw from these as paths: drawn as text, their parts would copy too.
export class Outlines {
  private readonly cache = new Map<number, Outline | null>()

  private constructor(private readonly read: (gid: number) => Outline | null) {}

  static load(font: DocFont, face: Pick<ColorFace, 'numGlyphs' | 'upem' | 'coords'>): Outlines | null {
    const all = Uint16Array.from({ length: face.numGlyphs }, (_, i) => i)
    try {
      const sub = subset_font_full(font.fontName, font.style, font.weight, font.opsz, all)
      if (!sub) return null
      const tables = sfntTables(sub.fontBytes)
      const glyf = tables.get('glyf'), loca = tables.get('loca'), head = tables.get('head')
      if (glyf && loca && head) {
        const map = sub.glyphMap
        const reader = new GlyfReader(glyf, loca, head.getInt16(50) === 1)
        // a glyph the copy lacks has no outline, rather than .notdef's
        return new Outlines(gid => {
          const g = map.length ? map[gid] ?? 0 : gid
          return g || !gid ? reader.outline(g) : null
        })
      }
      const cff2 = tables.get('CFF2')
      const cff = cff2 ?? tables.get('CFF ') ?? (tables.size ? undefined : view(sub.fontBytes))
      if (!cff) return null
      return new Outlines(cffOutlines(cff, !!cff2, face.coords(font.weight, font.opsz), face.upem))
    } catch {
      return null
    }
  }

  get(gid: number): Outline | null {
    let hit = this.cache.get(gid)
    if (hit === undefined) {
      try { hit = this.read(gid) } catch { hit = null }
      this.cache.set(gid, hit)
    }
    return hit
  }
}

// PDF path construction ops for an outline put through m
export function outlinePath(o: Outline, m: Affine): string {
  const pt = (x: number, y: number) => `${coord(m[0] * x + m[2] * y + m[4])} ${coord(m[1] * x + m[3] * y + m[5])}`
  return o.map(c => [`${pt(...c.start)} m`, ...c.segs.map(s => s.length === 2
    ? `${pt(s[0]!, s[1]!)} l`
    : `${pt(s[0]!, s[1]!)} ${pt(s[2]!, s[3]!)} ${pt(s[4]!, s[5]!)} c`), 'h'].join(' ')).join(' ')
}

function view(b: Uint8Array): DataView { return new DataView(b.buffer, b.byteOffset, b.byteLength) }

function sfntTables(bytes: Uint8Array): Map<string, DataView> {
  const v = view(bytes), out = new Map<string, DataView>()
  const sig = v.getUint32(0)
  if (sig !== 0x00010000 && sig !== 0x4F54544F && sig !== 0x74727565) return out
  for (let i = 0, n = v.getUint16(4); i < n; i++) {
    const rec = 12 + i * 16
    out.set(String.fromCharCode(...bytes.subarray(rec, rec + 4)),
      new DataView(bytes.buffer, bytes.byteOffset + v.getUint32(rec + 8), v.getUint32(rec + 12)))
  }
  return out
}

class GlyfReader {
  constructor(private readonly glyf: DataView, private readonly loca: DataView, private readonly long: boolean) {}

  outline(gid: number): Outline | null {
    const contours = this.points(gid, 0)
    return contours && contours.map(toCubics)
  }

  private range(gid: number): [number, number] {
    return this.long
      ? [this.loca.getUint32(gid * 4), this.loca.getUint32(gid * 4 + 4)]
      : [this.loca.getUint16(gid * 2) * 2, this.loca.getUint16(gid * 2 + 2) * 2]
  }

  // the glyph's contours as TrueType points, components resolved
  private points(gid: number, depth: number): Point[][] | null {
    if (depth > 8) return null
    const [start, end] = this.range(gid)
    if (end <= start) return []
    const g = new DataView(this.glyf.buffer, this.glyf.byteOffset + start, end - start)
    const n = g.getInt16(0)
    return n >= 0 ? simple(g, n) : this.composite(g, depth)
  }

  private composite(g: DataView, depth: number): Point[][] | null {
    const out: Point[][] = []
    let o = 10, flags: number
    do {
      flags = g.getUint16(o)
      const child = this.points(g.getUint16(o + 2), depth + 1)
      o += 4
      const words = flags & 0x0001, xy = flags & 0x0002
      const arg = (k: number) => words
        ? (xy ? g.getInt16(o + k * 2) : g.getUint16(o + k * 2))
        : (xy ? g.getInt8(o + k) : g.getUint8(o + k))
      const a1 = arg(0), a2 = arg(1)
      o += words ? 4 : 2
      let a = 1, b = 0, c = 0, d = 1
      const f2 = () => { const v = g.getInt16(o) / 16384; o += 2; return v }
      if (flags & 0x0008) { a = d = f2() }
      else if (flags & 0x0040) { a = f2(); d = f2() }
      else if (flags & 0x0080) { a = f2(); b = f2(); c = f2(); d = f2() }
      if (!child) return null
      const moved = child.map(cont => cont.map(p => ({ x: a * p.x + c * p.y, y: b * p.x + d * p.y, on: p.on })))
      let dx = 0, dy = 0
      if (xy) {
        dx = a1; dy = a2
        // offsets are unscaled unless the font says otherwise
        if (flags & 0x0800 && !(flags & 0x1000)) { dx = a * a1 + c * a2; dy = b * a1 + d * a2 }
      } else {
        // point matching: the child's point a2 lands on the parent's point a1
        const parent = out.flat(), own = moved.flat()
        const p = parent[a1], q = own[a2]
        if (p && q) { dx = p.x - q.x; dy = p.y - q.y }
      }
      for (const cont of moved) out.push(cont.map(p => ({ x: p.x + dx, y: p.y + dy, on: p.on })))
    } while (flags & 0x0020)
    return out
  }
}

function simple(g: DataView, n: number): Point[][] {
  const ends = Array.from({ length: n }, (_, i) => g.getUint16(10 + i * 2))
  const count = n ? ends[n - 1]! + 1 : 0
  let o = 10 + n * 2
  o += 2 + g.getUint16(o)
  const flags: number[] = []
  while (flags.length < count) {
    const f = g.getUint8(o++)
    flags.push(f)
    if (f & 8) for (let r = g.getUint8(o++); r > 0; r--) flags.push(f)
  }
  const coords = (short: number, same: number): number[] => {
    let v = 0
    return flags.slice(0, count).map(f => {
      if (f & short) { const d = g.getUint8(o++); v += f & same ? d : -d }
      else if (!(f & same)) { v += g.getInt16(o); o += 2 }
      return v
    })
  }
  const xs = coords(2, 16), ys = coords(4, 32)
  const out: Point[][] = []
  let first = 0
  for (const last of ends) {
    out.push(Array.from({ length: last - first + 1 }, (_, k) => ({ x: xs[first + k]!, y: ys[first + k]!, on: (flags[first + k]! & 1) !== 0 })))
    first = last + 1
  }
  return out
}

// TrueType quadratics as cubics, with the on-curve points two off-curve ones imply
function toCubics(pts: Point[]): Contour {
  const mid = (p: Point, q: Point): Point => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, on: true })
  const s = pts.findIndex(p => p.on)
  const start = s < 0 ? mid(pts.at(-1)!, pts[0]!) : pts[s]!
  const order = s < 0 ? pts : [...pts.slice(s + 1), ...pts.slice(0, s + 1)]
  const segs: number[][] = []
  let cur = start, ctrl: Point | null = null
  const quad = (c: Point, e: Point) => {
    segs.push([cur.x + 2 / 3 * (c.x - cur.x), cur.y + 2 / 3 * (c.y - cur.y), e.x + 2 / 3 * (c.x - e.x), e.y + 2 / 3 * (c.y - e.y), e.x, e.y])
    cur = e
  }
  for (const p of order) {
    if (p.on) { if (ctrl) quad(ctrl, p); else { segs.push([p.x, p.y]); cur = p } ctrl = null }
    else { if (ctrl) quad(ctrl, mid(ctrl, p)); ctrl = p }
  }
  if (ctrl) quad(ctrl, start)
  // a closing line back to the start is what h draws anyway
  const last = segs.at(-1)
  if (last?.length === 2 && last[0] === start.x && last[1] === start.y) segs.pop()
  return { start: [start.x, start.y], segs }
}

// A CFF or CFF2 table's outlines by glyph index, CFF2's blend applied at the instance
export function cffOutlines(table: DataView, cff2: boolean, coords: number[], upem: number): (gid: number) => Outline | null {
  const reader = new CffReader(table, cff2, coords, upem)
  return gid => reader.outline(gid)
}

class CffReader {
  private readonly charStrings: DataView[]
  private readonly global: DataView[]
  private readonly privates: { subrs: DataView[]; vsindex: number }[]
  private readonly fdSelect: ((gid: number) => number) | null
  private readonly store: VarStore | null
  private readonly scale: Affine

  constructor(d: DataView, private readonly cff2: boolean, coords: number[], upem: number) {
    let top: Map<number, number[]>, o: number
    if (cff2) {
      const hdr = d.getUint8(2), len = d.getUint16(3)
      top = dict(d, hdr, hdr + len)
      o = hdr + len
    } else {
      o = d.getUint8(2)
      o = index(d, o, false).end
      const tops = index(d, o, false)
      top = dict(d, tops.items[0]!.byteOffset - d.byteOffset, tops.items[0]!.byteOffset - d.byteOffset + tops.items[0]!.byteLength)
      o = index(d, tops.end, false).end
    }
    this.global = index(d, o, cff2).items
    this.charStrings = index(d, top.get(17)![0]!, cff2).items
    const vstore = top.get(24)?.[0]
    // kept at the default instance too: a blend needs its region count to drop its deltas
    this.store = vstore !== undefined ? new VarStore(d, vstore + 2, coords) : null
    const priv = (size: number, at: number) => {
      const p = dict(d, at, at + size)
      const subrs = p.get(19)?.[0]
      return { subrs: subrs ? index(d, at + subrs, cff2).items : [], vsindex: p.get(22)?.[0] ?? 0 }
    }
    const fdArray = top.get(1236)?.[0]
    if (fdArray !== undefined) {
      this.privates = index(d, fdArray, cff2).items.map(fd => {
        const pd = dict(d, fd.byteOffset - d.byteOffset, fd.byteOffset - d.byteOffset + fd.byteLength).get(18)!
        return priv(pd[0]!, pd[1]!)
      })
      const sel = top.get(1237)?.[0]
      this.fdSelect = sel === undefined ? () => 0 : fdSelector(d, sel)
    } else {
      const pd = top.get(18)
      this.privates = [pd ? priv(pd[0]!, pd[1]!) : { subrs: [], vsindex: 0 }]
      this.fdSelect = null
    }
    const fm = top.get(1207)
    this.scale = fm && fm.length === 6 ? fm.map(v => v * upem) as Affine : [1, 0, 0, 1, 0, 0]
  }

  outline(gid: number): Outline | null {
    const cs = this.charStrings[gid]
    if (!cs) return null
    const priv = this.privates[this.fdSelect ? this.fdSelect(gid) : 0] ?? this.privates[0]!
    const out = run(cs, this.global, priv.subrs, this.cff2, this.store, priv.vsindex)
    const [a, b, c, d, e, f] = this.scale
    if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return out
    const t = (x: number, y: number): [number, number] => [a * x + c * y + e, b * x + d * y + f]
    return out.map(cont => ({
      start: t(...cont.start),
      segs: cont.segs.map(s => s.flatMap((_, k) => k % 2 ? [] : t(s[k]!, s[k + 1]!))),
    }))
  }
}

// A CFF INDEX at o (32-bit count in CFF2): its items, and where it ends
function index(d: DataView, o: number, cff2: boolean): { items: DataView[]; end: number } {
  const count = cff2 ? d.getUint32(o) : d.getUint16(o)
  const head = cff2 ? 4 : 2
  if (count === 0) return { items: [], end: o + head }
  const size = d.getUint8(o + head)
  const off = (i: number) => { let v = 0; for (let k = 0; k < size; k++) v = v * 256 + d.getUint8(o + head + 1 + i * size + k); return v }
  const base = o + head + (count + 1) * size
  const items = Array.from({ length: count }, (_, i) => new DataView(d.buffer, d.byteOffset + base + off(i), off(i + 1) - off(i)))
  return { items, end: base + off(count) }
}

// A DICT's operators and operands; two-byte operators are keyed 1200 + their second byte
function dict(d: DataView, start: number, end: number): Map<number, number[]> {
  const out = new Map<number, number[]>()
  let ops: number[] = []
  for (let o = start; o < end;) {
    const b = d.getUint8(o)
    // 22–24 are CFF2's vsindex, blend and vstore (reserved in CFF)
    if (b <= 27) {
      const key = b === 12 ? 1200 + d.getUint8(o + 1) : b
      o += b === 12 ? 2 : 1
      out.set(key, ops); ops = []
    } else if (b === 28) { ops.push(d.getInt16(o + 1)); o += 3 }
    else if (b === 29) { ops.push(d.getInt32(o + 1)); o += 5 }
    else if (b === 30) {
      let s = ''
      for (o++; ; o++) {
        const byte = d.getUint8(o), nibs = [byte >> 4, byte & 15]
        if (nibs.some(n => n === 15)) { for (const n of nibs) { if (n === 15) break; s += nibble(n) } o++; break }
        for (const n of nibs) s += nibble(n)
      }
      ops.push(parseFloat(s))
    } else if (b >= 32 && b <= 246) { ops.push(b - 139); o++ }
    else if (b >= 247 && b <= 250) { ops.push((b - 247) * 256 + d.getUint8(o + 1) + 108); o += 2 }
    else if (b >= 251 && b <= 254) { ops.push(-(b - 251) * 256 - d.getUint8(o + 1) - 108); o += 2 }
    else o++
  }
  return out
}

function nibble(n: number): string { return n < 10 ? String(n) : ['.', 'E', 'E-', '', '-'][n - 10]! }

function fdSelector(d: DataView, at: number): (gid: number) => number {
  const format = d.getUint8(at)
  if (format === 0) return gid => d.getUint8(at + 1 + gid)
  const wide = format === 4, count = wide ? d.getUint32(at + 1) : d.getUint16(at + 1)
  const rec = wide ? 6 : 3, base = at + (wide ? 5 : 3)
  return gid => {
    for (let i = count - 1; i >= 0; i--) {
      const first = wide ? d.getUint32(base + i * rec) : d.getUint16(base + i * rec)
      if (gid >= first) return wide ? d.getUint16(base + i * rec + 4) : d.getUint8(base + i * rec + 2)
    }
    return 0
  }
}

function bias(n: number): number { return n < 1240 ? 107 : n < 33900 ? 1131 : 32768 }

// A Type 2 charstring to contours. A CFF (not CFF2) charstring may open with the advance width, which
// shows as one operand more than the first stack-clearing operator takes.
function run(cs: DataView, global: DataView[], local: DataView[], cff2: boolean, store: VarStore | null, vsStart: number): Outline {
  const out: Outline = []
  let stack: number[] = []
  let x = 0, y = 0, stems = 0, widthSeen = cff2, vsindex = vsStart, done = false
  let cur: Contour | null = null
  const transient: number[] = []
  const width = (expected: (n: number) => boolean) => {
    if (!widthSeen && !expected(stack.length)) stack.shift()
    widthSeen = true
  }
  const moveTo = (dx: number, dy: number) => { x += dx; y += dy; cur = { start: [x, y], segs: [] }; out.push(cur) }
  const lineTo = (dx: number, dy: number) => { x += dx; y += dy; cur?.segs.push([x, y]) }
  const curveTo = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    const x1 = x + a, y1 = y + b, x2 = x1 + c, y2 = y1 + d
    x = x2 + e; y = y2 + f
    cur?.segs.push([x1, y1, x2, y2, x, y])
  }
  const interpret = (code: DataView, depth: number) => {
    if (depth > 10) return
    for (let o = 0; o < code.byteLength && !done;) {
      const b = code.getUint8(o)
      if (b === 28) { stack.push(code.getInt16(o + 1)); o += 3; continue }
      if (b >= 32 && b <= 246) { stack.push(b - 139); o++; continue }
      if (b >= 247 && b <= 250) { stack.push((b - 247) * 256 + code.getUint8(o + 1) + 108); o += 2; continue }
      if (b >= 251 && b <= 254) { stack.push(-(b - 251) * 256 - code.getUint8(o + 1) - 108); o += 2; continue }
      if (b === 255) { stack.push(code.getInt32(o + 1) / 65536); o += 5; continue }
      o++
      const s = stack
      switch (b) {
        case 1: case 3: case 18: case 23:
          width(n => n % 2 === 0); stems += s.length >> 1; stack = []; break
        case 19: case 20:
          width(n => n % 2 === 0); stems += s.length >> 1; stack = []
          o += (stems + 7) >> 3; break
        case 21: width(n => n === 2); moveTo(s[0]!, s[1]!); stack = []; break
        case 22: width(n => n === 1); moveTo(s[0]!, 0); stack = []; break
        case 4: width(n => n === 1); moveTo(0, s[0]!); stack = []; break
        case 5: for (let i = 0; i + 1 < s.length; i += 2) lineTo(s[i]!, s[i + 1]!); stack = []; break
        case 6: case 7: {
          let horizontal = b === 6
          for (const v of s) {
            if (horizontal) lineTo(v, 0); else lineTo(0, v)
            horizontal = !horizontal
          }
          stack = []; break
        }
        case 8: for (let i = 0; i + 5 < s.length; i += 6) curveTo(s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!, s[i + 4]!, s[i + 5]!); stack = []; break
        case 24: {
          let i = 0
          for (; i + 6 < s.length - 1; i += 6) curveTo(s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!, s[i + 4]!, s[i + 5]!)
          lineTo(s[i]!, s[i + 1]!); stack = []; break
        }
        case 25: {
          let i = 0
          for (; i + 1 < s.length - 6; i += 2) lineTo(s[i]!, s[i + 1]!)
          curveTo(s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!, s[i + 4]!, s[i + 5]!); stack = []; break
        }
        case 26: {
          let i = 0, dx1 = 0
          if (s.length % 2) { dx1 = s[0]!; i = 1 }
          for (; i + 3 < s.length; i += 4) { curveTo(dx1, s[i]!, s[i + 1]!, s[i + 2]!, 0, s[i + 3]!); dx1 = 0 }
          stack = []; break
        }
        case 27: {
          let i = 0, dy1 = 0
          if (s.length % 2) { dy1 = s[0]!; i = 1 }
          for (; i + 3 < s.length; i += 4) { curveTo(s[i]!, dy1, s[i + 1]!, s[i + 2]!, s[i + 3]!, 0); dy1 = 0 }
          stack = []; break
        }
        case 30: case 31: {
          let vertical = b === 30
          for (let i = 0; i + 3 < s.length; i += 4) {
            const last = i + 5 === s.length ? s[i + 4]! : 0
            if (vertical) curveTo(0, s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!, last)
            else curveTo(s[i]!, 0, s[i + 1]!, s[i + 2]!, last, s[i + 3]!)
            vertical = !vertical
          }
          stack = []; break
        }
        case 10: case 29: {
          const subrs = b === 10 ? local : global
          const sub = subrs[stack.pop()! + bias(subrs.length)]
          if (sub) interpret(sub, depth + 1)
          break
        }
        case 11: return
        case 14: if (!cff2) { width(n => n === 0 || n === 4); done = true } stack = []; return
        case 15: vsindex = stack.pop() ?? 0; break
        case 16: {
          const n = stack.pop() ?? 0
          const regions = store?.regions(vsindex) ?? []
          const k = store ? regions.length : (stack.length - n) / Math.max(1, n)
          const scalars = store?.scalars()
          const base = stack.length - n * (k + 1)
          const result = stack.slice(base, base + n).map((v, i) => {
            let sum = v
            if (scalars) for (let r = 0; r < k; r++) sum += stack[base + n + i * k + r]! * (scalars[regions[r]!] ?? 0)
            return sum
          })
          stack.splice(base, stack.length - base, ...result)
          break
        }
        case 12: escape(code.getUint8(o++)); break
        default: stack = []
      }
    }
  }
  const escape = (op: number) => {
    const s = stack
    const pop = () => stack.pop() ?? 0
    switch (op) {
      case 35: curveTo(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!); curveTo(s[6]!, s[7]!, s[8]!, s[9]!, s[10]!, s[11]!); stack = []; break
      // the flex variants end level with where they began, on the axis they leave implicit
      case 34:
        curveTo(s[0]!, 0, s[1]!, s[2]!, s[3]!, 0); curveTo(s[4]!, 0, s[5]!, -s[2]!, s[6]!, 0)
        stack = []; break
      case 36:
        curveTo(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, 0); curveTo(s[5]!, 0, s[6]!, s[7]!, s[8]!, -(s[1]! + s[3]! + s[7]!))
        stack = []; break
      case 37: {
        let dx = 0, dy = 0
        for (let i = 0; i < 10; i += 2) { dx += s[i]!; dy += s[i + 1]! }
        const horizontal = Math.abs(dx) > Math.abs(dy)
        curveTo(s[0]!, s[1]!, s[2]!, s[3]!, s[4]!, s[5]!)
        curveTo(s[6]!, s[7]!, s[8]!, s[9]!, horizontal ? s[10]! : -dx, horizontal ? -dy : s[10]!)
        stack = []; break
      }
      case 3: { const b = pop(), a = pop(); stack.push(a && b ? 1 : 0); break }
      case 4: { const b = pop(), a = pop(); stack.push(a || b ? 1 : 0); break }
      case 5: stack.push(pop() ? 0 : 1); break
      case 9: stack.push(Math.abs(pop())); break
      case 10: stack.push(pop() + pop()); break
      case 11: { const b = pop(), a = pop(); stack.push(a - b); break }
      case 12: { const b = pop(), a = pop(); stack.push(b ? a / b : 0); break }
      case 14: stack.push(-pop()); break
      case 15: stack.push(pop() === pop() ? 1 : 0); break
      case 18: pop(); break
      case 20: { const i = pop(); transient[i] = pop(); break }
      case 21: stack.push(transient[pop()] ?? 0); break
      case 22: { const v2 = pop(), v1 = pop(), s2 = pop(), s1 = pop(); stack.push(v1 <= v2 ? s1 : s2); break }
      // random has no reproducible value; the midpoint of its range keeps output deterministic
      case 23: stack.push(0.5); break
      case 24: stack.push(pop() * pop()); break
      case 26: stack.push(Math.sqrt(Math.max(0, pop()))); break
      case 27: { const v = pop(); stack.push(v, v); break }
      case 28: { const b = pop(), a = pop(); stack.push(b, a); break }
      case 29: { const i = pop(); stack.push(stack[stack.length - 1 - Math.max(0, i)] ?? 0); break }
      case 30: {
        const j = pop(), n = pop()
        if (n > 0 && n <= stack.length) {
          const part = stack.splice(stack.length - n, n), sh = ((j % n) + n) % n
          stack.push(...part.slice(n - sh), ...part.slice(0, n - sh))
        }
        break
      }
      default: stack = []
    }
  }
  interpret(cs, 0)
  return out
}
