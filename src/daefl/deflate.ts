// DEFLATE compression (RFC 1951). Emits a raw deflate stream; the zlib header
// and adler32 are added in index.ts.
//
// Deterministic by construction: no randomness, no time or size heuristics
// beyond the input itself, and every tie broken by symbol order. The same
// bytes in always produce the same bytes out, which daepdf's output
// determinism tests rely on.

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
const CLEN_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15])

const MIN_MATCH = 3
const MAX_MATCH = 258
const WINDOW = 32768
const HASH_BITS = 15
const HASH_SIZE = 1 << HASH_BITS

// Per level: how far down a hash chain to walk, and the match length that
// ends the search early. Level 0 is stored-only. Measured rather than copied:
// a shallow chain was costing ~5% on run-heavy input, and going deeper than
// 2048 at level 6 buys nothing while still costing time.
const CHAIN = new Uint16Array([0, 8, 32, 128, 512, 1024, 2048, 4096, 8192, 32768])
// NICE ends the search outright. GOOD shortens what is left of it, which was
// measured as a bad trade from level 6 up: it cost more ratio than it saved
// time, so it only applies to the levels that are explicitly chasing speed.
const NICE = new Uint16Array([0, 8, 16, 32, 64, 128, 258, 258, 258, 258])
const GOOD = new Uint16Array([0, 4, 8, 16, 32, 64, 258, 258, 258, 258])

// Direct lookups. These run once per emitted match, so a 29-step scan each
// time showed up as real time on font-sized input.
const LEN_CODE = new Uint8Array(259)
for (let len = 3, code = 0; len <= 258; len++) {
  while (code < 28 && len >= LEN_BASE[code + 1]!) code++
  LEN_CODE[len] = code
}

// Distances span 1..32768, so the table is split: exact for the low 256 and
// indexed by dist >> 7 above that.
const DIST_CODE_LOW = new Uint8Array(256)
const DIST_CODE_HIGH = new Uint8Array(256)
for (let d = 1, code = 0; d <= 256; d++) {
  while (code < 29 && d >= DIST_BASE[code + 1]!) code++
  DIST_CODE_LOW[d - 1] = code
}
for (let d = 257, code = 15; d <= 32768; d++) {
  while (code < 29 && d >= DIST_BASE[code + 1]!) code++
  DIST_CODE_HIGH[(d - 1) >> 7] = code
}

const lenCode = (len: number): number => LEN_CODE[len]!
const distCode = (dist: number): number =>
  dist <= 256 ? DIST_CODE_LOW[dist - 1]! : DIST_CODE_HIGH[(dist - 1) >> 7]!

class BitWriter {
  private buf = new Uint8Array(1024)
  private len = 0
  private acc = 0
  private nbits = 0

  private room(n: number): void {
    if (this.len + n <= this.buf.length) return
    let size = this.buf.length
    while (size < this.len + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  // DEFLATE packs bits least-significant-first within each byte.
  write(value: number, bits: number): void {
    this.acc |= value << this.nbits
    this.nbits += bits
    while (this.nbits >= 8) {
      this.room(1)
      this.buf[this.len++] = this.acc & 0xFF
      this.acc >>>= 8
      this.nbits -= 8
    }
  }

  // Codes arrive already reversed from assignCodes, so emitting one is just a
  // write. Reversing per symbol here was the single largest cost in encoding.
  writeCode(code: number, bits: number): void { this.write(code, bits) }

  alignToByte(): void {
    if (this.nbits > 0) {
      this.room(1)
      this.buf[this.len++] = this.acc & 0xFF
      this.acc = 0
      this.nbits = 0
    }
  }

  writeBytes(src: Uint8Array): void {
    this.room(src.length)
    this.buf.set(src, this.len)
    this.len += src.length
  }

  result(): Uint8Array {
    this.alignToByte()
    return this.buf.subarray(0, this.len)
  }
}

interface Codes { lengths: Uint8Array; codes: Uint16Array }

// Canonical Huffman code lengths from symbol frequencies, capped at maxBits.
// Builds an optimal tree first, then flattens any over-long branches the way
// zlib does: move the deepest leaves up and pay for it with shallower ones.
function buildCodes(freqs: Uint32Array, maxBits: number): Codes {
  const n = freqs.length
  const lengths = new Uint8Array(n)

  const used: number[] = []
  for (let i = 0; i < n; i++) if (freqs[i]! > 0) used.push(i)

  // Fewer than two used symbols still needs a valid code, or the decoder sees
  // an incomplete tree. Give one or two symbols a single bit each.
  if (used.length === 0) return { lengths, codes: new Uint16Array(n) }
  if (used.length === 1) {
    lengths[used[0]!] = 1
    return { lengths, codes: assignCodes(lengths, maxBits) }
  }

  // Node arrays rather than objects: parent[] links, depth computed after.
  const maxNodes = used.length * 2 - 1
  const nodeFreq = new Uint32Array(maxNodes)
  const nodeLeft = new Int32Array(maxNodes).fill(-1)
  const nodeRight = new Int32Array(maxNodes).fill(-1)
  const nodeSym = new Int32Array(maxNodes).fill(-1)

  let count = 0
  for (const s of used) { nodeFreq[count] = freqs[s]!; nodeSym[count] = s; count++ }

  // Binary min-heap over node indices. Ties break on the lower index, which is
  // what keeps the tree — and therefore the output bytes — deterministic.
  const heap = new Int32Array(maxNodes + 1)
  let hn = 0
  const less = (x: number, y: number): boolean =>
    nodeFreq[x]! !== nodeFreq[y]! ? nodeFreq[x]! < nodeFreq[y]! : x < y

  const up = (start: number): void => {
    let c = start
    while (c > 1 && less(heap[c]!, heap[c >> 1]!)) {
      const t = heap[c]!; heap[c] = heap[c >> 1]!; heap[c >> 1] = t
      c >>= 1
    }
  }
  const down = (start: number): void => {
    let parent = start
    for (;;) {
      let best = parent
      const l = parent << 1, r = l + 1
      if (l <= hn && less(heap[l]!, heap[best]!)) best = l
      if (r <= hn && less(heap[r]!, heap[best]!)) best = r
      if (best === parent) return
      const t = heap[parent]!; heap[parent] = heap[best]!; heap[best] = t
      parent = best
    }
  }
  const push = (node: number): void => { heap[++hn] = node; up(hn) }
  const pop = (): number => {
    const top = heap[1]!
    heap[1] = heap[hn--]!
    if (hn > 0) down(1)
    return top
  }

  for (let i = 0; i < count; i++) push(i)

  // Counted rather than reading the heap size directly: `hn` is mutated inside
  // push/pop, which a linter reading only this scope cannot follow.
  let alive = count
  while (alive > 1) {
    const a = pop()
    const b = pop()
    nodeFreq[count] = nodeFreq[a]! + nodeFreq[b]!
    nodeLeft[count] = a
    nodeRight[count] = b
    push(count)
    count++
    alive--
  }

  const root = count - 1
  const depth = new Int32Array(count)
  const stack = [root]
  depth[root] = 0
  while (stack.length) {
    const node = stack.pop()!
    const l = nodeLeft[node]!, r = nodeRight[node]!
    if (l < 0) { lengths[nodeSym[node]!] = Math.max(1, depth[node]!); continue }
    depth[l] = depth[node]! + 1
    depth[r] = depth[node]! + 1
    stack.push(l, r)
  }

  limitLengths(lengths, used, maxBits)
  return { lengths, codes: assignCodes(lengths, maxBits) }
}

// Kraft-sum repair: while the code is over-subscribed because something is
// longer than maxBits, shorten the worst offender and lengthen the shallowest
// symbol that can afford it. Terminates because each pass strictly reduces the
// number of over-long codes.
function limitLengths(lengths: Uint8Array, used: number[], maxBits: number): void {
  let over = false
  for (const s of used) if (lengths[s]! > maxBits) { over = true; break }
  if (!over) return

  for (const s of used) if (lengths[s]! > maxBits) lengths[s] = maxBits

  // Kraft sum in units of 2^-maxBits; must end at exactly 2^maxBits.
  const total = 1 << maxBits
  let sum = 0
  for (const s of used) sum += total >> lengths[s]!

  // Over-subscribed: lengthen shallow symbols, deepest-first by index order.
  while (sum > total) {
    let pick = -1
    for (const s of used) {
      if (lengths[s]! >= maxBits) continue
      if (pick < 0 || lengths[s]! > lengths[pick]!) pick = s
    }
    if (pick < 0) break
    sum -= total >> lengths[pick]!
    lengths[pick] = lengths[pick]! + 1
    sum += total >> lengths[pick]!
  }

  // Under-subscribed after the repair wastes code space; shorten where it is
  // free to do so, which keeps the tree complete.
  for (;;) {
    let pick = -1
    for (const s of used) {
      if (lengths[s]! <= 1) continue
      const gain = (total >> (lengths[s]! - 1)) - (total >> lengths[s]!)
      if (sum + gain <= total && (pick < 0 || lengths[s]! > lengths[pick]!)) pick = s
    }
    if (pick < 0) break
    sum += (total >> (lengths[pick]! - 1)) - (total >> lengths[pick]!)
    lengths[pick] = lengths[pick]! - 1
  }
}

function assignCodes(lengths: Uint8Array, maxBits: number): Uint16Array {
  const counts = new Uint16Array(maxBits + 1)
  for (const l of lengths) if (l) counts[l] = counts[l]! + 1

  const nextCode = new Uint16Array(maxBits + 2)
  let code = 0
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + counts[bits - 1]!) << 1
    nextCode[bits] = code
  }

  // Stored reversed: DEFLATE writes Huffman codes most-significant-bit-first
  // while every other field is least-significant-first, and doing the reversal
  // once per symbol here beats doing it once per occurrence at write time.
  const codes = new Uint16Array(lengths.length)
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i]!
    if (!l) continue
    const c = nextCode[l]!
    nextCode[l] = c + 1
    let rev = 0
    for (let b = 0; b < l; b++) rev |= ((c >> (l - 1 - b)) & 1) << b
    codes[i] = rev
  }
  return codes
}

// Run-length encodes the two code-length tables into the 19-symbol alphabet
// that precedes them in a dynamic block.
function packCodeLengths(all: Uint8Array): { syms: number[]; extra: number[]; freqs: Uint32Array } {
  const syms: number[] = []
  const extra: number[] = []
  const freqs = new Uint32Array(19)
  const push = (s: number, e = 0, eb = 0): void => {
    syms.push(s); extra.push(e | (eb << 8)); freqs[s] = freqs[s]! + 1
  }

  for (let i = 0; i < all.length;) {
    const value = all[i]!
    let run = 1
    while (i + run < all.length && all[i + run] === value) run++

    if (value === 0) {
      while (run >= 3) {
        const n = Math.min(run, 138)
        if (n <= 10) push(17, n - 3, 3)
        else push(18, n - 11, 7)
        i += n; run -= n
      }
    } else {
      push(value)
      i++; run--
      while (run >= 3) {
        const n = Math.min(run, 6)
        push(16, n - 3, 2)
        i += n; run -= n
      }
    }
    for (let r = 0; r < run; r++) { push(value); i++ }
  }
  return { syms, extra, freqs }
}

interface Block { lits: Uint16Array; dists: Uint16Array; count: number }

function emitStored(bw: BitWriter, data: Uint8Array, from: number, to: number, final: boolean): void {
  bw.write(final ? 1 : 0, 1)
  bw.write(0, 2)
  bw.alignToByte()
  const len = to - from
  bw.write(len & 0xFF, 8); bw.write((len >> 8) & 0xFF, 8)
  bw.write(~len & 0xFF, 8); bw.write((~len >> 8) & 0xFF, 8)
  bw.writeBytes(data.subarray(from, to))
}

interface Plan {
  lit: Codes
  dist: Codes
  clen: Codes
  packed: { syms: number[]; extra: number[]; freqs: Uint32Array }
  hlit: number
  hdist: number
  hclen: number
  bits: number
}

// Builds the trees for a block and prices the result, without writing
// anything. Pricing analytically is what lets flush() choose between stored,
// fixed and dynamic without encoding each one to find out.
function planDynamic(block: Block): Plan {
  const litFreq = new Uint32Array(286)
  const distFreq = new Uint32Array(30)
  litFreq[256] = 1

  for (let i = 0; i < block.count; i++) {
    const d = block.dists[i]!
    if (d === 0) { const l = block.lits[i]!; litFreq[l] = litFreq[l]! + 1 }
    else {
      const lc = lenCode(block.lits[i]!)
      litFreq[257 + lc] = litFreq[257 + lc]! + 1
      const dc = distCode(d)
      distFreq[dc] = distFreq[dc]! + 1
    }
  }

  const lit = buildCodes(litFreq, 15)
  const dist = buildCodes(distFreq, 15)

  let hlit = 286
  while (hlit > 257 && lit.lengths[hlit - 1] === 0) hlit--
  let hdist = 30
  while (hdist > 1 && dist.lengths[hdist - 1] === 0) hdist--

  const all = new Uint8Array(hlit + hdist)
  all.set(lit.lengths.subarray(0, hlit), 0)
  all.set(dist.lengths.subarray(0, hdist), hlit)
  const packed = packCodeLengths(all)
  const clen = buildCodes(packed.freqs, 7)

  let hclen = 19
  while (hclen > 4 && clen.lengths[CLEN_ORDER[hclen - 1]!] === 0) hclen--

  let bits = 3 + 5 + 5 + 4 + hclen * 3
  for (let i = 0; i < packed.syms.length; i++) {
    const sym = packed.syms[i]!
    bits += clen.lengths[sym]! + (packed.extra[i]! >> 8)
  }
  for (let i = 0; i < 286; i++) if (litFreq[i]!) bits += litFreq[i]! * lit.lengths[i]!
  for (let i = 0; i < 30; i++) if (distFreq[i]!) bits += distFreq[i]! * dist.lengths[i]!
  for (let i = 0; i < block.count; i++) {
    if (block.dists[i] === 0) continue
    bits += LEN_EXTRA[lenCode(block.lits[i]!)]! + DIST_EXTRA[distCode(block.dists[i]!)]!
  }

  return { lit, dist, clen, packed, hlit, hdist, hclen, bits }
}

// The fixed tables cost nothing to transmit, which wins on short blocks.
function fixedCost(block: Block): number {
  let bits = 3 + 7
  for (let i = 0; i < block.count; i++) {
    const d = block.dists[i]!
    if (d === 0) {
      const l = block.lits[i]!
      bits += l < 144 ? 8 : l < 256 ? 9 : 0
    } else {
      const lc = lenCode(block.lits[i]!)
      bits += (257 + lc < 280 ? 7 : 8) + LEN_EXTRA[lc]!
      bits += 5 + DIST_EXTRA[distCode(d)]!
    }
  }
  return bits
}

function emitSymbols(bw: BitWriter, block: Block, lit: Codes, dist: Codes): void {
  for (let i = 0; i < block.count; i++) {
    const d = block.dists[i]!
    if (d === 0) {
      const l = block.lits[i]!
      bw.writeCode(lit.codes[l]!, lit.lengths[l]!)
    } else {
      const len = block.lits[i]!
      const lc = lenCode(len)
      bw.writeCode(lit.codes[257 + lc]!, lit.lengths[257 + lc]!)
      if (LEN_EXTRA[lc]!) bw.write(len - LEN_BASE[lc]!, LEN_EXTRA[lc])
      const dc = distCode(d)
      bw.writeCode(dist.codes[dc]!, dist.lengths[dc]!)
      if (DIST_EXTRA[dc]!) bw.write(d - DIST_BASE[dc]!, DIST_EXTRA[dc])
    }
  }
  bw.writeCode(lit.codes[256]!, lit.lengths[256]!)
}

function emitDynamic(bw: BitWriter, block: Block, plan: Plan, final: boolean): void {
  bw.write(final ? 1 : 0, 1)
  bw.write(2, 2)
  bw.write(plan.hlit - 257, 5)
  bw.write(plan.hdist - 1, 5)
  bw.write(plan.hclen - 4, 4)
  for (let i = 0; i < plan.hclen; i++) bw.write(plan.clen.lengths[CLEN_ORDER[i]!]!, 3)

  for (let i = 0; i < plan.packed.syms.length; i++) {
    const sym = plan.packed.syms[i]!
    bw.writeCode(plan.clen.codes[sym]!, plan.clen.lengths[sym]!)
    const e = plan.packed.extra[i]!
    const bits = e >> 8
    if (bits) bw.write(e & 0xFF, bits)
  }

  emitSymbols(bw, block, plan.lit, plan.dist)
}

let FIXED: { lit: Codes; dist: Codes } | null = null
function fixedCodes(): { lit: Codes; dist: Codes } {
  if (!FIXED) {
    const ll = new Uint8Array(288)
    ll.fill(8, 0, 144); ll.fill(9, 144, 256); ll.fill(7, 256, 280); ll.fill(8, 280, 288)
    const dl = new Uint8Array(30).fill(5)
    FIXED = {
      lit:  { lengths: ll, codes: assignCodes(ll, 15) },
      dist: { lengths: dl, codes: assignCodes(dl, 15) },
    }
  }
  return FIXED
}

function emitFixed(bw: BitWriter, block: Block, final: boolean): void {
  bw.write(final ? 1 : 0, 1)
  bw.write(1, 2)
  const { lit, dist } = fixedCodes()
  emitSymbols(bw, block, lit, dist)
}

export function deflateRaw(data: Uint8Array, level = 6): Uint8Array {
  const bw = new BitWriter()

  if (data.length === 0) {
    // An empty input still needs a valid final block.
    bw.write(1, 1); bw.write(1, 2)
    bw.writeCode(0, 7) // end-of-block in the fixed table
    return bw.result()
  }

  const lvl = Math.max(0, Math.min(9, level | 0))
  if (lvl === 0) {
    for (let i = 0; i < data.length; i += 65535) {
      const end = Math.min(i + 65535, data.length)
      emitStored(bw, data, i, end, end === data.length)
    }
    return bw.result()
  }

  const chain = CHAIN[lvl]!
  const nice = NICE[lvl]!
  const good = GOOD[lvl]!

  const head = new Int32Array(HASH_SIZE).fill(-1)
  const prev = new Int32Array(data.length).fill(-1)

  // A block is closed either when the buffer fills or when the symbol
  // distribution has drifted far enough that one Huffman tree no longer fits
  // both halves. Fitting one tree across a boundary is where a fixed-size
  // split loses most of its ratio on mixed content.
  const BLOCK = 1 << 14
  const CHECK_EVERY = 1 << 12
  const lits = new Uint16Array(BLOCK)
  const dists = new Uint16Array(BLOCK)
  let n = 0
  let blockStart = 0

  // Cheap stand-in for entropy: how the symbols spread across 16 buckets.
  // Comparing the recent window against the block so far detects a change of
  // regime without the cost of building trial trees.
  const histAll = new Uint32Array(16)
  const histRecent = new Uint32Array(16)
  let sinceCheck = 0

  const bucketOf = (lit: number, dist: number): number =>
    dist === 0 ? (lit >> 4) & 15 : 8 + (lenCode(lit) >> 2)

  const drifted = (): boolean => {
    let totalAll = 0, totalRecent = 0
    for (let b = 0; b < 16; b++) { totalAll += histAll[b]!; totalRecent += histRecent[b]! }
    if (totalRecent === 0 || totalAll === totalRecent) return false
    // total variation distance between the two distributions, in 1/1000ths
    let diff = 0
    for (let b = 0; b < 16; b++) {
      const a = Math.round(histAll[b]! * 1000 / totalAll)
      const r = Math.round(histRecent[b]! * 1000 / totalRecent)
      diff += Math.abs(a - r)
    }
    return diff > 600
  }

  const hashAt = (i: number): number =>
    ((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & (HASH_SIZE - 1)

  const flush = (final: boolean, pos: number): void => {
    const block: Block = { lits, dists, count: n }
    // Price all three encodings and emit only the winner. Costing them
    // analytically rather than trial-encoding is what keeps this to one pass
    // over the symbols instead of two.
    const plan = planDynamic(block)
    const dynBits = plan.bits
    const fixBits = fixedCost(block)
    const rawBits = (pos - blockStart + 5) * 8

    if (rawBits <= dynBits && rawBits <= fixBits) emitStored(bw, data, blockStart, pos, final)
    else if (fixBits <= dynBits) emitFixed(bw, block, final)
    else emitDynamic(bw, block, plan, final)
    n = 0
    blockStart = pos
    histAll.fill(0)
    histRecent.fill(0)
    sinceCheck = 0
  }

  // Finds the longest match at `at`, inserting it into the hash chain on the
  // way past. Returns length 0 when nothing usable is within the window.
  const findMatch = (at: number, startLen: number): { len: number; dist: number } => {
    let bestLen = startLen, bestDist = 0
    if (at + MIN_MATCH > data.length) return { len: 0, dist: 0 }

    const h = hashAt(at)
    let candidate = head[h]!
    let depth = chain
    const limit = Math.max(0, at - WINDOW)
    const max = Math.min(MAX_MATCH, data.length - at)

    while (candidate >= limit && candidate >= 0 && depth-- > 0) {
      // Two cheap rejections before the full compare: the byte that would
      // extend the current best, and the one before it. Most candidates die
      // here, which is what keeps a deep chain affordable.
      if (data[candidate + bestLen] === data[at + bestLen] &&
          (bestLen === 0 || data[candidate + bestLen - 1] === data[at + bestLen - 1])) {
        let l = 0
        while (l < max && data[candidate + l] === data[at + l]) l++
        if (l > bestLen) {
          bestLen = l
          bestDist = at - candidate
          if (l >= nice) break
          // Already holding a decent match: spend a quarter of the remaining
          // budget looking for a better one rather than the whole chain.
          if (l >= good) depth >>= 2
        }
      }
      candidate = prev[candidate]!
    }

    prev[at] = head[h]!
    head[h] = at
    return bestDist === 0 ? { len: 0, dist: 0 } : { len: bestLen, dist: bestDist }
  }

  let i = 0
  while (i < data.length) {
    const { len: bestLen, dist: bestDist } = findMatch(i, MIN_MATCH - 1)

    if (bestLen >= MIN_MATCH) {
      lits[n] = bestLen
      dists[n] = bestDist
      n++
      // Every position inside the match still has to enter the hash chain, or
      // later matches lose the ability to reach back into it.
      for (let k = 1; k < bestLen; k++) {
        const j = i + k
        if (j + MIN_MATCH <= data.length) {
          const h = hashAt(j)
          prev[j] = head[h]!
          head[h] = j
        }
      }
      i += bestLen
    } else {
      lits[n] = data[i]!
      dists[n] = 0
      n++
      i++
    }

    const bucket = bucketOf(lits[n - 1]!, dists[n - 1]!)
    histAll[bucket] = histAll[bucket]! + 1
    histRecent[bucket] = histRecent[bucket]! + 1

    if (n === BLOCK) {
      flush(false, i)
    } else if (++sinceCheck >= CHECK_EVERY) {
      if (n > CHECK_EVERY && drifted()) flush(false, i)
      else { histRecent.fill(0); sinceCheck = 0 }
    }
  }

  flush(true, data.length)
  return bw.result()
}
