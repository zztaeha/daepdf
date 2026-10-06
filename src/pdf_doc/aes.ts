// AES-128/256 (FIPS 197), encrypt-only — this codebase only ever ENCRYPTS
// (writing PDFs; a reader decrypts), including the PDF 2.0 R6 "hardened
// hash" (Algorithm 2.B), which needs an internal AES-128-CBC encrypt step.
// The S-box is derived from its GF(2^8) definition (multiplicative inverse
// + affine transform) rather than hand-transcribed, for the same reason
// the sha2.ts constants are derived: a single wrong byte in a 256-entry
// table would be effectively unfindable by inspection, only by a failing
// known-answer test — so it's generated from the algorithm's own
// definition and verified against FIPS-197 test vectors instead.

function gmul(a: number, b: number): number {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const hi = a & 0x80
    a = (a << 1) & 0xff
    if (hi) a ^= 0x1b
    b >>= 1
  }
  return p
}

function gf256Inverse(a: number): number {
  if (a === 0) return 0
  for (let x = 1; x < 256; x++) if (gmul(a, x) === 1) return x
  return 0
}

function affineTransform(b: number): number {
  let out = 0
  for (let i = 0; i < 8; i++) {
    const bit = ((b >> i) & 1) ^ ((b >> ((i+4)%8)) & 1) ^ ((b >> ((i+5)%8)) & 1)
              ^ ((b >> ((i+6)%8)) & 1) ^ ((b >> ((i+7)%8)) & 1) ^ ((0x63 >> i) & 1)
    out |= bit << i
  }
  return out
}

const SBOX = new Uint8Array(256)
for (let i = 0; i < 256; i++) SBOX[i] = affineTransform(gf256Inverse(i))

// Rcon[i] = 2^(i-1) in GF(2^8), 1-indexed; AES-256's 14-round key schedule
// needs up to Rcon[7]
const RCON = new Uint8Array(15)
{
  let r = 1
  for (let i = 1; i <= 14; i++) { RCON[i] = r; r = gmul(r, 2) }
}

const sbox = (b: number): number => SBOX[b & 0xff]!

function subWord(w: number): number {
  return (sbox(w >>> 24) << 24) | (sbox(w >>> 16) << 16)
       | (sbox(w >>> 8) << 8) | sbox(w)
}

function rotWord(w: number): number {
  return ((w << 8) | (w >>> 24)) >>> 0
}

// Nk = key length in 32-bit words (4 for AES-128, 8 for AES-256); Nr =
// number of rounds (10 / 14). Returns Nb*(Nr+1) = 4*(Nr+1) round-key words.
function keyExpansion(key: Uint8Array, nk: number, nr: number): Uint32Array {
  const nb = 4
  const w = new Uint32Array(nb * (nr + 1))
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength)
  for (let i = 0; i < nk; i++) w[i] = view.getUint32(i * 4, false)
  for (let i = nk; i < w.length; i++) {
    let temp = w[i - 1]!
    if (i % nk === 0) {
      temp = (subWord(rotWord(temp)) ^ (RCON[i / nk]! << 24)) >>> 0
    } else if (nk > 6 && i % nk === 4) {
      temp = subWord(temp)
    }
    w[i] = (w[i - nk]! ^ temp) >>> 0
  }
  return w
}

// T-tables fold SubBytes, ShiftRows and MixColumns into four lookups per column: TE0[x] is
// the column (2·S[x], S[x], S[x], 3·S[x]) as a big-endian word, TE1..TE3 its byte rotations
const xtime = (b: number): number => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff
const TE0 = new Uint32Array(256), TE1 = new Uint32Array(256), TE2 = new Uint32Array(256), TE3 = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  const s = SBOX[i]!, s2 = xtime(s)
  const t = ((s2 << 24) | (s << 16) | (s << 8) | (s2 ^ s)) >>> 0
  TE0[i] = t
  TE1[i] = ((t >>> 8) | (t << 24)) >>> 0
  TE2[i] = ((t >>> 16) | (t << 16)) >>> 0
  TE3[i] = ((t >>> 24) | (t << 8)) >>> 0
}

const be32 = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
function putBe32(b: Uint8Array, o: number, v: number): void {
  b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff
}

// One block in place in `s` (four big-endian column words), FIPS-197 §5.1 via the T-tables
function encryptWords(s: Uint32Array, w: Uint32Array, nr: number): void {
  let s0 = s[0]! ^ w[0]!, s1 = s[1]! ^ w[1]!, s2 = s[2]! ^ w[2]!, s3 = s[3]! ^ w[3]!
  let k = 4
  for (let round = 1; round < nr; round++, k += 4) {
    const t0 = TE0[s0 >>> 24]! ^ TE1[(s1 >>> 16) & 0xff]! ^ TE2[(s2 >>> 8) & 0xff]! ^ TE3[s3 & 0xff]! ^ w[k]!
    const t1 = TE0[s1 >>> 24]! ^ TE1[(s2 >>> 16) & 0xff]! ^ TE2[(s3 >>> 8) & 0xff]! ^ TE3[s0 & 0xff]! ^ w[k + 1]!
    const t2 = TE0[s2 >>> 24]! ^ TE1[(s3 >>> 16) & 0xff]! ^ TE2[(s0 >>> 8) & 0xff]! ^ TE3[s1 & 0xff]! ^ w[k + 2]!
    const t3 = TE0[s3 >>> 24]! ^ TE1[(s0 >>> 16) & 0xff]! ^ TE2[(s1 >>> 8) & 0xff]! ^ TE3[s2 & 0xff]! ^ w[k + 3]!
    s0 = t0; s1 = t1; s2 = t2; s3 = t3
  }
  s[0] = lastRound(s0, s1, s2, s3, w[k]!)
  s[1] = lastRound(s1, s2, s3, s0, w[k + 1]!)
  s[2] = lastRound(s2, s3, s0, s1, w[k + 2]!)
  s[3] = lastRound(s3, s0, s1, s2, w[k + 3]!)
}

// the final round: SubBytes and ShiftRows only, no MixColumns
function lastRound(a: number, b: number, c: number, d: number, rk: number): number {
  return (((SBOX[a >>> 24]! << 24) | (SBOX[(b >>> 16) & 0xff]! << 16) | (SBOX[(c >>> 8) & 0xff]! << 8) | SBOX[d & 0xff]!) ^ rk) >>> 0
}

// keyExpansion is expensive (SBOX lookups + XORs across up to 60 words for
// AES-256) and depends only on the key — every call site in this file
// re-encrypts many blocks under the SAME key (aesCbcEncrypt's per-block
// loop, or repeated single-block calls with the same document key), so the
// schedule is cached by key identity rather than recomputed per block.
let cachedKey: Uint8Array | null = null
let cachedSchedule: Uint32Array | null = null
let cachedNr = 0

function scheduleFor(key: Uint8Array): { w: Uint32Array; nr: number } {
  if (cachedKey !== key) {
    const nk = key.length / 4
    cachedNr = nk + 6
    cachedSchedule = keyExpansion(key, nk, cachedNr)
    cachedKey = key
  }
  return { w: cachedSchedule!, nr: cachedNr }
}

// PKCS#7 padding (PDF spec Algorithm 8) — always adds a full block of
// padding when data is already block-aligned, per spec (not an optimization
// to skip it in that case)
function pkcs7Pad(data: Uint8Array): Uint8Array {
  const padLen = 16 - (data.length % 16)
  const out = new Uint8Array(data.length + padLen)
  out.set(data)
  out.fill(padLen, data.length)
  return out
}

export function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array, pad: boolean): Uint8Array {
  const input = pad ? pkcs7Pad(data) : data
  const out = new Uint8Array(input.length)
  const { w, nr } = scheduleFor(key)
  const s = new Uint32Array([be32(iv, 0), be32(iv, 4), be32(iv, 8), be32(iv, 12)])
  for (let off = 0; off + 16 <= input.length; off += 16) {
    for (let c = 0; c < 4; c++) s[c] = (s[c]! ^ be32(input, off + c * 4)) >>> 0
    encryptWords(s, w, nr)
    for (let c = 0; c < 4; c++) putBe32(out, off + c * 4, s[c]!)
  }
  return out
}

// ECB, single block, no padding — only used for the PDF R6 /Perms field
// (Algorithm 3.A), which is exactly one 16-byte block by spec
export function aesEcbEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  const { w, nr } = scheduleFor(key)
  const s = new Uint32Array([be32(block, 0), be32(block, 4), be32(block, 8), be32(block, 12)])
  encryptWords(s, w, nr)
  const out = new Uint8Array(16)
  for (let c = 0; c < 4; c++) putBe32(out, c * 4, s[c]!)
  return out
}
