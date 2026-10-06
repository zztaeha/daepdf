// DEFLATE decompression (RFC 1951). Reads a raw deflate stream; the zlib
// header and adler32 around it are handled in index.ts.

// Extra bits and base values for the length codes 257-285 and distance codes
// 0-29, straight from RFC 1951 section 3.2.5.
const LEN_BASE = new Uint16Array([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
])
const LEN_EXTRA = new Uint8Array([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
])
const DIST_BASE = new Uint16Array([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
])
const DIST_EXTRA = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
])

// The code-length alphabet is transmitted in this order so that the trailing
// entries can be omitted when unused (RFC 1951 section 3.2.7).
const CLEN_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15])

export class InflateError extends Error {}

const fail = (msg: string): never => { throw new InflateError(`daefl: ${msg}`) }

// A canonical Huffman code, decoded through a flat table for the common case.
// `fast` is indexed by the next FAST_BITS bits of the stream and holds
// (length << 16) | symbol, or -1 when the code is longer than the table and
// the canonical walk over `counts`/`symbols` has to finish the job.
const FAST_BITS = 9
const FAST_SIZE = 1 << FAST_BITS
const FAST_MASK = FAST_SIZE - 1

interface Huff {
  counts: Uint16Array
  symbols: Uint16Array
  fast: Int32Array
  max: number
}

function buildHuff(lengths: Uint8Array, n: number): Huff {
  const counts = new Uint16Array(16)
  for (let i = 0; i < n; i++) { const l = lengths[i]!; counts[l] = counts[l]! + 1 }
  counts[0] = 0

  let max = 0
  for (let i = 1; i < 16; i++) if (counts[i]! > 0) max = i

  // A canonical code is over-subscribed when the codes at some length cannot
  // all fit; left > 0 at the end means it is incomplete. Both are corrupt
  // input rather than something to paper over.
  let left = 1
  for (let i = 1; i < 16; i++) {
    left <<= 1
    left -= counts[i]!
    if (left < 0) fail('over-subscribed Huffman code')
  }

  const offs = new Uint16Array(16)
  for (let i = 1; i < 15; i++) offs[i + 1] = offs[i]! + counts[i]!
  const symbols = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    const l = lengths[i]!
    if (l) { symbols[offs[l]!] = i; offs[l] = offs[l]! + 1 }
  }

  // Codes are stored most-significant-bit-first but read least-significant
  // first, so the table is indexed by the reversed code. Every longer index
  // sharing those low bits maps to the same symbol.
  const fast = new Int32Array(FAST_SIZE).fill(-1)
  let code = 0
  const next = new Uint16Array(16)
  for (let len = 1; len <= 15; len++) { next[len] = code; code = (code + counts[len]!) << 1 }

  let idx = 0
  for (let len = 1; len <= Math.min(max, FAST_BITS); len++) {
    for (let k = 0; k < counts[len]!; k++) {
      const sym = symbols[idx + k]!
      const c = next[len]! + k
      let rev = 0
      for (let b = 0; b < len; b++) rev |= ((c >> (len - 1 - b)) & 1) << b
      const entry = (len << 16) | sym
      for (let fill = rev; fill < FAST_SIZE; fill += 1 << len) fast[fill] = entry
    }
    idx += counts[len]!
  }

  return { counts, symbols, fast, max }
}

class BitReader {
  private pos = 0
  private acc = 0
  private nbits = 0

  constructor(private readonly src: Uint8Array) {}

  // Keeps at least `need` bits buffered. Capped at 16 per call so `acc` never
  // reaches bit 31, where the sign would leak into the mask below.
  private refill(need: number): void {
    while (this.nbits < need) {
      if (this.pos >= this.src.length) fail('unexpected end of stream')
      this.acc |= this.src[this.pos++]! << this.nbits
      this.nbits += 8
    }
  }

  // Same, but tolerates running out: decoding a short final code only needs
  // the bits that exist, and the length check afterwards catches a real
  // truncation.
  private refillSoft(need: number): void {
    while (this.nbits < need && this.pos < this.src.length) {
      this.acc |= this.src[this.pos++]! << this.nbits
      this.nbits += 8
    }
  }

  bits(n: number): number {
    if (n === 0) return 0
    this.refill(n)
    const v = this.acc & ((1 << n) - 1)
    this.acc >>>= n
    this.nbits -= n
    return v
  }

  symbol(h: Huff): number {
    this.refillSoft(FAST_BITS)
    const entry = h.fast[this.acc & FAST_MASK]!
    if (entry >= 0) {
      const len = entry >>> 16
      if (len > this.nbits) fail('unexpected end of stream')
      this.acc >>>= len
      this.nbits -= len
      return entry & 0xFFFF
    }
    return this.slowSymbol(h)
  }

  // Codes longer than the fast table walk RFC 1951's canonical algorithm,
  // tracking the first code and first symbol index at each length.
  private slowSymbol(h: Huff): number {
    let code = 0, first = 0, index = 0
    for (let len = 1; len <= h.max; len++) {
      code |= this.bits(1)
      const count = h.counts[len]!
      if (code - first < count) return h.symbols[index + (code - first)]!
      index += count
      first = (first + count) << 1
      code <<= 1
    }
    return fail('invalid Huffman symbol')
  }

  alignToByte(): void {
    const drop = this.nbits & 7
    this.acc >>>= drop
    this.nbits -= drop
  }

  // Whole buffered bytes have been read from `src` but not consumed, so they
  // come back off the position.
  get offset(): number { return this.pos - (this.nbits >> 3) }

  takeBytes(n: number): Uint8Array {
    this.alignToByte()
    const start = this.pos - (this.nbits >> 3)
    this.acc = 0
    this.nbits = 0
    if (start + n > this.src.length) fail('unexpected end of stored block')
    this.pos = start + n
    return this.src.subarray(start, start + n)
  }
}

// Output sink. When the caller supplies `cap` the size is known exactly and no
// growth is allowed: a stream claiming more is corrupt or hostile, and the PNG
// path depends on that being an error rather than an allocation.
class Sink {
  buf: Uint8Array
  len = 0
  private readonly fixed: boolean

  constructor(cap: Uint8Array | undefined, hint: number) {
    this.fixed = cap !== undefined
    this.buf = cap ?? new Uint8Array(Math.max(hint, 64))
  }

  private room(n: number): void {
    if (this.len + n <= this.buf.length) return
    if (this.fixed) fail('output exceeds the provided buffer')
    let size = this.buf.length
    while (size < this.len + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  push(b: number): void { this.room(1); this.buf[this.len++] = b }

  pushBytes(src: Uint8Array): void {
    this.room(src.length)
    this.buf.set(src, this.len)
    this.len += src.length
  }

  // Overlapping copies are the normal case in LZ77 (a run of one byte is
  // encoded as distance 1, length n), so this must copy byte by byte forward.
  copyBack(dist: number, len: number): void {
    if (dist > this.len) fail('distance beyond start of output')
    this.room(len)
    let from = this.len - dist
    for (let i = 0; i < len; i++) this.buf[this.len++] = this.buf[from++]!
  }

  result(): Uint8Array {
    return this.len === this.buf.length ? this.buf : this.buf.subarray(0, this.len)
  }
}

let FIXED_LIT: Huff | null = null
let FIXED_DIST: Huff | null = null

function fixedTables(): [Huff, Huff] {
  if (!FIXED_LIT || !FIXED_DIST) {
    const lit = new Uint8Array(288)
    lit.fill(8, 0, 144); lit.fill(9, 144, 256); lit.fill(7, 256, 280); lit.fill(8, 280, 288)
    FIXED_LIT = buildHuff(lit, 288)
    FIXED_DIST = buildHuff(new Uint8Array(30).fill(5), 30)
  }
  return [FIXED_LIT, FIXED_DIST]
}

function readDynamicTables(br: BitReader): [Huff, Huff] {
  const hlit = br.bits(5) + 257
  const hdist = br.bits(5) + 1
  const hclen = br.bits(4) + 4

  const clens = new Uint8Array(19)
  for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]!] = br.bits(3)
  const clenHuff = buildHuff(clens, 19)

  const lengths = new Uint8Array(hlit + hdist)
  for (let i = 0; i < hlit + hdist;) {
    const sym = br.symbol(clenHuff)
    if (sym < 16) { lengths[i++] = sym; continue }

    let repeat: number, value = 0
    if (sym === 16) {
      if (i === 0) fail('repeat with no previous code length')
      value = lengths[i - 1]!
      repeat = 3 + br.bits(2)
    } else if (sym === 17) {
      repeat = 3 + br.bits(3)
    } else {
      repeat = 11 + br.bits(7)
    }
    if (i + repeat > hlit + hdist) fail('code length repeat overflows the table')
    for (let r = 0; r < repeat; r++) lengths[i++] = value
  }

  return [buildHuff(lengths.subarray(0, hlit), hlit), buildHuff(lengths.subarray(hlit), hdist)]
}

// `out`, when given, is both the destination and a hard size limit.
// The end offset is reported because index.ts needs it to find the adler32.
export function inflateRawWithEnd(src: Uint8Array, out?: Uint8Array): { bytes: Uint8Array; end: number } {
  const br = new BitReader(src)
  const sink = new Sink(out, src.length * 4)

  for (;;) {
    const final = br.bits(1)
    const type = br.bits(2)

    if (type === 0) {
      br.alignToByte()
      const len = br.bits(16)
      const nlen = br.bits(16)
      if ((len ^ 0xFFFF) !== nlen) fail('stored block length check failed')
      sink.pushBytes(br.takeBytes(len))
    } else if (type === 1 || type === 2) {
      const [lit, dist] = type === 1 ? fixedTables() : readDynamicTables(br)
      for (;;) {
        const sym = br.symbol(lit)
        if (sym < 256) { sink.push(sym); continue }
        if (sym === 256) break
        const li = sym - 257
        if (li >= LEN_BASE.length) fail('invalid length symbol')
        const length = LEN_BASE[li]! + br.bits(LEN_EXTRA[li]!)
        const dsym = br.symbol(dist)
        if (dsym >= DIST_BASE.length) fail('invalid distance symbol')
        const distance = DIST_BASE[dsym]! + br.bits(DIST_EXTRA[dsym]!)
        sink.copyBack(distance, length)
      }
    } else {
      fail('reserved block type')
    }

    if (final) break
  }

  br.alignToByte()
  return { bytes: sink.result(), end: br.offset }
}

export const inflateRaw = (src: Uint8Array, out?: Uint8Array): Uint8Array =>
  inflateRawWithEnd(src, out).bytes
