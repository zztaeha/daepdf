// Font tables for tests, added to the suite font: the repo ships no font assets.
import zlib from 'node:zlib'

const u8 = v => [v & 255]
const u16 = v => [v >> 8 & 255, v & 255]
const u24 = v => [v >> 16 & 255, v >> 8 & 255, v & 255]
const u32 = v => [v >>> 24, v >> 16 & 255, v >> 8 & 255, v & 255]
const i32 = v => u32(v >>> 0)
const f2 = v => u16(Math.round(v * 16384) & 0xFFFF)
const words = vs => vs.flatMap(u16)

// The font's tables, each as [tag, bytes]
export function tablesOf(font) {
  const v = new DataView(font.buffer, font.byteOffset)
  return Array.from({ length: v.getUint16(4) }, (_, i) => {
    const o = 12 + i * 16, at = v.getUint32(o + 8)
    return [String.fromCharCode(...font.subarray(o, o + 4)), font.subarray(at, at + v.getUint32(o + 12))]
  })
}

// The font with tables added or replaced, and those in `drop` removed
export function withTables(font, add, drop = []) {
  const tables = tablesOf(font).filter(([tag]) => !(tag in add) && !drop.includes(tag))
  for (const [tag, data] of Object.entries(add)) tables.push([tag, data instanceof Uint8Array ? data : new Uint8Array(data)])
  tables.sort((a, b) => a[0] < b[0] ? -1 : 1)
  const size = 12 + tables.length * 16 + tables.reduce((n, [, d]) => n + ((d.length + 3) & ~3), 0)
  const out = new Uint8Array(size), v = new DataView(out.buffer)
  v.setUint32(0, 0x00010000); v.setUint16(4, tables.length)
  let at = 12 + tables.length * 16
  tables.forEach(([tag, data], i) => {
    for (let k = 0; k < 4; k++) out[12 + i * 16 + k] = tag.charCodeAt(k)
    v.setUint32(12 + i * 16 + 8, at); v.setUint32(12 + i * 16 + 12, data.length)
    out.set(data, at); at += (data.length + 3) & ~3
  })
  return out
}

// CPAL with one palette of [r, g, b, a] (0-255)
export function cpal(colors) {
  return [...u16(0), ...u16(colors.length), ...u16(1), ...u16(colors.length), ...u32(14), ...u16(0),
    ...colors.flatMap(([r, g, b, a]) => [b, g, r, a])]
}

// COLR v0: base gid -> [[layer gid, palette index], ...]
export function colrV0(base) {
  const entries = [...base].sort((a, b) => a[0] - b[0])
  const records = [], layers = []
  for (const [gid, ls] of entries) { records.push(...u16(gid), ...u16(layers.length / 4), ...u16(ls.length)); for (const [g, p] of ls) layers.push(...u16(g), ...u16(p)) }
  return [...u16(0), ...u16(entries.length), ...u32(14), ...u32(14 + records.length), ...u16(layers.length / 4), ...records, ...layers]
}

// A paint and the subtables it points at, children after their parent (offsets are unsigned)
function paint(p) {
  const withChildren = (head, children) => {
    const out = [...head]
    for (const [at, child, size = 3] of children) {
      const off = out.length
      out.splice(at, size, ...(size === 3 ? u24(off) : u32(off)))
      out.push(...child)
    }
    return out
  }
  const line = (l, isVar) => [...u8(l.extend ?? 0), ...u16(l.stops.length),
    ...l.stops.flatMap(([off, pal, alpha, base]) => [...f2(off), ...u16(pal), ...f2(alpha), ...(isVar ? u32(base ?? 0xFFFFFFFF) : [])])]
  switch (p.format) {
    case 1: return [1, p.count, ...u32(p.first)]
    case 2: return [2, ...u16(p.palette), ...f2(p.alpha ?? 1)]
    case 3: return [3, ...u16(p.palette), ...f2(p.alpha ?? 1), ...u32(p.varBase)]
    case 4: return withChildren([4, 0, 0, 0, ...words(p.points)], [[1, line(p.line)]])
    case 6: return withChildren([6, 0, 0, 0, ...words(p.circles)], [[1, line(p.line)]])
    case 8: return withChildren([8, 0, 0, 0, ...words(p.center), ...f2(p.start / 180 - 1), ...f2(p.end / 180 - 1)], [[1, line(p.line)]])
    case 10: return withChildren([10, 0, 0, 0, ...u16(p.gid)], [[1, paint(p.paint)]])
    case 11: return [11, ...u16(p.gid)]
    case 12: return withChildren([12, 0, 0, 0, 0, 0, 0], [[1, paint(p.paint)], [4, p.matrix.flatMap(v => i32(Math.round(v * 65536)))]])
    case 14: return withChildren([14, 0, 0, 0, ...words(p.offset)], [[1, paint(p.paint)]])
    case 32: return withChildren([32, 0, 0, 0, p.mode, 0, 0, 0], [[1, paint(p.source)], [5, paint(p.backdrop)]])
  }
  throw new Error(`test encoder: paint format ${p.format}`)
}

// COLR v1: base gid -> paint, plus the LayerList, clip boxes [first, last, [x0, y0, x1, y1]] and an
// ItemVariationStore of regions (per axis [start, peak, end]) and one delta row per VarIndexBase + k
export function colrV1({ base, layers = [], clips = [], regions = [], deltas = [], axisCount = 0 }) {
  const entries = [...base].sort((a, b) => a[0] - b[0])
  const blob = (count, items, recordSize, record) => {
    const out = [...u32(count)]
    const bodies = items.map(paint)
    let at = 4 + count * recordSize
    items.forEach((_, i) => { out.push(...record(i, at)); at += bodies[i].length })
    return [...out, ...bodies.flat()]
  }
  const baseList = blob(entries.length, entries.map(e => e[1]), 6, (i, at) => [...u16(entries[i][0]), ...u32(at)])
  const layerList = blob(layers.length, layers, 4, (_, at) => u32(at))
  let clipList = []
  if (clips.length) {
    clipList = [1, ...u32(clips.length)]
    const boxesAt = 5 + clips.length * 7
    clips.forEach(([first, last], i) => clipList.push(...u16(first), ...u16(last), ...u24(boxesAt + i * 9)))
    for (const [, , box] of clips) clipList.push(1, ...words(box))
  }
  let store = []
  if (regions.length) {
    const regionList = [...u16(axisCount), ...u16(regions.length), ...regions.flatMap(r => r.flatMap(([s, p, e]) => [...f2(s), ...f2(p), ...f2(e)]))]
    const data = [...u16(deltas.length), ...u16(regions.length), ...u16(regions.length), ...regions.flatMap((_, i) => u16(i)), ...deltas.flatMap(row => row.flatMap(u16))]
    store = [...u16(1), ...u32(12), ...u16(1), ...u32(12 + regionList.length), ...regionList, ...data]
  }
  const head = 34
  const at = [head, head + baseList.length, head + baseList.length + layerList.length, head + baseList.length + layerList.length + clipList.length]
  return [...u16(1), ...u16(0), ...u32(0), ...u32(0), ...u16(0),
    ...u32(at[0]), ...u32(layers.length ? at[1] : 0), ...u32(clips.length ? at[2] : 0), ...u32(0), ...u32(regions.length ? at[3] : 0),
    ...baseList, ...layerList, ...clipList, ...store]
}

// A name table holding only a PostScript name
export function psName(name) {
  const text = [...name].flatMap(c => u16(c.charCodeAt(0)))
  return [...u16(0), ...u16(1), ...u16(18), ...u16(3), ...u16(1), ...u16(0x409), ...u16(6), ...u16(text.length), ...u16(0), ...text]
}

// A solid RGBA PNG
export function png(width, height, rgba = [255, 0, 0, 255]) {
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(8 + data.length + 4)
    out.writeUInt32BE(data.length); td.copy(out, 4); out.writeUInt32BE(zlib.crc32(td), 8 + data.length)
    return out
  }
  const rows = Buffer.from(Array.from({ length: height }, () => [0, ...Array.from({ length: width }, () => rgba).flat()]).flat())
  return [...Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.from([...u32(width), ...u32(height), 8, 6, 0, 0, 0])), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])]
}

// sbix with one strike: gid's PNG, offset from the glyph origin to the image's bottom-left corner
export function sbix(numGlyphs, gid, ppem, image, offsetX, offsetY) {
  const glyph = [...u16(offsetX & 0xFFFF), ...u16(offsetY & 0xFFFF), ...Buffer.from('png '), ...image]
  const offsets = Array.from({ length: numGlyphs + 1 }, (_, g) => 4 + (numGlyphs + 1) * 4 + (g > gid ? glyph.length : 0))
  return [...u16(1), ...u16(1), ...u32(1), ...u32(12), ...u16(ppem), ...u16(72), ...offsets.flatMap(u32), ...glyph]
}

// CBLC and CBDT with one strike: gid's PNG and its bearings, the top edge measured up from the baseline
export function cbdt(gid, ppem, image, width, height, bearingX, bearingY) {
  const glyph = [height, width, bearingX & 255, bearingY & 255, width, ...u32(image.length), ...image]
  const lines = Array(24).fill(0)
  const array = [...u16(gid), ...u16(gid), ...u32(8)], subtable = [...u16(1), ...u16(17), ...u32(4), ...u32(0), ...u32(glyph.length)]
  return {
    CBLC: [...u16(3), ...u16(0), ...u32(1), ...u32(8 + 48), ...u32(array.length + subtable.length), ...u32(1), ...u32(0),
      ...lines, ...u16(gid), ...u16(gid), ppem, ppem, 32, 1, ...array, ...subtable],
    CBDT: [...u16(3), ...u16(0), ...glyph],
  }
}

// The suite font as a static CFF2 font: its metrics, mapping and layout kept, its outlines replaced by
// a CFF2 table where each glyph in `boxes` is a rectangle [x, y, width, height] and the rest are empty
export function staticCff2(font, boxes) {
  const maxp = tablesOf(font).find(([t]) => t === 'maxp')[1], numGlyphs = maxp[4] << 8 | maxp[5]
  const num = v => v >= -107 && v <= 107 ? [v + 139] : [28, ...u16(v & 0xFFFF)]
  const charstrings = Array.from({ length: numGlyphs }, (_, g) => {
    if (!boxes[g]) return []
    const [x, y, w, h] = boxes[g]
    return [...num(x), ...num(y), 21, ...num(w), ...num(0), 5, ...num(0), ...num(h), 5, ...num(-w), ...num(0), 5]
  })
  const index = items => {
    const offsets = [1]
    for (const it of items) offsets.push(offsets.at(-1) + it.length)
    return [...u32(items.length), 4, ...offsets.flatMap(u32), ...items.flat()]
  }
  const int5 = v => [29, ...u32(v)]
  const top = 13, charstringsAt = 5 + top + 4, strings = index(charstrings)
  const fdArrayAt = charstringsAt + strings.length, fdArray = index([[...int5(2), ...int5(fdArrayAt + 24), 18]])
  const cff2 = [2, 0, 5, ...u16(top), ...int5(charstringsAt), 17, ...int5(fdArrayAt), 12, 36, ...u32(0), ...strings, ...fdArray, ...num(50), 10]
  const out = withTables(font, { CFF2: cff2 }, ['glyf', 'loca', 'gvar', 'fvar', 'avar', 'HVAR', 'MVAR', 'STAT', 'cvt ', 'fpgm', 'prep', 'gasp'])
  out.set([0x4F, 0x54, 0x54, 0x4F])
  return out
}
