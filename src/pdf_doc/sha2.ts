// SHA-256/384/512 (FIPS 180-4), needed for the PDF 2.0 (ISO 32000-2)
// standard security handler's revision-6 "hardened hash" (Algorithm 2.B),
// which genuinely uses all three — not just SHA-256 — depending on a
// running digest byte. Constants below (H0 initial values, K round
// constants) are the first 32/64 bits of the fractional parts of the
// square/cube roots of the first N primes per the spec's own definition —
// generated via exact BigInt arithmetic and cross-checked against the
// well-known SHA-256 K table before use, rather than hand-transcribed,
// since a single wrong constant would silently produce a completely
// different (but still 32/64-byte-shaped) digest.

type State32 = [number, number, number, number, number, number, number, number]

const H256: State32 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr32(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0
}

export function sha256(data: Uint8Array): Uint8Array {
  const bitLen = BigInt(data.length) * 8n
  const padLen = ((56 - (data.length + 1) % 64) + 64) % 64
  const msg = new Uint8Array(data.length + 1 + padLen + 8)
  msg.set(data)
  msg[data.length] = 0x80
  const lenView = new DataView(msg.buffer, msg.length - 8, 8)
  lenView.setBigUint64(0, bitLen, false)

  let [h0, h1, h2, h3, h4, h5, h6, h7] = H256
  const w = new Uint32Array(64)
  const view = new DataView(msg.buffer)

  for (let base = 0; base < msg.length; base += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(base + t * 4, false)
    for (let t = 16; t < 64; t++) {
      const x15 = w[t-15]!, x2 = w[t-2]!
      const s0 = rotr32(x15, 7) ^ rotr32(x15, 18) ^ (x15 >>> 3)
      const s1 = rotr32(x2, 17) ^ rotr32(x2, 19) ^ (x2 >>> 10)
      w[t] = (w[t-16]! + s0 + w[t-7]! + s1) | 0
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7
    for (let t = 0; t < 64; t++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + K256[t]! + w[t]!) | 0
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      hh = g; g = f; f = e; e = (d + t1) | 0
      d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (const [i, v] of [h0, h1, h2, h3, h4, h5, h6, h7].entries()) {
    outView.setUint32(i * 4, v >>> 0, false)
  }
  return out
}

type State64 = [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]

const H512: State64 = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
]

const H384: State64 = [
  0xcbbb9d5dc1059ed8n, 0x629a292a367cd507n, 0x9159015a3070dd17n, 0x152fecd8f70e5939n,
  0x67332667ffc00b31n, 0x8eb44a8768581511n, 0xdb0c2e0d64f98fa7n, 0x47b5481dbefa4fa4n,
]

const K512 = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
]

// The 64-bit words run as hi/lo 32-bit halves: BigInt arithmetic was ~20x slower, and the
// R6 hardened hash calls this at least 128 times per document. Constants stay BigInt above.
const K_HI = Int32Array.from(K512, k => Number(k >> 32n))
const K_LO = Int32Array.from(K512, k => Number(k & 0xffffffffn))
const TWO32 = 4294967296

// shared by SHA-512 and SHA-384 — same compression function, only the
// initial hash value and output truncation differ (FIPS 180-4 §5.3.4)
function sha512Core(data: Uint8Array, init: State64, outLen: number): Uint8Array {
  const padLen = ((112 - (data.length + 1) % 128) + 128) % 128
  const msg = new Uint8Array(data.length + 1 + padLen + 16)
  msg.set(data)
  msg[data.length] = 0x80
  // length is a 128-bit big-endian bit count; our inputs never approach 2^53 bits
  const view = new DataView(msg.buffer)
  const bits = data.length * 8
  view.setUint32(msg.length - 8, Math.floor(bits / TWO32), false)
  view.setUint32(msg.length - 4, bits >>> 0, false)

  const H = new Int32Array(16)
  for (const [i, v] of init.entries()) { H[2 * i] = Number(v >> 32n); H[2 * i + 1] = Number(v & 0xffffffffn) }
  const W = new Int32Array(160)

  for (let base = 0; base < msg.length; base += 128) {
    for (let t = 0; t < 32; t++) W[t] = view.getInt32(base + t * 4, false)
    for (let t = 16; t < 80; t++) {
      const xh = W[2 * (t - 15)]!, xl = W[2 * (t - 15) + 1]!
      const yh = W[2 * (t - 2)]!, yl = W[2 * (t - 2) + 1]!
      // σ0 = rotr1 ^ rotr8 ^ shr7, σ1 = rotr19 ^ rotr61 ^ shr6
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7)
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25))
      const s1h = ((yh >>> 19) | (yl << 13)) ^ ((yl >>> 29) | (yh << 3)) ^ (yh >>> 6)
      const s1l = ((yl >>> 19) | (yh << 13)) ^ ((yh >>> 29) | (yl << 3)) ^ ((yl >>> 6) | (yh << 26))
      const lo = (W[2 * (t - 16) + 1]! >>> 0) + (s0l >>> 0) + (W[2 * (t - 7) + 1]! >>> 0) + (s1l >>> 0)
      W[2 * t] = W[2 * (t - 16)]! + s0h + W[2 * (t - 7)]! + s1h + Math.floor(lo / TWO32)
      W[2 * t + 1] = lo
    }

    let ah = H[0]!, al = H[1]!, bh = H[2]!, bl = H[3]!, ch = H[4]!, cl = H[5]!, dh = H[6]!, dl = H[7]!
    let eh = H[8]!, el = H[9]!, fh = H[10]!, fl = H[11]!, gh = H[12]!, gl = H[13]!, hh = H[14]!, hl = H[15]!
    for (let t = 0; t < 80; t++) {
      // Σ1(e) = rotr14 ^ rotr18 ^ rotr41, Σ0(a) = rotr28 ^ rotr34 ^ rotr39
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23))
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23))
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl)
      // low halves sum as unsigned doubles; whatever passes 2^32 carries into the high half
      const t1x = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K_LO[t]! >>> 0) + (W[2 * t + 1]! >>> 0)
      const t1h = (hh + S1h + chh + K_HI[t]! + W[2 * t]! + Math.floor(t1x / TWO32)) | 0, t1l = t1x >>> 0
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25))
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25))
      const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch), majl = (al & bl) ^ (al & cl) ^ (bl & cl)
      const t2x = (S0l >>> 0) + (majl >>> 0)
      const t2h = (S0h + majh + Math.floor(t2x / TWO32)) | 0, t2l = t2x >>> 0
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el
      const ex = (dl >>> 0) + t1l
      eh = (dh + t1h + Math.floor(ex / TWO32)) | 0; el = ex | 0
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al
      const ax = t1l + t2l
      ah = (t1h + t2h + Math.floor(ax / TWO32)) | 0; al = ax | 0
    }
    const add = (i: number, h: number, l: number) => {
      const lo = (H[i + 1]! >>> 0) + (l >>> 0)
      H[i] = H[i]! + h + Math.floor(lo / TWO32); H[i + 1] = lo
    }
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl)
    add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl)
  }

  const out = new Uint8Array(64)
  const ov = new DataView(out.buffer)
  for (let i = 0; i < 16; i++) ov.setInt32(i * 4, H[i]!, false)
  return out.subarray(0, outLen)
}

export function sha512(data: Uint8Array): Uint8Array {
  return sha512Core(data, H512, 64)
}

// truncated to the first 384 of 512 bits (first 6 of 8 words) per spec
export function sha384(data: Uint8Array): Uint8Array {
  return sha512Core(data, H384, 48)
}
