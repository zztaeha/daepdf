// daefl — daepdf's zlib. Only the two operations daepdf needs: zlib-wrapped
// deflate and inflate (RFC 1950 around RFC 1951), synchronous, no dependencies.
//
// Synchronous on purpose. CompressionStream would give the same bytes for no
// code, but it is async, and every deflate() call site here sits inside a
// synchronous emit path.

import { deflateRaw } from './deflate.js'
import { inflateRawWithEnd, InflateError } from './inflate.js'

// Adler-32 (RFC 1950 section 9). 65521 is the largest prime below 2^16; the
// sums are reduced every 5552 bytes, the most that cannot overflow a 32-bit
// accumulator.
export function adler32(data: Uint8Array): number {
  let a = 1, b = 0
  let i = 0
  const n = data.length
  while (i < n) {
    // 5552 is the most bytes that cannot overflow b in 32 bits before the
    // reduction; the body is unrolled because the per-byte loop was a quarter
    // of total compression time when measured.
    const end = Math.min(i + 5552, n)
    const blocks = end - ((end - i) % 16)
    for (; i < blocks; i += 16) {
      a += data[i]!;      b += a
      a += data[i + 1]!;  b += a
      a += data[i + 2]!;  b += a
      a += data[i + 3]!;  b += a
      a += data[i + 4]!;  b += a
      a += data[i + 5]!;  b += a
      a += data[i + 6]!;  b += a
      a += data[i + 7]!;  b += a
      a += data[i + 8]!;  b += a
      a += data[i + 9]!;  b += a
      a += data[i + 10]!; b += a
      a += data[i + 11]!; b += a
      a += data[i + 12]!; b += a
      a += data[i + 13]!; b += a
      a += data[i + 14]!; b += a
      a += data[i + 15]!; b += a
    }
    for (; i < end; i++) { a += data[i]!; b += a }
    a %= 65521
    b %= 65521
  }
  return ((b << 16) | a) >>> 0
}

// level 6 is the default; 0 stores without compressing, 9 searches hardest.
export function zlib(data: Uint8Array, level = 6): Uint8Array {
  const body = deflateRaw(data, level)
  const out = new Uint8Array(body.length + 6)

  // CMF: deflate method (8) with a 32K window (7 << 4). FLG carries no preset
  // dictionary and a check value making the 16-bit header a multiple of 31.
  const cmf = 0x78
  let flg = (level >= 7 ? 3 : level >= 6 ? 2 : level >= 2 ? 1 : 0) << 6
  flg |= 31 - ((cmf << 8) | flg) % 31
  out[0] = cmf
  out[1] = flg

  out.set(body, 2)

  const sum = adler32(data)
  out[body.length + 2] = (sum >>> 24) & 0xFF
  out[body.length + 3] = (sum >>> 16) & 0xFF
  out[body.length + 4] = (sum >>> 8) & 0xFF
  out[body.length + 5] = sum & 0xFF
  return out
}

// `out`, when supplied, is both the destination and a hard cap: a stream that
// expands beyond it fails rather than allocating. The PNG path relies on that.
export function unzlib(data: Uint8Array, out?: Uint8Array): Uint8Array {
  if (data.length < 2) throw new InflateError('daefl: stream too short for a zlib header')

  const cmf = data[0]!
  const flg = data[1]!
  if ((cmf & 0x0F) !== 8) throw new InflateError('daefl: not deflate-compressed')
  if (((cmf << 8) | flg) % 31 !== 0) throw new InflateError('daefl: bad zlib header check')
  if (flg & 0x20) throw new InflateError('daefl: preset dictionaries are not supported')

  const { bytes, end } = inflateRawWithEnd(data.subarray(2), out)

  // The trailer is verified when present. Some producers truncate it, and a
  // stream that decoded cleanly is still usable, so a missing one is allowed
  // while a wrong one is not.
  const trailer = 2 + end
  if (trailer + 4 <= data.length) {
    const want =
      ((data[trailer]! << 24) | (data[trailer + 1]! << 16) |
       (data[trailer + 2]! << 8) | data[trailer + 3]!) >>> 0
    if (adler32(bytes) !== want) throw new InflateError('daefl: adler32 mismatch')
  }

  return bytes
}
