import { forEachChunk } from './pngchunks.js'

export type SniffedFormat =
  | 'jpeg' | 'png' | 'tiff'
  | 'gif' | 'bmp' | 'ico' | 'webp' | 'avif' | 'svg'
  | 'unknown'

// SVG is markup, not a binary signature: a URL without an .svg extension still serves it
// comment bodies exclude "-->" so a run of comments can't backtrack exponentially (ReDoS)
const SVG_START = /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--(?:[^-]|-(?!->))*-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i

export function sniffFormat(b: Uint8Array): SniffedFormat {
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xD8) return 'jpeg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png'
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00)
                     || (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A))) return 'tiff'
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'bmp'
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'ico'
  const tag = (o: number) => o + 4 <= b.length ? String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!) : ''
  if (b.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WEBP') return 'webp'
  if (b.length >= 12 && tag(4) === 'ftyp') {
    // major_brand (offset 8) is the common case, but MIAF-conformant
    // encoders often set it to a generic brand (mif1/msf1/...) and list
    // avif/avis only among the compatible_brands that follow the (4-byte)
    // minor_version at offset 16 — a real still-image AVIF confirmed this
    // (major_brand "mif1", "avif" as the second compatible brand), so the
    // major-brand-only check silently dropped a perfectly valid file
    if (tag(8) === 'avif' || tag(8) === 'avis') return 'avif'
    const boxSize = b.length >= 4 ? (((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0) : 0
    const end = boxSize > 0 ? Math.min(boxSize, b.length) : b.length
    for (let o = 16; o + 4 <= end; o += 4) {
      if (tag(o) === 'avif' || tag(o) === 'avis') return 'avif'
    }
  }
  if (SVG_START.test(new TextDecoder().decode(b.subarray(0, 1024)))) return 'svg'
  return 'unknown'
}

// mirrors the engine PNG fast path's gating — anything outside it (interlaced,
// non-8-bit, palette, tRNS) is browser-decoded instead
export function pngNeedsBrowserDecode(b: Uint8Array): boolean {
  if (b.length < 33) return false
  if (b[12] !== 0x49 || b[13] !== 0x48 || b[14] !== 0x44 || b[15] !== 0x52) return false
  const bpc = b[24], ct = b[25], interlace = b[28]
  if (interlace !== 0 || bpc !== 8) return true
  // color type 3 belongs here: parsePng decodes indexed images natively, and
  // handles their per-entry tRNS alpha too. Excluding it made that whole branch
  // of the fast path unreachable and sent every palette PNG to the browser.
  if (ct !== 0 && ct !== 2 && ct !== 3 && ct !== 4 && ct !== 6) return true
  // tRNS on gray/rgb is color-key transparency, which the fast path declines;
  // on indexed it is per-entry alpha, which it implements.
  return ct !== 3 && hasTrnsChunk(b)
}

export function hasTrnsChunk(b: Uint8Array): boolean {
  let found = false
  forEachChunk(b, type => {
    if (type === 'tRNS') { found = true; return true }
    return type === 'IDAT' || type === 'IEND'
  })
  return found
}
