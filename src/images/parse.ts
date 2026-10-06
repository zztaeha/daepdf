import { unzlib } from '../daefl/index.js'
import type { ParsedImage } from '../types/engine.js'
import { forEachChunk } from './pngchunks.js'
import { hasTrnsChunk } from './sniff.js'

// only formats the browser can't handle for PDF embedding live here: JPEG
// (DCT passthrough + EXIF) and the PNG fast path (byte-exact alpha).
// Everything else is browser-decoded in the renderer (src/images/) and
// embedded as raw pixels via embed_raw_image. TIFF is not supported (browsers
// can't decode it, and it isn't worth a hand-rolled decoder here).
export function parseImage(bytes: Uint8Array): ParsedImage | null {
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xD8) return parseJpeg(bytes)
  return parsePng(bytes)
}

function matchAscii(b: Uint8Array, o: number, s: string): boolean {
  if (o + s.length > b.length) return false
  for (let k = 0; k < s.length; k++) if (b[o + k] !== s.charCodeAt(k)) return false
  return true
}

function isSofMarker(m: number): boolean {
  return m === 0xC0 || m === 0xC1 || m === 0xC2 || m === 0xC3 || m === 0xC5 || m === 0xC6 || m === 0xC7
      || m === 0xC9 || m === 0xCA || m === 0xCB || m === 0xCD || m === 0xCE || m === 0xCF
}

// `tiff` is the embedded TIFF structure starting at the byte-order mark —
// endian-aware IFD0 walk for the orientation tag (0x0112)
function exifOrientation(tiff: Uint8Array): number | null {
  let le: boolean
  if (tiff.length >= 2 && tiff[0] === 0x49 && tiff[1] === 0x49) le = true
  else if (tiff.length >= 2 && tiff[0] === 0x4D && tiff[1] === 0x4D) le = false
  else return null

  const u16 = (o: number): number | null => {
    if (o + 2 > tiff.length) return null
    return le ? (tiff[o]! | (tiff[o + 1]! << 8)) : ((tiff[o]! << 8) | tiff[o + 1]!)
  }
  const u32 = (o: number): number | null => {
    if (o + 4 > tiff.length) return null
    const b0 = tiff[o]!, b1 = tiff[o + 1]!, b2 = tiff[o + 2]!, b3 = tiff[o + 3]!
    return le ? (((b3 << 24) | (b2 << 16) | (b1 << 8) | b0) >>> 0) : (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)
  }

  if (u16(2) !== 42) return null
  const ifd0 = u32(4)
  if (ifd0 === null) return null
  const count = u16(ifd0)
  if (count === null) return null

  for (let e = 0; e < Math.min(count, 512); e++) {
    const entry = ifd0 + 2 + e * 12
    const tag = u16(entry)
    if (tag === null) return null
    if (tag === 0x0112) {
      const v = u16(entry + 8)
      return v !== null && v >= 1 && v <= 8 ? v : null
    }
  }
  return null
}

// An ICC profile is only usable when its color space has the image's channel count
// (ISO 15076-1: the data color space signature at byte 16)
function matchingProfile(icc: Uint8Array | null, colorSpace: string): Uint8Array | null {
  if (!icc || icc.length < 132) return null
  const want = colorSpace === 'DeviceGray' ? 'GRAY' : colorSpace === 'DeviceCMYK' ? 'CMYK' : 'RGB '
  return matchAscii(icc, 16, want) ? icc : null
}

function parseJpeg(bytes: Uint8Array): ParsedImage | null {
  const dims = parseJpegDims(bytes)
  if (!dims) return null
  return {
    width: dims.width, height: dims.height, colorSpace: dims.colorSpace,
    data: bytes, smask: null, isJpeg: true,
    decodeInvert: dims.invert, orientation: dims.orientation,
    icc: matchingProfile(dims.icc, dims.colorSpace),
  }
}

function parseJpegDims(bytes: Uint8Array): {
  width: number; height: number
  colorSpace: 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK'
  invert: boolean; orientation: number; icc: Uint8Array | null
} | null {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null
  let i = 2
  let adobe = false
  let orientation = 1
  // APP2 "ICC_PROFILE": a profile split over numbered segments, joined in order
  const iccParts = new Map<number, Uint8Array>()
  let iccCount = 0
  const icc = (): Uint8Array | null => {
    if (!iccCount || iccParts.size !== iccCount) return null
    const parts = Array.from({ length: iccCount }, (_, k) => iccParts.get(k + 1))
    if (parts.some(p => !p)) return null
    const out = new Uint8Array(parts.reduce((n, p) => n + p!.length, 0))
    let off = 0
    for (const p of parts) { out.set(p!, off); off += p!.length }
    return out
  }
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xFF) return null
    // 0xFF fill bytes before a marker are legal padding — skip them
    while (i + 1 < bytes.length && bytes[i + 1] === 0xFF) i++
    if (i + 3 >= bytes.length) return null
    const marker = bytes[i + 1]!
    i += 2
    // standalone markers (no length field): EOI, RSTn, TEM
    if (marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) continue
    if (i + 1 >= bytes.length) return null
    const segLen = (bytes[i]! << 8) | bytes[i + 1]!
    if (segLen < 2) return null
    // APP14 "Adobe" — Adobe encoders write CMYK/YCCK channels INVERTED
    // (libjpeg convention); the PDF needs a /Decode array to flip them back
    if (marker === 0xEE && matchAscii(bytes, i + 2, 'Adobe')) adobe = true
    // APP1 "Exif" — camera rotation lives in IFD0 tag 0x0112
    if (marker === 0xE1 && segLen >= 8 && matchAscii(bytes, i + 2, 'Exif\0\0')) {
      const o = exifOrientation(bytes.subarray(i + 8, Math.min(i + segLen, bytes.length)))
      if (o !== null) orientation = o
    }
    if (marker === 0xE2 && segLen >= 16 && matchAscii(bytes, i + 2, 'ICC_PROFILE\0')) {
      iccCount = bytes[i + 15]!
      iccParts.set(bytes[i + 14]!, bytes.subarray(i + 16, Math.min(i + segLen, bytes.length)))
    }
    if (isSofMarker(marker) && i + 8 < bytes.length) {
      const h = (bytes[i + 3]! << 8) | bytes[i + 4]!
      const w = (bytes[i + 5]! << 8) | bytes[i + 6]!
      const csByte = bytes[i + 7]!
      const colorSpace = csByte === 1 ? 'DeviceGray' : csByte === 4 ? 'DeviceCMYK' : 'DeviceRGB'
      return { width: w, height: h, colorSpace, invert: adobe && colorSpace === 'DeviceCMYK', orientation, icc: icc() }
    }
    if (i + segLen > bytes.length) return null
    i += segLen
  }
  return null
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

// PLTE: the RGB palette for indexed-color (ct 3) images — one [r,g,b] triple
// per entry, in palette-index order. Malformed (non-multiple-of-3 length) is
// treated as absent, same as any other unparseable case in this fast path.
function readPlteChunk(b: Uint8Array): Uint8Array[] | null {
  let out: Uint8Array[] | null = null
  forEachChunk(b, (type, data) => {
    if (type === 'PLTE') {
      if (data.length % 3 !== 0) { out = null; return true }
      const entries: Uint8Array[] = []
      for (let o = 0; o < data.length; o += 3) entries.push(data.subarray(o, o + 3))
      out = entries
      return true
    }
    return type === 'IDAT' || type === 'IEND'
  })
  return out
}

// tRNS on an indexed (ct 3) image: one alpha byte per palette entry, in
// palette order — entries the chunk doesn't cover default to fully opaque
// (per spec), applied as overrides on top of readPlteChunk's own default.
function readTrnsIndexed(b: Uint8Array): Uint8Array | null {
  let out: Uint8Array | null = null
  forEachChunk(b, (type, data) => {
    if (type === 'tRNS') { out = data; return true }
    return type === 'IDAT' || type === 'IEND'
  })
  return out
}

function collectIdat(b: Uint8Array): Uint8Array | null {
  const parts: Uint8Array[] = []
  forEachChunk(b, (type, data) => {
    if (type === 'IDAT') parts.push(data)
    return type === 'IEND'
  })
  if (!parts.length) return null
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

// fast path only: 8-bit, non-interlaced, gray/rgb(+alpha) or indexed (with its
// own tRNS-as-per-entry-alpha support). Color-key tRNS on gray/rgb and every
// other PNG shape falls outside it, returning null — the renderer browser-
// decodes those instead (src/images/decode.ts)
function parsePng(bytes: Uint8Array): ParsedImage | null {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 33) return null
  for (let k = 0; k < 8; k++) if (bytes[k] !== SIG[k]) return null
  if (!(bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52)) return null

  const u32 = (o: number) => ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0
  const w = u32(16)
  const h = u32(20)
  if (w === 0 || h === 0) return null
  const bpc = bytes[24]
  const ct = bytes[25]
  if (bytes[28] !== 0) return null
  if (bpc !== 8) return null

  let chIn: number, chOut: number, colorSpace: 'DeviceGray' | 'DeviceRGB', hasAlpha: boolean
  if (ct === 0)      { chIn = 1; chOut = 1; colorSpace = 'DeviceGray'; hasAlpha = false }
  else if (ct === 2) { chIn = 3; chOut = 3; colorSpace = 'DeviceRGB';  hasAlpha = false }
  else if (ct === 3) { chIn = 1; chOut = 3; colorSpace = 'DeviceRGB';  hasAlpha = false }
  else if (ct === 4) { chIn = 2; chOut = 1; colorSpace = 'DeviceGray'; hasAlpha = true  }
  else if (ct === 6) { chIn = 4; chOut = 3; colorSpace = 'DeviceRGB';  hasAlpha = true  }
  else return null

  // color-key transparency (tRNS on ct 0/2) needs a different mechanism than
  // a channel this fast path doesn't implement — bail so the browser-decode
  // fallback handles it. ct 4/6's tRNS is meaningless (already real alpha).
  // ct 3's tRNS (per-palette-entry alpha) is handled explicitly below.
  if (ct !== 3 && hasTrnsChunk(bytes)) return null

  // indexed color (ct 3): every raw byte is a palette index, not a color
  // component — the RGB palette (from PLTE) plus per-entry alpha (from tRNS,
  // else opaque) is built once here and looked up per pixel below.
  let paletteRgb: Uint8Array[] | null = null
  let paletteAlpha: Uint8Array | null = null
  if (ct === 3) {
    paletteRgb = readPlteChunk(bytes)
    if (!paletteRgb || !paletteRgb.length) return null
    paletteAlpha = new Uint8Array(paletteRgb.length).fill(255)
    const trns = readTrnsIndexed(bytes)
    if (trns) {
      hasAlpha = false
      for (let idx = 0; idx < trns.length; idx++) {
        if (trns[idx] !== 255) hasAlpha = true
        if (idx < paletteAlpha.length) paletteAlpha[idx] = trns[idx]!
      }
    }
  }

  const idat = collectIdat(bytes)
  if (!idat || !idat.length) return null

  // w/h/chIn are already known from IHDR at this point, so the correctly-sized
  // output is computable BEFORE inflating – passing it to unzlib caps the
  // decompression itself at that size (daefl treats the buffer as a hard limit
  // and throws rather than growing, so a stream claiming more than the IHDR
  // describes is rejected outright), closing
  // off a decompression-bomb: a small, highly-compressible IDAT could otherwise
  // inflate to an arbitrarily large buffer before the old post-hoc length check
  // ever got a chance to reject it. Same class of bug already fixed on the Rust
  // engine side (see tasks/lessons.md's "Allocation-before-validation OOMs") —
  // validate/bound BEFORE allocating, not after.
  const stride = w * chIn
  const rowLen = stride + 1
  const needed = h * rowLen
  // IHDR's w/h are a raw, untrusted u32 each (up to ~4.29 billion) — a crafted
  // IHDR needs no real pixel data at all to make `needed` astronomical, and
  // `new Uint8Array(needed)` for a sufficiently large N does NOT throw a
  // catchable RangeError, it's a hard V8 fatal (confirmed directly: 4e12
  // brings down the whole process/tab, bypassing this function's own
  // try/catch entirely) — a MORE severe crash than the decompression-bomb
  // this whole fix was meant to close. 512MB comfortably covers any
  // realistic print-quality embedded image (a 300dpi A0 poster is under
  // 600MB raw RGBA) while staying far below the multi-GB range where V8
  // itself starts refusing the allocation outright.
  //
  // Checked against `needed` (chIn-based, sizes the decompression output)
  // AND `w*h*chOut` (sizes the `pixels` buffer below) separately — they are
  // NOT the same quantity whenever chIn !== chOut. Indexed color (ct 3) is
  // the extreme case: chIn=1 but chOut=3, so `pixels` ends up roughly 3x
  // LARGER than `needed` — bounding `needed` alone would let a crafted
  // indexed-PNG IHDR through with a `pixels` allocation up to 3x this cap.
  const MAX_DECODED_BYTES = 512 * 1024 * 1024
  if (needed > MAX_DECODED_BYTES || w * h * chOut > MAX_DECODED_BYTES) return null
  let raw: Uint8Array
  try { raw = unzlib(idat, new Uint8Array(needed)) } catch { return null }
  if (raw.length < needed) return null

  const pixels = new Uint8Array(w * h * chOut)
  let pixelsOff = 0
  const smask = hasAlpha ? new Uint8Array(w * h) : null
  let smaskOff = 0
  let prev = new Uint8Array(stride)
  let row  = new Uint8Array(stride)

  for (let r = 0; r < h; r++) {
    const base = r * rowLen
    const ft  = raw[base]
    const src = raw.subarray(base + 1, base + 1 + stride)
    if (ft === 0) {
      row.set(src)
    } else if (ft === 1) {
      for (let j = 0; j < stride; j++) {
        const a = j >= chIn ? row[j - chIn]! : 0
        row[j] = (src[j]! + a) & 0xFF
      }
    } else if (ft === 2) {
      for (let j = 0; j < stride; j++) row[j] = (src[j]! + prev[j]!) & 0xFF
    } else if (ft === 3) {
      for (let j = 0; j < stride; j++) {
        const a = j >= chIn ? row[j - chIn]! : 0
        row[j] = (src[j]! + ((a + prev[j]!) >> 1)) & 0xFF
      }
    } else if (ft === 4) {
      for (let j = 0; j < stride; j++) {
        const a = j >= chIn ? row[j - chIn]! : 0
        const c = j >= chIn ? prev[j - chIn]! : 0
        row[j] = (src[j]! + paethPredictor(a, prev[j]!, c)) & 0xFF
      }
    } else {
      row.set(src)
    }

    if (paletteRgb) {
      for (let j = 0; j < stride; j++) {
        const idx = row[j]!
        if (idx >= paletteRgb.length) return null // index beyond the palette — malformed, not guessable
        const rgb = paletteRgb[idx]!
        pixels[pixelsOff++] = rgb[0]!; pixels[pixelsOff++] = rgb[1]!; pixels[pixelsOff++] = rgb[2]!
        if (smask) smask[smaskOff++] = paletteAlpha![idx]!
      }
    } else if (chIn !== chOut) {
      for (let j = 0; j < stride; j += chIn) {
        for (let k = 0; k < chOut; k++) pixels[pixelsOff++] = row[j + k]!
        if (smask) smask[smaskOff++] = row[j + chIn - 1]!
      }
    } else {
      pixels.set(row, pixelsOff)
      pixelsOff += stride
    }

    const tmp = row; row = prev; prev = tmp
  }

  return { width: w, height: h, colorSpace, data: pixels, smask, isJpeg: false, decodeInvert: false, orientation: 1, icc: readIccp(bytes, colorSpace) }
}

// iCCP: a profile name, a NUL, a compression method (0), then the zlib-compressed profile;
// inflated into a capped buffer, as no real profile comes near it
function readIccp(b: Uint8Array, colorSpace: string): Uint8Array | null {
  let icc: Uint8Array | null = null
  forEachChunk(b, (type, data) => {
    if (type === 'iCCP') {
      const nul = data.indexOf(0)
      if (nul > 0 && nul + 2 <= data.length && data[nul + 1] === 0) {
        try { icc = unzlib(data.subarray(nul + 2), new Uint8Array(4 * 1024 * 1024)).slice() } catch { icc = null }
      }
      return true
    }
    return type === 'IDAT' || type === 'IEND'
  })
  return matchingProfile(icc, colorSpace)
}
