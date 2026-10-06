import zlib from 'node:zlib'

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = buf => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function ihdr(w, h, bpc, ct, interlace = 0) {
  const b = Buffer.alloc(13)
  b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4)
  b[8] = bpc; b[9] = ct; b[10] = 0; b[11] = 0; b[12] = interlace
  return chunk('IHDR', b)
}

// raw scanlines with filter byte 0
function rawRows(w, h, chIn, fill) {
  const rowLen = w * chIn + 1
  const out = Buffer.alloc(h * rowLen)
  for (let r = 0; r < h; r++) {
    out[r * rowLen] = 0
    for (let j = 0; j < w * chIn; j++) out[r * rowLen + 1 + j] = fill(r, j)
  }
  return out
}

function png(parts) { return new Uint8Array(Buffer.concat([SIG, ...parts])) }

export default async function ({ test, eq, ok, load }) {
  const { parseImage } = await load('src/images/parse.ts')

  test('grayscale ct0 round-trips', () => {
    const raw = rawRows(4, 3, 1, (r, j) => (r * 4 + j) * 10)
    const p = parseImage(png([ihdr(4, 3, 8, 0), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
    ok(p, 'should parse'); eq(p.width, 4); eq(p.height, 3)
    eq(p.colorSpace, 'DeviceGray'); eq(p.data.length, 12); ok(p.smask === null)
    eq(p.data[0], 0); eq(p.data[5], 50)
  })

  test('RGBA ct6 splits color from alpha', () => {
    const raw = rawRows(2, 2, 4, (r, j) => (j % 4 === 3 ? 128 : j + r))
    const p = parseImage(png([ihdr(2, 2, 8, 6), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
    ok(p, 'should parse'); eq(p.data.length, 2 * 2 * 3); eq(p.smask.length, 4)
    eq(p.smask[0], 128); eq(p.smask[3], 128)
  })

  test('indexed ct3 expands through the palette', () => {
    const plte = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255])
    const raw = rawRows(3, 1, 1, (_r, j) => j % 3)
    const p = parseImage(png([ihdr(3, 1, 8, 3), chunk('PLTE', plte),
      chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
    ok(p, 'should parse'); eq([...p.data].join(','), '255,0,0,0,255,0,0,0,255')
  })

  test('indexed index beyond the palette is rejected', () => {
    const plte = Buffer.from([1, 2, 3])              // one entry
    const raw = rawRows(2, 1, 1, (_r, j) => j)       // indices 0 and 1
    const p = parseImage(png([ihdr(2, 1, 8, 3), chunk('PLTE', plte),
      chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]))
    ok(p === null, 'out-of-range palette index must not produce an image')
  })

  test('a crafted huge IHDR is refused, not allocated', () => {
    const p = parseImage(png([ihdr(0xFFFF, 0xFFFF, 8, 6),
      chunk('IDAT', zlib.deflateSync(Buffer.alloc(16))), chunk('IEND', Buffer.alloc(0))]))
    ok(p === null, 'must refuse before allocating')
  })

  // The guard under suspicion: does a stream that inflates SHORT get rejected,
  // or silently zero-filled?
  test('IDAT that inflates short of the declared size is rejected', () => {
    const full = rawRows(8, 8, 3, () => 200)
    const short = full.subarray(0, full.length - 40)   // 40 bytes missing
    const p = parseImage(png([ihdr(8, 8, 8, 2), chunk('IDAT', zlib.deflateSync(short)), chunk('IEND', Buffer.alloc(0))]))
    ok(p === null, `expected null for a short inflate, got an image of ${p && p.data.length} bytes`)
  })

  test('16-bit and interlaced fall through to the browser path', () => {
    const a = parseImage(png([ihdr(2, 2, 16, 2), chunk('IDAT', zlib.deflateSync(Buffer.alloc(26))), chunk('IEND', Buffer.alloc(0))]))
    ok(a === null, '16-bit must be declined')
    const b = parseImage(png([ihdr(2, 2, 8, 2, 1), chunk('IDAT', zlib.deflateSync(Buffer.alloc(14))), chunk('IEND', Buffer.alloc(0))]))
    ok(b === null, 'interlaced must be declined')
  })
}
