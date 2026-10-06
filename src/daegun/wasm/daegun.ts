// The engine surface daepdf calls, over daegun built to wasm from `engine/`. The renderer names a
// font by family and style and the engine by handle, so the face registry lives here.

import { noteColorFont } from '../colorfonts.js'

export interface ShapedRun {
  glyphs: Uint16Array
  advances: Float64Array
  clusters: Uint32Array
}

export interface GlyphBitmap {
  png: Uint8Array
  ppem: number
  originX: number
  originY: number
}

export interface SubsetFontResult {
  fontBytes: Uint8Array
  glyphMap: Uint16Array
  isCff: boolean
  ascender: number
  descender: number
  capHeight: number
  bbox: [number, number, number, number]
  flags: number
  italicAngle: number
  fontName: string
}

interface Exports {
  memory: WebAssembly.Memory
  arg_buffer(len: number): number
  out_ptr(): number
  out_len(): number
  err_ptr(): number
  err_len(): number
  open(): number
  close(): number
  has_glyph(): number
  glyph_ids(): number
  shape(): number
  advance_widths(): number
  vertical_advance(): number
  colr_layers(): number
  glyph_bitmap(): number
  measure_width(): number
  subset(): number
}

const OK = 0
const FAILED = 1

const utf8 = new TextEncoder()
const decoder = new TextDecoder()

// Mirrors engine/src/lib.rs: little-endian throughout, a u32 length or count before every variable part.
class Writer {
  #parts: Uint8Array[] = []
  #len = 0

  #push(part: Uint8Array): void {
    this.#parts.push(part)
    this.#len += part.length
  }

  u32(v: number): Writer {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, v >>> 0, true)
    this.#push(b)
    return this
  }

  f64(v: number): Writer {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, v, true)
    this.#push(b)
    return this
  }

  bytes(v: Uint8Array): Writer {
    this.u32(v.length)
    this.#push(v)
    return this
  }

  string(v: string): Writer {
    return this.bytes(utf8.encode(v))
  }

  u16s(v: ArrayLike<number>): Writer {
    this.u32(v.length)
    const a = new Uint16Array(v.length)
    a.set(v)
    this.#push(new Uint8Array(a.buffer))
    return this
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.#len)
    let at = 0
    for (const p of this.#parts) {
      out.set(p, at)
      at += p.length
    }
    return out
  }
}

class Reader {
  #view: DataView
  #bytes: Uint8Array
  #at = 0

  constructor(source: Uint8Array) {
    this.#bytes = source
    this.#view = new DataView(source.buffer, source.byteOffset, source.byteLength)
  }

  u32(): number {
    const v = this.#view.getUint32(this.#at, true)
    this.#at += 4
    return v
  }

  f64(): number {
    const v = this.#view.getFloat64(this.#at, true)
    this.#at += 8
    return v
  }

  bytes(): Uint8Array {
    const n = this.u32()
    const v = this.#bytes.slice(this.#at, this.#at + n)
    this.#at += n
    return v
  }

  string(): string {
    return decoder.decode(this.bytes())
  }

  u16s(): Uint16Array {
    const n = this.u32()
    const v = new Uint16Array(n)
    for (let i = 0; i < n; i++) v[i] = this.#view.getUint16(this.#at + i * 2, true)
    this.#at += n * 2
    return v
  }

  u32s(): Uint32Array {
    const n = this.u32()
    const v = new Uint32Array(n)
    for (let i = 0; i < n; i++) v[i] = this.#view.getUint32(this.#at + i * 4, true)
    this.#at += n * 4
    return v
  }

  f64s(): Float64Array {
    const n = this.u32()
    const v = new Float64Array(n)
    for (let i = 0; i < n; i++) v[i] = this.#view.getFloat64(this.#at + i * 8, true)
    this.#at += n * 8
    return v
  }
}

let wasm: Exports | null = null

function engine(): Exports {
  if (!wasm) throw new Error('daegun: initEngine() has not finished')
  return wasm
}

// Any call can grow linear memory, which detaches views taken before it, so each access re-reads
// the buffer. The buffer pointer is claimed on its own line for the same reason.
function bytes(): Uint8Array {
  return new Uint8Array(engine().memory.buffer)
}

function call(fn: () => number, args: Writer): Reader | null {
  const x = engine()
  const blob = args.finish()
  const at = x.arg_buffer(blob.length)
  bytes().set(blob, at)

  const status = fn()
  if (status === FAILED) {
    const e = x.err_ptr()
    throw new Error(decoder.decode(bytes().slice(e, e + x.err_len())))
  }
  if (status !== OK) return null

  const o = x.out_ptr()
  return new Reader(bytes().slice(o, o + x.out_len()))
}

export type InitInput = BufferSource | Response | Promise<Response>

let loading: Promise<void> | null = null

// Concurrent callers share one instantiation: a second instance would replace the first and
// drop every font already registered on it. A failed load clears the way for a retry.
export default function initEngine(source?: InitInput): Promise<void> {
  if (wasm) return Promise.resolve()
  loading ??= (async () => {
    const from = source ?? new URL('./daegun.wasm', import.meta.url)
    const streaming = from instanceof URL || from instanceof Response || from instanceof Promise
    const instantiated = streaming
      ? await WebAssembly.instantiateStreaming(from instanceof URL ? fetch(from) : from, {})
      : await WebAssembly.instantiate(from, {})
    wasm = instantiated.instance.exports as unknown as Exports
  })().catch(e => { loading = null; throw e })
  return loading
}

interface Face {
  handle: number
  style: string
  // OS/2 usWeightClass; a variable face also answers anywhere in its wght range
  weight: number
  range: [number, number] | null
}

// By lowercased family name, each family's faces sorted by style, then weight
const families = new Map<string, Face[]>()

const order = (a: string | number, b: string | number) => a < b ? -1 : a > b ? 1 : 0

function register(name: string, font: Uint8Array, index: number): void {
  const r = call(() => engine().open(), new Writer().bytes(font).u32(index))!
  const handle = r.u32(), style = r.string(), weight = r.u32()
  const hasRange = r.u32() !== 0, min = r.f64(), max = r.f64()
  const face: Face = { handle, style, weight, range: hasRange ? [min, max] : null }

  const key = name.toLowerCase()
  const faces = families.get(key) ?? []
  // the same style and weight again replaces the face, as a reloaded @font-face does
  const old = faces.findIndex(f => f.style === style && f.weight === weight)
  if (old >= 0) {
    call(() => engine().close(), new Writer().u32(faces[old]!.handle))
    faces.splice(old, 1)
  }
  faces.push(face)
  faces.sort((a, b) => order(a.style, b.style) || order(a.weight, b.weight))
  families.set(key, faces)
}

// The face with the style asked for, or any face of the family when none has it; then the nearest
// weight, the first in style-then-weight order on a tie.
function pick(name: string, style: string, weight: number): Face | null {
  const faces = families.get(name.toLowerCase())
  if (!faces) return null
  const styled = faces.filter(f => f.style === style.toLowerCase())
  let best: Face | null = null, bestDistance = Infinity
  for (const f of styled.length ? styled : faces) {
    const distance = f.range ? Math.max(f.range[0] - weight, weight - f.range[1], 0) : Math.abs(weight - f.weight)
    if (distance < bestDistance) {
      best = f
      bestDistance = distance
    }
  }
  return best
}

export function register_font_raw(name: string, raw_bytes: Uint8Array): void {
  register(name, raw_bytes, 0xFFFFFFFF)
  noteColorFont(name, raw_bytes)
}

export function register_font_ttc(name: string, ttc_bytes: Uint8Array, index: number): void {
  register(name, ttc_bytes, index)
  noteColorFont(name, ttc_bytes, index)
}

// "name:style", lowercased and one per face, which is the shape and the casing the renderer parses.
export function list_registered_fonts(): string[] {
  const out: string[] = []
  for (const name of [...families.keys()].sort(order)) {
    for (const f of families.get(name)!) out.push(`${name}:${f.style}`)
  }
  return out
}

// Calls that take no weight answer from the regular-weight face.
export function font_has_glyph(font_name: string, style: string, codepoint: number): boolean {
  const face = pick(font_name, style, 400)
  if (!face) return false
  return call(() => engine().has_glyph(), new Writer().u32(face.handle).u32(codepoint))!.u32() !== 0
}

export function get_glyph_ids(text: string, font_name: string, style: string, weight: number): Uint16Array {
  const face = pick(font_name, style, weight)
  if (!face) return new Uint16Array(0)
  return call(() => engine().glyph_ids(), new Writer().u32(face.handle).string(text))!.u16s()
}

export function shape_text(
  text: string, font_name: string, style: string, weight: number, opsz: number, vertical: boolean,
): ShapedRun | null {
  const face = pick(font_name, style, weight)
  if (!face) return null
  const r = call(() => engine().shape(),
    new Writer().u32(face.handle).string(text).u32(weight).f64(opsz).u32(vertical ? 1 : 0))
  if (!r) return null
  return { glyphs: r.u16s(), advances: r.f64s(), clusters: r.u32s() }
}

export function get_advance_widths(
  font_name: string, style: string, weight: number, opsz: number, glyph_ids: Uint16Array,
): Float64Array {
  const face = pick(font_name, style, weight)
  if (!face) return new Float64Array(0)
  return call(() => engine().advance_widths(),
    new Writer().u32(face.handle).u32(weight).f64(opsz).u16s(glyph_ids))!.f64s()
}

// 0 when the font has no vertical metrics.
export function get_vertical_advance(
  font_name: string, style: string, weight: number, opsz: number, gid: number,
): number {
  const face = pick(font_name, style, weight)
  if (!face) return 0
  return call(() => engine().vertical_advance(),
    new Writer().u32(face.handle).u32(weight).f64(opsz).u32(gid))!.f64()
}

// Flat, six values per layer, matching what the renderer already unpacks.
export function get_colr_layers(font_name: string, style: string, gid: number): Uint32Array {
  const face = pick(font_name, style, 400)
  if (!face) return new Uint32Array(0)
  const r = call(() => engine().colr_layers(), new Writer().u32(face.handle).u32(gid))
  if (!r) return new Uint32Array(0)
  const n = r.u32()
  const out = new Uint32Array(n * 6)
  for (let i = 0; i < n * 6; i++) out[i] = r.u32()
  return out
}

// originX/originY: the image's bottom-left corner, in pixels at its ppem from the glyph origin, y up.
export function get_glyph_bitmap(
  font_name: string, style: string, gid: number, target_ppem: number,
): GlyphBitmap | null {
  const face = pick(font_name, style, 400)
  if (!face) return null
  const r = call(() => engine().glyph_bitmap(),
    new Writer().u32(face.handle).u32(gid).u32(target_ppem))
  if (!r) return null
  return { ppem: r.u32(), originX: r.f64(), originY: r.f64(), png: r.bytes() }
}

export function measure_string_width(
  text: string, font_name: string, style: string, weight: number, opsz: number, font_size: number,
): number {
  const face = pick(font_name, style, weight)
  if (!face) return 0
  return call(() => engine().measure_width(),
    new Writer().u32(face.handle).string(text).u32(weight).f64(opsz).f64(font_size))!.f64()
}

export function subset_font_full(
  font_name: string, style: string, weight: number, opsz: number, glyph_ids: Uint16Array,
): SubsetFontResult | null {
  const face = pick(font_name, style, weight)
  if (!face) return null
  const r = call(() => engine().subset(),
    new Writer().u32(face.handle).u32(weight).f64(opsz).u16s(glyph_ids))
  if (!r) return null
  const fontBytes = r.bytes()
  const glyphMap = r.u16s()
  const isCff = r.u32() !== 0
  const ascender = r.f64()
  const descender = r.f64()
  const capHeight = r.f64()
  const bbox: [number, number, number, number] = [r.f64(), r.f64(), r.f64(), r.f64()]
  const flags = r.u32()
  const italicAngle = r.f64()
  const fontName = r.string()
  return { fontBytes, glyphMap, isCff, ascender, descender, capHeight, bbox, flags, italicAngle, fontName }
}
