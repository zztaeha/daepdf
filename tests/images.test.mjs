import zlib from 'node:zlib'

const crcT = (() => { const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ihdr = (w, h, bpc, ct, il = 0) => {
  const b = Buffer.alloc(13); b.writeUInt32BE(w, 0); b.writeUInt32BE(h, 4)
  b[8] = bpc; b[9] = ct; b[12] = il; return chunk('IHDR', b)
}
const rows = (w, h, ch, f) => {
  const rl = w * ch + 1, o = Buffer.alloc(h * rl)
  for (let r = 0; r < h; r++) for (let j = 0; j < w * ch; j++) o[r * rl + 1 + j] = f(r, j)
  return o
}

export default async function ({ test, eq, ok, load }) {
  const sniff = await load('src/images/sniff.ts')
  const { parseImage } = await load('src/images/parse.ts')

  const palettePng = Buffer.concat([SIG, ihdr(3, 1, 8, 3),
    chunk('PLTE', Buffer.from([255,0,0, 0,255,0, 0,0,255])),
    chunk('IDAT', zlib.deflateSync(rows(3, 1, 1, (_r, j) => j % 3))),
    chunk('IEND', Buffer.alloc(0))])

  test('the fast path really does decode a palette PNG', () => {
    const p = parseImage(new Uint8Array(palettePng))
    ok(p !== null, 'parseImage handles color type 3')
    eq([...p.data].join(','), '255,0,0,0,255,0,0,0,255')
  })

  test('the gate agrees with what the fast path can decode', () => {
    const needsBrowser = sniff.pngNeedsBrowserDecode(new Uint8Array(palettePng))
    const fastPathHandles = parseImage(new Uint8Array(palettePng)) !== null
    ok(!(needsBrowser && fastPathHandles),
      'pngNeedsBrowserDecode sends color type 3 to the browser even though parseImage decodes it')
  })

  test('sniffFormat identifies the common formats', () => {
    eq(sniff.sniffFormat(new Uint8Array([0xFF, 0xD8, 0, 0])), 'jpeg')
    eq(sniff.sniffFormat(new Uint8Array(palettePng)), 'png')
    eq(sniff.sniffFormat(new Uint8Array([0x47,0x49,0x46,0x38])), 'gif')
    eq(sniff.sniffFormat(new Uint8Array([0x42,0x4D])), 'bmp')
    eq(sniff.sniffFormat(new Uint8Array(Buffer.from('RIFF____WEBP', 'ascii'))), 'webp')
    eq(sniff.sniffFormat(new Uint8Array([1,2,3])), 'unknown')
  })

  test('sniffFormat recognizes SVG markup with or without a prolog', () => {
    const svg = s => sniff.sniffFormat(new Uint8Array(Buffer.from(s)))
    eq(svg('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'svg')
    eq(svg('\uFEFF<?xml version="1.0"?>\n<!-- icon -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg>'), 'svg')
    eq(svg('<html><svg></svg></html>'), 'unknown')
    eq(svg('<!-- a -- b ---><!---->\n<svg>'), 'svg')
  })

  test('a run of SVG comments does not backtrack exponentially', () => {
    const started = Date.now()
    eq(sniff.sniffFormat(new Uint8Array(Buffer.from('<!--' + '--><!--'.repeat(28) + 'x'))), 'unknown')
    ok(Date.now() - started < 1000, 'sniffFormat returned promptly')
  })

  test('sniffFormat does not mistake arbitrary data for avif', () => {
    // "ftyp" at 4 with a generic brand, and the word avif appearing in payload
    // beyond the ftyp box, must not be claimed as avif
    const b = Buffer.alloc(64)
    b.writeUInt32BE(16, 0)                       // ftyp box is 16 bytes
    b.write('ftyp', 4); b.write('mp42', 8); b.writeUInt32BE(0, 12)
    b.write('avif', 40)                          // outside the box
    eq(sniff.sniffFormat(new Uint8Array(b)), 'unknown')
  })

  test('a truncated PNG does not hang the chunk walker', () => {
    const t = palettePng.subarray(0, palettePng.length - 6)
    const started = Date.now()
    sniff.pngNeedsBrowserDecode(new Uint8Array(t))
    parseImage(new Uint8Array(t))
    ok(Date.now() - started < 1000, 'walker returned promptly')
  })

  // a stand-in ICC profile: only the header fields the parser checks (size, data color space)
  const profile = space => { const b = Buffer.alloc(200, 7); b.writeUInt32BE(200, 0); b.write(space, 16, 'ascii'); return b }
  // JPEG markers up to SOF0, the profile split over two APP2 segments
  const app2 = (seq, count, data) => {
    const body = Buffer.concat([Buffer.from('ICC_PROFILE\0', 'ascii'), Buffer.from([seq, count]), data])
    const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2)
    return Buffer.concat([Buffer.from([0xFF, 0xE2]), len, body])
  }
  const sof = Buffer.from([0xFF, 0xC0, 0, 17, 8, 0, 4, 0, 4, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])
  const jpegWith = icc => new Uint8Array(Buffer.concat([Buffer.from([0xFF, 0xD8]), app2(2, 2, icc.subarray(100)), app2(1, 2, icc.subarray(0, 100)), sof]))

  test('a JPEG\'s ICC profile is reassembled from its APP2 segments', () => {
    const p = parseImage(jpegWith(profile('RGB ')))
    eq(Buffer.from(p.icc).equals(profile('RGB ')), true)
    ok(parseImage(jpegWith(profile('CMYK'))).icc === null, 'a profile for other channels is ignored')
  })

  test('a PNG\'s iCCP profile is read', () => {
    const png = Buffer.concat([SIG, ihdr(1, 1, 8, 2),
      chunk('iCCP', Buffer.concat([Buffer.from('P3\0\0', 'binary'), zlib.deflateSync(profile('RGB '))])),
      chunk('IDAT', zlib.deflateSync(rows(1, 1, 3, () => 100))), chunk('IEND', Buffer.alloc(0))])
    eq(Buffer.from(parseImage(new Uint8Array(png)).icc).equals(profile('RGB ')), true)
  })

  test('an embedded profile becomes the image\'s ICCBased color space, written once', async () => {
    const { PdfDoc } = await load('tests/_entry.ts')
    const d = new PdfDoc(200, 200)
    const jpeg = jpegWith(profile('RGB '))
    for (const y of [0, 50]) d.draw_image(d.embed_image(jpeg), 0, y, 40, 40)
    d.draw_image(d.embed_image(jpegWith(profile('RGB '))), 100, 0, 40, 40)
    const out = Buffer.from(d.output()).toString('latin1')
    eq((out.match(/\/ColorSpace \[\/ICCBased \d+ 0 R\]/g) ?? []).length, 3)
    eq((out.match(/\/N 3\s*\/Alternate \/DeviceRGB/g) ?? []).length, 1)
  })
}
