import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { readPdf } from './pdfread.mjs'
import { WASM, requireFont } from './fixtures.mjs'
import { cbdt, colrV0, cpal, png, sbix, tablesOf, withTables } from './colrfont.mjs'


export default async function ({ test, eq, ok, load }) {
  const m = await load('tests/_entry.ts')
  const { PdfDoc, applyToPDF, initEngine, register_font_raw, measure_string_width, shapeInDirection, shape_text, get_glyph_ids, get_glyph_bitmap } = m
  await initEngine(readFileSync(WASM))
  register_font_raw('Inter', new Uint8Array(readFileSync(requireFont())))

  const draw = (s, fn = () => {}) => {
    const d = new PdfDoc(400, 200)
    d.set_font('Inter', 'normal', 400)
    d.set_font_size(12)
    fn(d)
    d.text(s, 20, 100, 'alphabetic')
    return d.output()
  }

  const readBack = bytes => readPdf(bytes).getPage(1).text()

  {
    const got = await readBack(draw('Hello world'))
    test('plain text round-trips through the reader', () => eq(got, 'Hello world'))
  }

  {
    const s = 'Årsredovisning för Åkesson'
    const got = await readBack(draw(s))
    test('non-ASCII text round-trips', () => eq(got, s))
  }

  {
    const s = 'a\u{1D400}b'
    const got = await readBack(draw(s))
    test('astral text round-trips', () => ok(got.includes('\u{1D400}'), `got ${JSON.stringify(got)}`))
  }

  test('Arabic-script digits shape left to right in left-to-right text', () => {
    const font = { fontName: 'inter', style: 'normal', weight: 400, opsz: 0 }
    const order = r => JSON.stringify([...r.clusters])
    // the engine alone guesses the digits' direction from their Arabic script and reverses them
    eq(order(shape_text('\u0661\u0662\u0663', 'inter', 'normal', 400, 0, false)), '[2,1,0]')
    eq(order(shapeInDirection('\u0661\u0662\u0663', font, true)), '[0,1,2]')
    eq(order(shapeInDirection('\u0661\u0662 ab', font, true)), '[0,1,2,3,4]', 'a line opening with them stays in order')
    eq(order(shapeInDirection('\u0661\u0662\u0663', font, false)), '[2,1,0]', 'right-to-left runs are left to the engine')
  })

  test('a glyph shared by two characters still copies as each of them', () => {
    // Inter draws Greek capital omega and the ohm sign with the same glyph
    const d = new PdfDoc(200, 200)
    d.set_font('Inter', 'normal', 400); d.set_font_size(12)
    d.text('\u03A9 \u2126', 10, 50, 'alphabetic')
    eq(readPdf(d.output()).getPage(1).text(), '\u03A9 \u2126')
  })

  test('skewed text sets a slanted text matrix and still extracts', () => {
    const d = new PdfDoc(400, 200)
    d.set_font('Inter', 'normal', 400); d.set_font_size(12)
    d.text('Slanted', 20, 100, 'alphabetic', undefined, 0.25)
    const page = readPdf(d.output()).getPage(1)
    ok(/BT\s[^E]*1 0 0\.25 1 20 [\d.]+ Tm/.test(page.content()), page.content().slice(0, 300))
    eq(page.text(), 'Slanted')
  })

  test('word spacing shifts after each space and no-break space, not through Tw', () => {
    const d = new PdfDoc(400, 200)
    d.set_font('Inter', 'normal', 400); d.set_font_size(12); d.set_word_spacing(6)
    d.text('a b\u00A0c\u2009d', 20, 100, 'alphabetic')
    const body = readPdf(d.output()).getPage(1).content()
    eq((body.match(/> -50\d(\.\d+)? </g) ?? []).length, 2, body)
    ok(!/ Tw\b/.test(body), body)
  })

  test('RTL text counts letter and word spacing when anchoring its right edge', () => {
    const text = 'abc de f', ls = 4, ws = 3, x = 10, maxWidth = 150
    const out = applyToPDF([{ type: 'text', page: 1, text, x, y: 50, font: 'Inter', style: 'normal', weight: 400, size: 12,
      color: [0, 0, 0], maxWidth, direction: 'rtl', letterSpacing: ls, wordSpacing: ws }], { config: { size: 'A4' }, security: null })
    const tx = Number(/([\d.]+) [\d.]+ Td/.exec(readPdf(out).getPage(1).content())?.[1])
    const drawn = measure_string_width(text, 'Inter', 'normal', 400, 0, 12) + ls * text.length + ws * 2
    ok(Math.abs(tx + drawn - (x + maxWidth)) < 0.01, `ends at ${tx + drawn}, box edge ${x + maxWidth}`)
  })

  test('text the font has no glyphs for still has its font resource', () => {
    const d = new PdfDoc(200, 200)
    d.set_font('Inter', 'normal', 400); d.set_font_size(12)
    d.text('\u4E2D\u6587', 10, 50, 'alphabetic')
    const page = readPdf(d.output()).getPage(1)
    const fonts = page.doc.resolve(page.doc.resolve(page.dict.get('Resources')).get('Font'))
    ok(/\/F1 12 Tf/.test(page.content()) && fonts.has('F1'), 'the Tf names a font the page defines')
  })

  {
    const glyphCodes = body => [...body.matchAll(/<([0-9a-f]+)>/g)].flatMap(m => m[1].match(/.{4}/g))
    const draw = (pdfA, ua = false) => {
      const d = new PdfDoc(200, 200)
      if (pdfA) d.set_pdfa('en')
      if (ua) d.set_pdfua('en')
      d.set_font('Inter', 'normal', 400); d.set_font_size(12)
      d.text('a\u4E2D\u6587b', 10, 50, 'alphabetic')
      return readPdf(d.output()).getPage(1)
    }
    const warn = console.warn; console.warn = () => {}
    const pdfa = draw(true), plain = draw(false), pdfua = draw(false, true)
    console.warn = warn
    test('PDF/A leaves out glyphs no font has, keeping their space', () => {
      ok(!glyphCodes(pdfa.content()).includes('0000'), pdfa.content())
      ok(glyphCodes(plain.content()).filter(g => g === '0000').length === 2, plain.content())
      ok(/> -\d+(\.\d+)? </.test(pdfa.content()), 'the dropped glyphs become a shift between a and b')
    })
    test('PDF/UA leaves them out too', () => ok(!glyphCodes(pdfua.content()).includes('0000'), pdfua.content()))
    test('a shown .notdef gets its own ActualText span, inside the text object', () => {
      const body = plain.content()
      ok((body.match(/\/Span << \/ActualText/g) ?? []).length === 2 && /BT[^]*\/Span[^]*EMC[^]*ET/.test(body), body)
    })
    test('text with missing glyphs copies as its real characters, PDF/A or not', () =>
      eq(JSON.stringify([plain.text(), pdfa.text()]), JSON.stringify(['a\u4E2D\u6587b', 'a\u4E2D\u6587b'])))
  }

  test('a clip spanning two pages leaves each page its own text state', () => {
    const d = new PdfDoc(200, 200)
    const font = () => { d.set_font('Inter', 'normal', 400); d.set_font_size(12); d.set_text_color(0, 0, 0) }
    font(); d.text('A', 10, 20, 'alphabetic')
    d.save_graphics_state(); d.set_page(2); d.save_graphics_state()
    d.set_page(1); d.restore_graphics_state(); d.set_page(2); d.restore_graphics_state()
    font(); d.text('B', 10, 20, 'alphabetic')
    const page = readPdf(d.output()).getPage(2)
    eq(page.text(), 'B', page.content())
  })

  test('a fractional font size is written as a short PDF number', () => {
    const d = new PdfDoc(200, 200)
    d.set_font('Inter', 'normal', 400); d.set_font_size(12 * 0.7)
    d.text('x', 10, 10, 'alphabetic')
    const body = readPdf(d.output()).getPage(1).content()
    ok(/\/F1 8\.4 Tf/.test(body), body.slice(0, 200))
  })

  test('empty and whitespace-only text do not emit broken operators', () => {
    const d = new PdfDoc(200, 200)
    d.set_font('Inter', 'normal', 400); d.set_font_size(12)
    d.text('', 10, 10, 'alphabetic')
    d.text('   ', 10, 30, 'alphabetic')
    const s = Buffer.from(d.output()).toString('latin1')
    ok(s.startsWith('%PDF'), 'still a PDF')
  })

  test('an unregistered font does not crash or emit a broken font ref', () => {
    const d = new PdfDoc(200, 200)
    d.set_font('NoSuchFontHere', 'normal', 400)
    d.set_font_size(12)
    d.text('abc', 10, 10, 'alphabetic')
    const out = Buffer.from(d.output()).toString('latin1')
    ok(out.startsWith('%PDF'), 'still a PDF')
    ok(!/\/F\w*\s+undefined/.test(out), 'no undefined font reference')
    ok(!out.includes('NaN'), 'no NaN in the output')
  })

  test('a huge font size does not produce exponential notation', () => {
    const d = new PdfDoc(200, 200)
    d.set_font('Inter', 'normal', 400)
    d.set_font_size(1e22)
    d.text('x', 10, 10, 'alphabetic')
    const s = Buffer.from(d.output()).toString('latin1')
    ok(!/\de[+-]\d/.test(s), 'exponential notation is not valid PDF syntax')
  })

  test('color glyphs copy as their characters, once each', () => {
    const inter = new Uint8Array(readFileSync(requireFont()))
    const [A, B, C, D] = get_glyph_ids('ABCD', 'Inter', 'normal', 400)
    const u16 = (...v) => v.flatMap(n => [n >> 8 & 255, n & 255])
    const u32 = (...v) => v.flatMap(n => [n >>> 24, n >> 16 & 255, n >> 8 & 255, n & 255])
    // sbix: D is a 2x2 PNG in a single strike
    const chunk = (type, data) => {
      const td = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(8 + data.length + 4)
      out.writeUInt32BE(data.length); td.copy(out, 4); out.writeUInt32BE(zlib.crc32(td), 8 + data.length)
      return out
    }
    const ihdr = Buffer.from([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0])
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 128, 0, 255, 0, 128, 0, 255, 0, 0, 128, 0, 255, 0, 128, 0, 255]))), chunk('IEND', Buffer.alloc(0))])
    const maxp = tablesOf(inter).find(([t]) => t === 'maxp')[1], numGlyphs = maxp[4] << 8 | maxp[5]
    const glyph = [...u16(0, 0), ...Buffer.from('png '), ...png]
    const strike = [...u16(36, 72), ...u32(...Array.from({ length: numGlyphs + 1 }, (_, g) => 4 + (numGlyphs + 1) * 4 + (g > D ? glyph.length : 0))), ...glyph]
    // COLR v0: A is drawn as B in red, then C in the text color
    const font = withTables(inter, {
      COLR: colrV0([[A, [[B, 0], [C, 0xFFFF]]]]), CPAL: cpal([[255, 0, 0, 255]]), sbix: [...u16(1, 1), ...u32(1, 12), ...strike],
    })
    register_font_raw('Color', font)

    const d = new PdfDoc(400, 200)
    d.set_font('Color', 'normal', 400); d.set_font_size(12)
    d.text('xAyDz', 20, 100, 'alphabetic')
    const page = readPdf(d.output()).getPage(1), content = page.content(), art = page.forms().join('\n')
    const shown = g => content.includes(`<${g.toString(16).padStart(4, '0')}> Tj`) || art.includes(`<${g.toString(16).padStart(4, '0')}> Tj`)
    // layers drawn as text would copy along with the glyph in readers that skip ActualText
    ok(!shown(B) && !shown(C), 'no layer is drawn as text')
    ok(art.includes('1 0 0 rg') && art.includes('0 0 0 rg') && / W n\n/.test(art), 'the layers fill their outlines in their colors')
    ok(/\/Im\w* Do/.test(content), 'the bitmap glyph is drawn as an image')
    eq(page.text(), 'xAyDz')
    // the invisible glyphs carrying the text must not leave later text invisible
    const invisible = content.match(/q\nBT\n3 Tr\n[^\n]+\n<[0-9a-f]{4}> Tj\nET\nQ/g) ?? []
    ok(invisible.length === 2 && content.split('3 Tr').length === 3, 'render mode 3 is scoped by q/Q, once per color glyph')
  })

  test('bitmap glyphs sit where their strike puts them', () => {
    const inter = new Uint8Array(readFileSync(requireFont()))
    const [D] = get_glyph_ids('D', 'Inter', 'normal', 400)
    const maxp = tablesOf(inter).find(([t]) => t === 'maxp')[1], numGlyphs = maxp[4] << 8 | maxp[5]
    register_font_raw('Sbix', withTables(inter, { sbix: sbix(numGlyphs, D, 20, png(2, 2), 3, -2) }))
    register_font_raw('Cbdt', withTables(inter, cbdt(D, 20, png(2, 2), 2, 2, 1, 3)))
    // sbix stores the bottom-left corner and CBDT the top bearing; both come back as the bottom-left
    const s = get_glyph_bitmap('Sbix', 'normal', D, 20), c = get_glyph_bitmap('Cbdt', 'normal', D, 20)
    eq([s.originX, s.originY].join(), '3,-2')
    eq([c.originX, c.originY].join(), '1,1')
    // at 20pt from a 20ppem strike a pixel is a point, so the image's bottom sits originY above the baseline
    const placed = family => {
      const d = new PdfDoc(200, 200)
      d.set_font(family, 'normal', 400); d.set_font_size(20)
      d.text('D', 50, 100, 'alphabetic')
      return readPdf(d.output()).getPage(1).content().match(/([-\d.]+) 0 0 ([-\d.]+) ([-\d.]+) ([-\d.]+) cm\n\/Im\w* Do/)?.slice(1).join()
    }
    eq(placed('Sbix'), '2,2,53,98')
    eq(placed('Cbdt'), '2,2,51,101')
  })
}
