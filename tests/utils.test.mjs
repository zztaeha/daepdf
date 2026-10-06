export default async function ({ test, eq, ok, load }) {
  const { hpf, toPdfName, pdfEscape, encodeColor } = await load('src/pdf_doc/utils.ts')
  const { toUnicodeCmap } = await load('src/pdf_doc/cmap.ts')

  test('an embedded font keeps only the tables asked for, intact', async () => {
    const { onlyTables } = await load('src/pdf_doc/build_fonts.ts')
    // a minimal sfnt: glyf (4 bytes), head (54), sbix (8), records in tag order
    const tables = [['glyf', [1, 2, 3, 4]], ['head', Array(54).fill(7)], ['sbix', Array(8).fill(9)]]
    const size = 12 + tables.length * 16 + tables.reduce((n, [, d]) => n + ((d.length + 3) & ~3), 0)
    const font = new Uint8Array(size), v = new DataView(font.buffer)
    v.setUint32(0, 0x00010000); v.setUint16(4, tables.length)
    let at = 12 + tables.length * 16
    tables.forEach(([tag, data], i) => {
      for (let k = 0; k < 4; k++) font[12 + i * 16 + k] = tag.charCodeAt(k)
      v.setUint32(12 + i * 16 + 8, at); v.setUint32(12 + i * 16 + 12, data.length)
      font.set(data, at); at += (data.length + 3) & ~3
    })
    const out = onlyTables(font, new Set(['glyf', 'head'])), ov = new DataView(out.buffer, out.byteOffset)
    const tags = Array.from({ length: ov.getUint16(4) }, (_, i) => String.fromCharCode(...out.subarray(12 + i * 16, 16 + i * 16)))
    eq(tags.join(), 'glyf,head')
    const glyfAt = ov.getUint32(12 + 8)
    eq([...out.subarray(glyfAt, glyfAt + 4)].join(), '1,2,3,4')
    let sum = 0
    for (let o = 0; o + 4 <= out.length; o += 4) sum = (sum + ov.getUint32(o)) >>> 0
    eq(sum, 0xB1B0AFBA, 'head.checkSumAdjustment balances the file')
    ok(onlyTables(font, new Set(['glyf', 'head', 'sbix'])) === font, 'nothing to drop returns the font unchanged')
  })

  test('hpf trims trailing zeros correctly', () => {
    eq(hpf(0), '0'); eq(hpf(1), '1'); eq(hpf(100), '100')
    eq(hpf(1.5), '1.5'); eq(hpf(1.05), '1.05'); eq(hpf(-2.25), '-2.25')
    eq(hpf(0.0004), '0')
  })

  test('hpf emits a valid PDF number for non-finite input', () => {
    const isPdfNumber = s => /^-?\d*\.?\d+$/.test(s)
    for (const v of [NaN, Infinity, -Infinity]) {
      ok(isPdfNumber(hpf(v)), `hpf(${v}) produced ${JSON.stringify(hpf(v))}, which is not a PDF number`)
    }
  })

  test('hpf emits a valid PDF number for very large input', () => {
    const isPdfNumber = s => /^-?\d*\.?\d+$/.test(s)
    const v = 1e21
    ok(isPdfNumber(hpf(v)), `hpf(1e21) produced ${JSON.stringify(hpf(v))}`)
  })

  test('encodeColor stays in range', () => {
    eq(encodeColor(255, 255, 255, false), '1 g')
    eq(encodeColor(0, 0, 0, true), '0 G')
    eq(encodeColor(255, 0, 0, false), '1 0 0 rg')
  })

  test('toPdfName escapes every character PDF forbids in a name', () => {
    eq(toPdfName('Inter Variable'), 'Inter#20Variable')
    eq(toPdfName('a#b'), 'a#23b')
    eq(toPdfName('a/b'), 'a#2Fb')
    // whitespace PDF treats as a name terminator, same class as space
    for (const [ch, code] of [['\t', '09'], ['\f', '0C'], ['\0', '00']]) {
      const got = toPdfName('a' + ch + 'b')
      eq(got, `a#${code}b`, `${JSON.stringify(ch)} must be escaped in a PDF name`)
    }
  })

  test('pdfEscape covers the literal-string metacharacters', () => {
    eq(pdfEscape('a(b)c'), 'a\\(b\\)c')
    eq(pdfEscape('a\\b'), 'a\\\\b')
    // a bare CR inside a literal string is read back as LF, corrupting the value
    ok(!pdfEscape('a\rb').includes('\r'), 'a raw CR survives into the literal string')
  })

  test('toUnicodeCmap maps a simple run', () => {
    const m = new Map([[1, [0x41]], [2, [0x42]], [3, [0x43]]])
    const s = toUnicodeCmap(m)
    ok(s.includes('beginbfrange'), 'consecutive gids should compress to a bfrange')
    ok(s.includes('<0001><0003><0041>'), `range not as expected:\n${s}`)
  })

  test('toUnicodeCmap emits ligatures as bfchar', () => {
    const s = toUnicodeCmap(new Map([[7, [0x66, 0x69]]]))
    ok(s.includes('beginbfchar') && s.includes('<0007><00660069>'), s)
  })

  test('toUnicodeCmap surrogate-pairs astral codepoints', () => {
    const s = toUnicodeCmap(new Map([[9, [0x1D400]]]))
    ok(s.includes('<d835dc00>'), `expected a surrogate pair, got:\n${s}`)
  })

  // CMap spec: in a bfrange with a single destination string, the LAST BYTE of
  // that string is what increments, so a range may not span more than 256 codes.
  test('toUnicodeCmap never emits a bfrange spanning more than 256 codes', () => {
    const m = new Map()
    for (let i = 0; i < 400; i++) m.set(1 + i, [0x4E00 + i])
    const s = toUnicodeCmap(m)
    const bad = []
    for (const [, lo, hi] of s.matchAll(/<([0-9a-f]{4})><([0-9a-f]{4})><[0-9a-f]+>/g)) {
      const span = parseInt(hi, 16) - parseInt(lo, 16) + 1
      if (span > 256) bad.push(`<${lo}>..<${hi}> spans ${span}`)
    }
    ok(bad.length === 0, `bfrange too wide: ${bad.join(', ')}`)
  })

  // and its source codes may differ only in the last byte, so neither the glyph ids nor the
  // codepoints may carry across a byte boundary inside one range (ÿ U+00FF, Ā U+0100)
  test('toUnicodeCmap never carries a bfrange across a byte boundary', () => {
    const across = (lo, hi) => (parseInt(lo, 16) >> 8) !== (parseInt(hi, 16) >> 8)
    const ranges = map => [...toUnicodeCmap(map).matchAll(/<([0-9a-f]{4})><([0-9a-f]{4})><([0-9a-f]+)>/g)]
    const gidsCross = ranges(new Map([[0xFE, [0x41]], [0xFF, [0x42]], [0x100, [0x43]], [0x101, [0x44]]]))
    const cpsCross = ranges(new Map([[10, [0xFE]], [11, [0xFF]], [12, [0x100]], [13, [0x101]]]))
    ok(gidsCross.every(([, lo, hi]) => !across(lo, hi)), gidsCross.map(m => m[0]).join(' '))
    ok(cpsCross.every(([, lo, hi, cp]) => !across(cp, (parseInt(cp, 16) + parseInt(hi, 16) - parseInt(lo, 16)).toString(16))), cpsCross.map(m => m[0]).join(' '))
  })
}
