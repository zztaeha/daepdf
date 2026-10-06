import type { InternalCtx, DocFont } from './types.js'
import { toPdfName, bboxToPdf, widthsToPdf, w2ToPdf, _te } from './utils.js'
import { toUnicodeCmap } from './cmap.js'
import {
  get_advance_widths, get_vertical_advance, subset_font_full,
} from '../daegun/wasm/daegun.js'
import { deflate } from './deflate.js'

// A subset's PostScript name starts with six uppercase letters and a plus (ISO 32000-1
// 9.6.4); derived from the font's id and glyphs, so each subset gets its own name
function subsetTag(id: string, gids: Uint16Array): string {
  let h = 0x811C9DC5
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193)
  for (const g of gids) h = Math.imul(h ^ g, 0x01000193)
  let tag = ''
  for (let i = 0; i < 6; i++) { tag += String.fromCharCode(65 + (h >>> 0) % 26); h = Math.imul(h ^ i, 0x01000193) }
  return tag
}

// What a PDF reads from an embedded font (ISO 32000-1 9.9), plus what OpenType requires of a CFF
// font; layout, color and bitmap tables are dead weight there (an emoji font's sbix runs past 100MB)
const TRUETYPE_TABLES: ReadonlySet<string> = new Set(['head', 'hhea', 'hmtx', 'maxp', 'loca', 'glyf', 'cvt ', 'fpgm', 'prep', 'gasp', 'OS/2', 'post', 'vhea', 'vmtx'])
const CFF_TABLES: ReadonlySet<string> = new Set(['head', 'hhea', 'hmtx', 'maxp', 'CFF ', 'cmap', 'name', 'OS/2', 'post', 'vhea', 'vmtx', 'VORG'])

const isSfnt = (b: Uint8Array): boolean => b.length > 12 &&
  ((b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || sfntTag(b, 0) === 'OTTO' || sfntTag(b, 0) === 'true')
const sfntTag = (b: Uint8Array, o: number): string => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!)

// The font with only the given tables: the directory and data rewritten, head's checksum
// adjustment recomputed over the result
export function onlyTables(font: Uint8Array, keep: ReadonlySet<string>): Uint8Array {
  if (!isSfnt(font)) return font
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength)
  const tables = Array.from({ length: view.getUint16(4) }, (_, i) => {
    const o = 12 + i * 16
    return { tag: sfntTag(font, o), record: o, offset: view.getUint32(o + 8), length: view.getUint32(o + 12) }
  })
  const kept = tables.filter(t => keep.has(t.tag))
  if (kept.length === tables.length) return font

  const n = kept.length, pow = 2 ** Math.floor(Math.log2(n))
  const out = new Uint8Array(12 + n * 16 + kept.reduce((sum, t) => sum + ((t.length + 3) & ~3), 0))
  const ov = new DataView(out.buffer)
  ov.setUint32(0, view.getUint32(0))
  ov.setUint16(4, n); ov.setUint16(6, pow * 16); ov.setUint16(8, Math.log2(pow)); ov.setUint16(10, n * 16 - pow * 16)
  let at = 12 + n * 16, headAt = -1
  kept.forEach((t, i) => {
    out.set(font.subarray(t.record, t.record + 8), 12 + i * 16)
    ov.setUint32(12 + i * 16 + 8, at)
    ov.setUint32(12 + i * 16 + 12, t.length)
    out.set(font.subarray(t.offset, t.offset + t.length), at)
    if (t.tag === 'head') headAt = at
    at += (t.length + 3) & ~3
  })
  if (headAt >= 0 && headAt + 12 <= out.length) {
    ov.setUint32(headAt + 8, 0)
    let sum = 0
    for (let o = 0; o + 4 <= out.length; o += 4) sum = (sum + ov.getUint32(o)) >>> 0
    ov.setUint32(headAt + 8, (0xB1B0AFBA - sum) >>> 0)
  }
  return out
}

function embedFont(ctx: InternalCtx, font: DocFont): void {
  const gids   = new Uint16Array([...font.glyphIds].sort((a, b) => a - b))
  const result = subset_font_full(font.fontName, font.style, font.weight, font.opsz, gids)

  if (!result) return
  const { glyphMap, isCff, ascender, descender, capHeight, bbox, flags, italicAngle } = result
  const fontName = `${subsetTag(font.id, gids)}+${result.fontName}`

  const fontBytes = onlyTables(result.fontBytes, isCff ? CFF_TABLES : TRUETYPE_TABLES)

  const rawAdvs  = get_advance_widths(font.fontName, font.style, font.weight, font.opsz, gids)
  const widths: [number, number][] = Array.from(gids, (gid, i) => [gid, Math.round(rawAdvs[i]!)] as [number, number])

  const fontTableId = ctx.newObject()
  const compFont    = deflate(fontBytes)
  ctx.out('<<')
  ctx.out(`/Length ${ctx.encryptedLength(compFont.length)}`)
  if (isCff) {
    // a CFF-flavored OpenType file is labeled as one; a bare CFF table as CIDFontType0C
    ctx.out(`/Subtype /${sfntTag(fontBytes, 0) === 'OTTO' ? 'OpenType' : 'CIDFontType0C'}`)
  } else {
    ctx.out(`/Length1 ${fontBytes.length}`)
  }
  ctx.out('/Filter /FlateDecode')
  ctx.out('>>')
  ctx.out('stream')
  ctx.outBytes(compFont)
  ctx.out('endstream')
  ctx.out('endobj')

  // every missing character shares .notdef, so mapping it would copy them all as the first one
  const unicode = new Map(font.glyphToUnicode)
  unicode.delete(0)
  const cmapText = toUnicodeCmap(unicode)
  const compCmap = deflate(_te.encode(cmapText))
  const cmapId   = ctx.newObject()
  ctx.out('<<')
  ctx.out(`/Length ${ctx.encryptedLength(compCmap.length)}`)
  ctx.out('/Filter /FlateDecode')
  ctx.out('>>')
  ctx.out('stream')
  ctx.outBytes(compCmap)
  ctx.out('endstream')
  ctx.out('endobj')

  let cidToGidId = 0
  if (!isCff) {
    const maxCid   = gids.length ? Math.max(...gids) : 0
    const mapBytes = new Uint8Array((maxCid + 1) * 2)
    for (const orig of gids) {
      const compact = (orig < glyphMap.length ? glyphMap[orig]! : 0)
      mapBytes[orig * 2]     = (compact >> 8) & 0xFF
      mapBytes[orig * 2 + 1] =  compact       & 0xFF
    }
    const compMap = deflate(mapBytes)
    cidToGidId    = ctx.newObject()
    ctx.out('<<')
    ctx.out(`/Length ${ctx.encryptedLength(compMap.length)}`)
    ctx.out('/Filter /FlateDecode')
    ctx.out('>>')
    ctx.out('stream')
    ctx.outBytes(compMap)
    ctx.out('endstream')
    ctx.out('endobj')
  }

  ctx.beginCapture()
  ctx.out('<<')
  ctx.out('/Type /FontDescriptor')
  ctx.out(`/FontName /${toPdfName(fontName)}`)
  ctx.out(`/${isCff ? 'FontFile3' : 'FontFile2'} ${fontTableId} 0 R`)
  ctx.out(`/FontBBox ${bboxToPdf(Array.from(bbox))}`)
  ctx.out(`/Flags ${flags}`)
  ctx.out(`/StemV ${stemV(font.weight)}`)
  ctx.out(`/ItalicAngle ${italicAngle}`)
  ctx.out(`/Ascent ${ascender}`)
  ctx.out(`/Descent ${descender}`)
  ctx.out(`/CapHeight ${capHeight}`)
  ctx.out('>>')
  const fontDescriptorId = ctx.queueForObjStm(ctx.endCapture())

  ctx.beginCapture()
  ctx.out('<<')
  ctx.out('/Type /Font')
  ctx.out(`/BaseFont /${toPdfName(fontName)}`)
  ctx.out(`/FontDescriptor ${fontDescriptorId} 0 R`)
  ctx.out(`/W ${widthsToPdf(widths)}`)
  if (!isCff) ctx.out(`/CIDToGIDMap ${cidToGidId} 0 R`)
  ctx.out('/DW 1000')
  ctx.out(`/Subtype ${isCff ? '/CIDFontType0' : '/CIDFontType2'}`)
  ctx.out('/CIDSystemInfo')
  ctx.out('<<')
  ctx.out('/Supplement 0')
  ctx.out('/Registry (Adobe)')
  ctx.out('/Ordering (Identity)')
  ctx.out('>>')
  ctx.out('>>')
  const descendantId = ctx.queueForObjStm(ctx.endCapture())

  ctx.beginCapture()
  ctx.out('<<')
  ctx.out('/Type /Font')
  ctx.out('/Subtype /Type0')
  ctx.out(`/ToUnicode ${cmapId} 0 R`)
  ctx.out(`/BaseFont /${toPdfName(fontName)}`)
  ctx.out('/Encoding /Identity-H')
  ctx.out(`/DescendantFonts [${descendantId} 0 R]`)
  ctx.out('>>')
  const type0Id = ctx.queueForObjStm(ctx.endCapture())

  font.objectNumber = type0Id

  // A4 (vertical writing modes): a second, parallel Type0/CIDFont dict pair,
  // built only when this font was actually used vertically — same embedded
  // glyph data (FontDescriptor/CIDToGIDMap reused by reference), but with
  // /W2 + /DW2 (vertical metrics) instead of /W, and /Encoding /Identity-V
  // instead of /Identity-H. Per PDF spec 9.7.4.3, a glyph's position vector
  // (v1x, v1y) — the offset from its horizontal origin to its vertical
  // origin — defaults to (half that glyph's own /W width, DW2's own default
  // vy) when not explicitly overridden per glyph; v1y is applied uniformly
  // from the font's own ascender here (a reasonable, spec-legitimate
  // default absent a real VORG table this engine doesn't parse — no font
  // observed during this work actually carried one).
  if (font.usedVertically) {
    // get_vertical_advance returns 0 for both "this glyph's real vmtx
    // advance is 0" (never true for a real printing glyph) and "the font has
    // no vmtx/vhea table at all" — ambiguous, but only the second case is
    // ever real. Glyphs where it returns 0 are left OUT of /W2 entirely
    // (list form, not a range — a sparse list is valid) so they fall through
    // to /DW2's own default (-1000, a standard full em) instead of a literal
    // false zero-advance override, which would collapse every glyph in a
    // vmtx-less font on top of itself.
    const w2: [number, number, number, number][] = []
    for (const [i, gid] of gids.entries()) {
      const rawV = get_vertical_advance(font.fontName, font.style, font.weight, font.opsz, gid)
      if (rawV <= 0) continue
      const w1y = -Math.round(rawV)
      const v1x = Math.round(widths[i]![1] / 2)
      w2.push([gid, w1y, v1x, ascender])
    }

    ctx.beginCapture()
    ctx.out('<<')
    ctx.out('/Type /Font')
    ctx.out(`/BaseFont /${toPdfName(fontName)}`)
    ctx.out(`/FontDescriptor ${fontDescriptorId} 0 R`)
    ctx.out(`/W2 ${w2ToPdf(w2)}`)
    if (!isCff) ctx.out(`/CIDToGIDMap ${cidToGidId} 0 R`)
    ctx.out(`/DW2 [${ascender} -1000]`)
    ctx.out('/DW 1000')
    ctx.out(`/Subtype ${isCff ? '/CIDFontType0' : '/CIDFontType2'}`)
    ctx.out('/CIDSystemInfo')
    ctx.out('<<')
    ctx.out('/Supplement 0')
    ctx.out('/Registry (Adobe)')
    ctx.out('/Ordering (Identity)')
    ctx.out('>>')
    ctx.out('>>')
    const descendantVId = ctx.queueForObjStm(ctx.endCapture())

    ctx.beginCapture()
    ctx.out('<<')
    ctx.out('/Type /Font')
    ctx.out('/Subtype /Type0')
    ctx.out(`/ToUnicode ${cmapId} 0 R`)
    ctx.out(`/BaseFont /${toPdfName(fontName)}`)
    ctx.out('/Encoding /Identity-V')
    ctx.out(`/DescendantFonts [${descendantVId} 0 R]`)
    ctx.out('>>')
    font.verticalObjectNumber = ctx.queueForObjStm(ctx.endCapture())
  }
}

// /StemV is the dominant vertical stem thickness. Zero says the font has none,
// which is the value readers consult when synthesizing bold and one preflight
// tools flag. The real figure needs the outlines; this is the long-standing
// estimate from the weight, landing near 88 for regular and 166 for bold.
function stemV(weight: number): number {
  const w = Number.isFinite(weight) && weight > 0 ? weight : 400
  return Math.round(50 + (w / 65) ** 2)
}

export function putFonts(ctx: InternalCtx): void {
  for (const font of ctx.fonts) {
    if (ctx.usedFonts.has(font.id)) embedFont(ctx, font)
  }
}
