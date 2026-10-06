import { sha256, sha384, sha512 } from '../src/pdf_doc/sha2.ts'
import { aesCbcEncrypt, aesEcbEncryptBlock } from '../src/pdf_doc/aes.ts'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'

export default function ({ test, eq, bytes }) {
  const utf8 = s => new TextEncoder().encode(s)

  // FIPS 180-4 / NIST published digests
  test('sha256 of "abc"', () => eq(sha256(utf8('abc')),
    bytes('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')))
  test('sha256 of empty', () => eq(sha256(new Uint8Array(0)),
    bytes('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')))
  test('sha256 448-bit message (two blocks)', () => eq(
    sha256(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')),
    bytes('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')))

  test('sha512 of "abc"', () => eq(sha512(utf8('abc')), bytes(
    'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a' +
    '2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f')))
  test('sha512 of empty', () => eq(sha512(new Uint8Array(0)), bytes(
    'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce' +
    '47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e')))
  test('sha384 of "abc"', () => eq(sha384(utf8('abc')), bytes(
    'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed' +
    '8086072ba1e7cc2358baeca134c825a7')))

  // Differential against node:crypto over every length through several blocks: off-by-ones live
  // at the padding boundaries (55/56/64 for SHA-256, 111/112/128 for SHA-512)
  const data = Uint8Array.from({ length: 300 }, (_, i) => (i * 131 + 7) & 0xFF)
  for (const [name, fn] of [['sha256', sha256], ['sha384', sha384], ['sha512', sha512]]) {
    test(`${name} matches node crypto for every length 0..300`, () => {
      for (let n = 0; n <= 300; n++) {
        const want = createHash(name).update(data.subarray(0, n)).digest()
        eq(fn(data.subarray(0, n)), want, `${name} length ${n}`)
      }
    })
  }

  test('AES-CBC matches node crypto on random keys, IVs and data', () => {
    for (let i = 0; i < 200; i++) {
      // Uint8Array copies: a Buffer's slice() is a view, not the copy the library relies on
      const rand = n => new Uint8Array(randomBytes(n))
      const key = rand(i % 2 ? 32 : 16), iv = rand(16), plain = rand(16 * (1 + (i % 9)))
      const c = createCipheriv(key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc', key, iv)
      c.setAutoPadding(false)
      eq(aesCbcEncrypt(key, iv, plain, false), Buffer.concat([c.update(plain), c.final()]), `vector ${i}`)
    }
  })

  // FIPS-197 Appendix C known-answer tests
  const pt = bytes('00112233445566778899aabbccddeeff')
  test('AES-128 ECB (FIPS-197 C.1)', () => eq(
    aesEcbEncryptBlock(bytes('000102030405060708090a0b0c0d0e0f'), pt),
    bytes('69c4e0d86a7b0430d8cdb78070b4c55a')))
  test('AES-256 ECB (FIPS-197 C.3)', () => eq(
    aesEcbEncryptBlock(bytes('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'), pt),
    bytes('8ea2b7ca516745bfeafc49904b496089')))

  // NIST SP 800-38A F.2.1 CBC-AES128
  test('AES-128 CBC (SP 800-38A F.2.1, 4 blocks, no padding)', () => eq(
    aesCbcEncrypt(bytes('2b7e151628aed2a6abf7158809cf4f3c'),
                  bytes('000102030405060708090a0b0c0d0e0f'),
                  bytes('6bc1bee22e409f96e93d7e117393172a' +
                        'ae2d8a571e03ac9c9eb76fac45af8e51' +
                        '30c81c46a35ce411e5fbc1191a0a52ef' +
                        'f69f2445df4f9b17ad2b417be66c3710'), false),
    bytes('7649abac8119b246cee98e9b12e9197d' +
          '5086cb9b507219ee95db113a917678b2' +
          '73bed6b8e3c1743b7116e69e22229516' +
          '3ff1caa1681fac09120eca307586e1a7')))

  test('PKCS#7 adds a whole block when already aligned', () => {
    const out = aesCbcEncrypt(bytes('2b7e151628aed2a6abf7158809cf4f3c'),
                              new Uint8Array(16), bytes('00'.repeat(16)), true)
    eq(out.length, 32, 'aligned input must grow by a full pad block')
  })
}
