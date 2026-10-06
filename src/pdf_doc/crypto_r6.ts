import { sha256, sha384, sha512 } from './sha2.js'
import { aesCbcEncrypt, aesEcbEncryptBlock } from './aes.js'

const _te = new TextEncoder()

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

// Password preprocessing is simplified to plain UTF-8 + a 127-byte cap,
// skipping full SASLprep (RFC 4013) normalization — the spec's own
// recommendation for the general case, but overkill for this project's
// actual inputs (typically an empty user password and an auto-generated
// hex owner password, both already ASCII).
function preparePassword(pw: string): Uint8Array {
  const b = _te.encode(pw)
  return b.length > 127 ? b.slice(0, 127) : b
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

// ISO 32000-2 Algorithm 2.B, the revision-6 "hardened hash": 64+ rounds of AES, then SHA-256/384/512
// by its output, until a data-dependent stop. Rounds count from 1, as pdf.js and poppler count them;
// a reader counting from 0 (veraPDF) stops at last byte <= round - 33, never earlier, and `portable`
// says both agree. `extra`: the 48-byte U string for owner hashes, empty for the user's.
function hardenedHash(password: Uint8Array, salt: Uint8Array, extra: Uint8Array): { hash: Uint8Array; portable: boolean } {
  let k: Uint8Array = sha256(concatBytes(password, salt, extra))

  let round = 0
  let hash: Uint8Array | null = null
  for (;;) {
    const k1Unit = concatBytes(password, k, extra)
    const k1 = new Uint8Array(k1Unit.length * 64)
    for (let i = 0; i < 64; i++) k1.set(k1Unit, i * k1Unit.length)

    const aesKey = k.slice(0, 16)
    const iv     = k.slice(16, 32)
    const e = aesCbcEncrypt(aesKey, iv, k1, false)

    let sum = 0
    for (let i = 0; i < 16; i++) sum += e[i]!
    const mod3 = sum % 3
    k = mod3 === 0 ? sha256(e) : mod3 === 1 ? sha384(e) : sha512(e)

    round++
    const last = e[e.length - 1]!
    if (!hash && round >= 64 && last <= round - 32) hash = k.slice(0, 32)
    if (round >= 64 && last <= round - 33) {
      const alt = k.slice(0, 32)
      return { hash: hash!, portable: hash!.every((b, i) => b === alt[i]) }
    }
  }
}

// A fresh salt and its hash, drawn again in the ~1% of cases where readers that count rounds
// differently would compute different hashes and reject the file
function portableHash(password: Uint8Array, extra: Uint8Array): { salt: Uint8Array; hash: Uint8Array } {
  for (;;) {
    const salt = randomBytes(8)
    const { hash, portable } = hardenedHash(password, salt, extra)
    if (portable) return { salt, hash }
  }
}

export interface R6Security {
  fileKey:     Uint8Array // 32 bytes — the actual AES-256 content-encryption key
  o:           Uint8Array // 48 bytes
  u:           Uint8Array // 48 bytes
  oe:          Uint8Array // 32 bytes
  ue:          Uint8Array // 32 bytes
  perms:       Uint8Array // 16 bytes
  permissions: number
}

// ISO 32000-2 Algorithm 2.A (compute U/UE, O/OE and the file key) + the
// /Perms field (Algorithm 3.A / Table 23's own description). Unlike the R3
// handler this replaces, V5 encrypts every object with the SAME file key
// directly (no per-object MD5 derivation) — the file key only needs
// wrapping (UE/OE) so a correct password can recover it.
export function computeR6Security(userPw: string, ownerPw: string, permissions: number): R6Security {
  const userPassword  = preparePassword(userPw)
  const ownerPassword = preparePassword(ownerPw)
  const fileKey = randomBytes(32)

  const uValidation = portableHash(userPassword, new Uint8Array(0))
  const uKey        = portableHash(userPassword, new Uint8Array(0))
  const u = concatBytes(uValidation.hash, uValidation.salt, uKey.salt)
  const ue = aesCbcEncrypt(uKey.hash, new Uint8Array(16), fileKey, false)

  const oValidation = portableHash(ownerPassword, u)
  const oKey        = portableHash(ownerPassword, u)
  const o = concatBytes(oValidation.hash, oValidation.salt, oKey.salt)
  const oe = aesCbcEncrypt(oKey.hash, new Uint8Array(16), fileKey, false)

  // Algorithm 3.A: P (low-order 4 bytes, little-endian) + 0xFFFFFFFF +
  // 'T' (EncryptMetadata always true here, matching the previous R3
  // handler's behavior of encrypting the whole document) + "adb" (literal,
  // per spec) + 4 random bytes, AES-256-ECB-no-pad encrypted with the file key
  const permsBlock = new Uint8Array(16)
  new DataView(permsBlock.buffer).setUint32(0, permissions >>> 0, true)
  permsBlock[4] = 0xFF; permsBlock[5] = 0xFF; permsBlock[6] = 0xFF; permsBlock[7] = 0xFF
  permsBlock[8] = 0x54 // 'T'
  permsBlock[9] = 0x61; permsBlock[10] = 0x64; permsBlock[11] = 0x62 // "adb"
  permsBlock.set(randomBytes(4), 12)
  const perms = aesEcbEncryptBlock(fileKey, permsBlock)

  return { fileKey, o, u, oe, ue, perms, permissions }
}
