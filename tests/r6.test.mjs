import crypto from 'node:crypto'

// A reader's side of ISO 32000-2 Algorithm 2.A, written independently here and
// using node's AES rather than the implementation under test.
// shift 1 stops the way a reader counting rounds from 0 does (veraPDF)
function makeHardenedHash(sha256, sha384, sha512) { return function hardenedHash(pw, salt, extra, shift = 0) {
  const cat = (...a) => Buffer.concat(a.map(Buffer.from))
  let k = Buffer.from(sha256(cat(pw, salt, extra)))
  let round = 0
  for (;;) {
    const unit = cat(pw, k, extra)
    const k1 = Buffer.concat(Array(64).fill(unit))
    const c = crypto.createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32))
    c.setAutoPadding(false)
    const e = Buffer.concat([c.update(k1), c.final()])
    const mod3 = e.subarray(0, 16).reduce((a, b) => a + b, 0) % 3
    k = Buffer.from(mod3 === 0 ? sha256(e) : mod3 === 1 ? sha384(e) : sha512(e))
    round++
    if (round >= 64 && e[e.length - 1] <= round - 32 - shift) break
  }
  return k.subarray(0, 32)
} }

const dec = (key, iv, data) => {
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv)
  d.setAutoPadding(false)
  return Buffer.concat([d.update(data), d.final()])
}

export default async function ({ test, eq, ok, hex, load }) {
  const { computeR6Security } = await load('src/pdf_doc/crypto_r6.ts')
  const { sha256, sha384, sha512 } = await load('src/pdf_doc/sha2.ts')
  const { aesCbcEncrypt } = await load('src/pdf_doc/aes.ts')

  const hardenedHash = makeHardenedHash(sha256, sha384, sha512)
  const userPw = '', ownerPw = 'owner-secret-123'
  const perms = -3904
  const s = computeR6Security(userPw, ownerPw, perms)

  test('U is 48 bytes, O is 48, UE/OE 32, Perms 16', () => {
    eq(s.u.length, 48); eq(s.o.length, 48)
    eq(s.ue.length, 32); eq(s.oe.length, 32)
    eq(s.perms.length, 16); eq(s.fileKey.length, 32)
  })

  test('a reader validating the user password accepts U', () => {
    const want = hardenedHash(Buffer.from(userPw), Buffer.from(s.u.subarray(32, 40)), Buffer.alloc(0))
    eq(Buffer.from(s.u.subarray(0, 32)), want, 'U validation hash')
  })

  test('a reader recovers the file key from UE', () => {
    const ik = hardenedHash(Buffer.from(userPw), Buffer.from(s.u.subarray(40, 48)), Buffer.alloc(0))
    eq(dec(ik, Buffer.alloc(16), Buffer.from(s.ue)), Buffer.from(s.fileKey), 'UE unwrap')
  })

  test('custom permissions without an owner password can\'t be lifted with an empty one', async () => {
    const { PdfDoc } = await load('tests/_entry.ts')
    const { applySecurity } = await load('src/pdf/finalize.ts')
    const d = new PdfDoc(100, 100)
    applySecurity(d, { userPassword: '', permissions: { print: false } })
    const sec = d.security
    const emptyAsOwner = hardenedHash(Buffer.alloc(0), Buffer.from(sec.o.subarray(32, 40)), Buffer.from(sec.u))
    ok(!Buffer.from(sec.o.subarray(0, 32)).equals(emptyAsOwner), 'the empty password opens the file as its owner')
  })

  test('a reader validating the owner password accepts O', () => {
    const want = hardenedHash(Buffer.from(ownerPw), Buffer.from(s.o.subarray(32, 40)), Buffer.from(s.u))
    eq(Buffer.from(s.o.subarray(0, 32)), want, 'O validation hash')
  })

  test('a reader recovers the file key from OE', () => {
    const ik = hardenedHash(Buffer.from(ownerPw), Buffer.from(s.o.subarray(40, 48)), Buffer.from(s.u))
    eq(dec(ik, Buffer.alloc(16), Buffer.from(s.oe)), Buffer.from(s.fileKey), 'OE unwrap')
  })

  // node's hashes keep the repeated recomputation below fast
  const nodeHash = makeHardenedHash(...['sha256', 'sha384', 'sha512'].map(h => b => crypto.createHash(h).update(b).digest()))
  const agrees = (pw, salt, extra) => nodeHash(pw, salt, extra).equals(nodeHash(pw, salt, extra, 1))

  test('every salt gives the same hash however a reader counts rounds', () => {
    for (let n = 0; n < 12; n++) {
      const r = computeR6Security('', 'owner', perms), u = Buffer.from(r.u)
      ok(agrees(Buffer.alloc(0), u.subarray(32, 40), Buffer.alloc(0)) && agrees(Buffer.alloc(0), u.subarray(40, 48), Buffer.alloc(0)), 'user salts')
      ok(agrees(Buffer.from('owner'), Buffer.from(r.o.subarray(32, 40)), u) && agrees(Buffer.from('owner'), Buffer.from(r.o.subarray(40, 48)), u), 'owner salts')
    }
  })

  test('a salt the two ways of counting disagree on is drawn again', () => {
    // the user validation salt of a file veraPDF rejected ("could not be processed")
    const bad = Buffer.from('b78435d877831a6c', 'hex')
    ok(!agrees(Buffer.alloc(0), bad, Buffer.alloc(0)), 'the salt really is one they disagree on')
    const web = globalThis.crypto, real = web.getRandomValues.bind(web)
    let served = false
    Object.defineProperty(web, 'getRandomValues', { configurable: true, value: arr => {
      if (!served && arr.length === 8) { served = true; arr.set(bad); return arr }
      return real(arr)
    } })
    try {
      const r = computeR6Security('', 'owner', perms)
      ok(served && !Buffer.from(r.u.subarray(32, 40)).equals(bad), 'the disagreeing salt was not kept')
    } finally { delete web.getRandomValues }
  })

  test('Perms decrypts to P + FFFFFFFF + T + adb', () => {
    const d = crypto.createDecipheriv('aes-256-ecb', Buffer.from(s.fileKey), null)
    d.setAutoPadding(false)
    const p = Buffer.concat([d.update(Buffer.from(s.perms)), d.final()])
    eq(p.readInt32LE(0), perms, 'permissions round-trip')
    eq(hex(p.subarray(4, 8)), 'ffffffff')
    eq(String.fromCharCode(...p.subarray(8, 12)), 'Tadb')
  })

  test('our AES-CBC agrees with node on the R6 wrap', () => {
    const key = crypto.randomBytes(32), iv = Buffer.alloc(16), data = crypto.randomBytes(64)
    const c = crypto.createCipheriv('aes-256-cbc', key, iv); c.setAutoPadding(false)
    eq(aesCbcEncrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(data), false),
       Buffer.concat([c.update(data), c.final()]))
  })

  test('two runs use different salts and keys', () => {
    const a = computeR6Security(userPw, ownerPw, perms)
    ok(hex(a.fileKey) !== hex(s.fileKey), 'file key must be random per document')
    ok(hex(a.u) !== hex(s.u), 'salts must be random per document')
  })
}
