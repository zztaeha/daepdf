import { readFileSync } from 'node:fs'
import { readPdf } from './pdfread.mjs'
import { WASM, requireFont } from './fixtures.mjs'
import { colrV1, cpal, tablesOf, withTables } from './colrfont.mjs'

export default async function ({ test, eq, ok, load }) {
  const m = await load('tests/_entry.ts')
  const { PdfDoc, Outlines, initEngine, register_font_raw, get_glyph_ids, splitByFontCoverage } = m
  const { cffOutlines } = await load('src/pdf_doc/outlines.ts')
  await initEngine(readFileSync(WASM))
  const inter = new Uint8Array(readFileSync(requireFont()))
  register_font_raw('Inter', inter)
  const [A, B, C, O, I] = get_glyph_ids('ABCOI', 'Inter', 'normal', 400)

  const PALETTE = cpal([[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]])
  const solid = (palette, alpha = 1) => ({ format: 2, palette, alpha })
  const glyph = (gid, paint) => ({ format: 10, gid, paint })
  let fonts = 0
  const colorFont = spec => {
    const name = `Color${++fonts}`
    register_font_raw(name, withTables(inter, { COLR: colrV1(spec), CPAL: PALETTE }))
    return name
  }
  const draw = (font, text, { weight = 400, color } = {}) => {
    const d = new PdfDoc(400, 200)
    d.set_font(font, 'normal', weight); d.set_font_size(24)
    if (color) d.set_text_color(...color)
    d.text(text, 20, 100, 'alphabetic')
    const bytes = d.output(), page = readPdf(bytes).getPage(1)
    return { raw: Buffer.from(bytes).toString('latin1'), content: page.content(), art: page.forms().join('\n'), shadings: page.shadings(), text: page.text() }
  }

  {
    const font = colorFont({ base: [[A, { format: 1, first: 0, count: 2 }]], layers: [glyph(O, solid(0)), glyph(I, solid(0xFFFF))] })
    const r = draw(font, 'xAy', { color: [17, 170, 102] })
    test('a COLRv1 glyph fills its clip outlines in palette and text colors', () => {
      ok(r.art.includes('1 0 0 rg'), 'palette red')
      ok(r.art.includes('0.067 0.667 0.4 rg'), 'the text color, for palette index 0xFFFF')
      eq((r.art.match(/ W n\n/g) ?? []).length, 3, 'the glyph region and one outline clip per layer')
    })
    test('a COLRv1 glyph copies as its character, its art carrying no text', () => {
      eq(r.text, 'xAy')
      ok(!/Tj|TJ/.test(r.art), 'no text inside the art')
    })
  }

  {
    const line = { stops: [[0, 0, 1], [1, 2, 1]] }
    const font = colorFont({ base: [
      [A, glyph(O, { format: 4, line, points: [100, 0, 600, 0, 100, 500] })],
      [B, glyph(O, { format: 6, line, circles: [300, 300, 0, 300, 300, 400] })],
      [C, glyph(O, { format: 8, line, center: [300, 300], start: 0, end: 360 })],
    ] })
    const r = draw(font, 'ABC')
    test('linear, radial and sweep gradients become axial, radial and mesh shadings', () => {
      eq(r.shadings.map(s => s.get('ShadingType')).sort().join(), '2,3,6')
      eq((r.art.match(/ cm \/CSh\d+ sh Q/g) ?? []).length, 3)
    })
  }

  {
    const stripes = { extend: 1, stops: [[0, 0, 1], [0.1, 2, 1]] }
    const font = colorFont({ base: [
      [A, glyph(O, { format: 4, line: stripes, points: [0, 0, 100, 0, 0, 100] })],
      // coincident stops leave nothing to repeat
      [B, glyph(O, { format: 4, line: { extend: 1, stops: [[0.5, 0, 1], [0.5, 2, 1]] }, points: [0, 0, 100, 0, 0, 100] })],
    ] })
    const r = draw(font, 'AB')
    test('a repeating color line is unrolled across the glyph', () => {
      const bounds = r.shadings[0]?.get('Function')?.get('Bounds') ?? []
      ok(bounds.length > 10, `${bounds.length} stitched segments`)
    })
    test('a repeating line whose stops coincide draws nothing, and still copies', () => {
      eq((r.art.match(/sh Q/g) ?? []).length, 1)
      eq(r.text, 'AB')
    })
  }

  {
    const font = colorFont({ base: [
      [A, { format: 14, offset: [100, 0], paint: glyph(I, solid(0)) }],
      [B, glyph(I, solid(0))],
    ] })
    const r = draw(font, 'AB')
    test('a transform moves the outlines it draws', () => {
      const xs = [...r.art.matchAll(/^q (-?[\d.]+) [-\d.]+ m /gm)].map(x => +x[1])
      eq(xs.length, 2)
      eq(Math.round(Math.abs(xs[0] - xs[1])), 100)
    })
  }

  {
    const over = { format: 32, mode: 23, source: glyph(O, solid(0)), backdrop: glyph(I, solid(2)) }
    const inside = { format: 32, mode: 5, source: glyph(O, solid(0)), backdrop: glyph(I, solid(2)) }
    const outside = { format: 32, mode: 7, source: glyph(O, solid(0)), backdrop: glyph(I, solid(2)) }
    const font = colorFont({ base: [[A, over], [B, inside], [C, outside]] })
    const r = draw(font, 'ABC')
    test('a blend composite draws its source through /BM in an isolated group', () => {
      ok(r.raw.includes('/BM /Multiply'))
      ok(r.raw.includes('/S /Transparency /I true'))
    })
    test('IN and OUT composites mask with the other operand, OUT inverted', () => {
      ok(r.raw.includes('/S /Alpha'), 'an alpha mask')
      ok(/\/S \/Luminosity/.test(r.raw) && r.art.includes('q 1 g ') && r.art.includes(' gs 0 g '), 'white with the operand in black')
    })
    test('a glyph drawn through a soft mask sits in page space, the mask set without cm', () => {
      // Quartz clips a mask set under a scaled CTM to the page box put through it
      const draws = r.content.match(/q (?:[-\d.]+ ){6}cm \/CFm\d+ Do Q|q \/CFm\d+ Do Q/g) ?? []
      eq(draws.length, 3)
      eq(draws.filter(x => x.includes(' cm ')).length, 1, 'only the unmasked blend goes through cm')
    })
  }

  {
    const font = colorFont({ base: [
      [A, { format: 11, gid: B }],
      // a cycle back to A must stop rather than recurse forever
      [B, { format: 1, first: 0, count: 2 }],
    ], layers: [glyph(I, solid(1)), { format: 11, gid: A }], clips: [[B, B, [50, -100, 500, 700]]] })
    const r = draw(font, 'A')
    test('PaintColrGlyph draws the glyph it names, with its clip box, and stops at a cycle', () => {
      ok(r.art.includes('0 1 0 rg'), 'the named glyph\'s layer')
      ok(r.art.includes('50 -100 m 500 -100 l 500 700 l 50 700 l h W n'), 'its clip box')
      eq(r.text, 'A')
    })
  }

  {
    const font = colorFont({ base: [[A, glyph(O, solid(0))]], clips: [[A, A, [0, -200, 800, 900]]] })
    const r = draw(font, 'A')
    test('a clip box bounds the glyph\'s form', () => ok(r.raw.includes('/BBox [0 -200 800 900]')))
  }

  {
    // Inter's axes are opsz then wght; the region peaks at full weight on the wght axis
    const font = colorFont({
      base: [[A, glyph(O, { format: 3, palette: 0, alpha: 0.5, varBase: 0 })]],
      axisCount: 2, regions: [[[0, 0, 0], [0, 1, 1]]], deltas: [[Math.round(0.25 * 16384)]],
    })
    const alphaAt = weight => Number(/\/ca ([\d.]+)/.exec(draw(font, 'A', { weight }).raw)?.[1])
    test('a variable paint follows the weight', () => {
      eq(alphaAt(400), 0.5)
      const bold = alphaAt(700)
      ok(bold > 0.6 && bold < 0.7, `alpha ${bold} at weight 700`)
    })
  }

  {
    // two color glyphs clipped by the same outline glyph
    const font = colorFont({ base: [[A, glyph(O, solid(0))], [B, glyph(O, solid(2))]] })
    test('color glyphs sharing an outline each copy as themselves, text around them too', () =>
      eq(draw(font, 'xA B AB y').text, 'xA B AB y'))
  }

  {
    const font = withTables(inter, { COLR: colrV1({ base: [[A, glyph(O, solid(0))]] }).slice(0, 40), CPAL: PALETTE })
    register_font_raw('Broken', font)
    test('a malformed COLR table leaves plain glyphs, not a failed export', () => eq(draw('Broken', 'xAy').text, 'xAy'))
  }

  {
    // a COLRv1 font with ❤ in color and, like Noto Color Emoji, no plain U+FE0F in its cmap
    const [heart] = get_glyph_ids('\u2764', 'Inter', 'normal', 400)
    register_font_raw('VsColor', withTables(inter, { COLR: colrV1({ base: [[heart, glyph(O, solid(0))]] }), CPAL: PALETTE }))
    const reg = new Map([['inter', ['normal']], ['vscolor', ['normal']]])
    const runs = splitByFontCoverage('a\u2764\uFE0Fb \u2764', { name: 'Inter', style: 'normal', weight: 400 }, 'Inter, VsColor', '400', 'normal', {}, reg)
    test('a character with the emoji selector takes the color font in the family, the selector with it', () =>
      eq(JSON.stringify(runs.map(r => [r.text, r.font.name])), JSON.stringify([['a', 'Inter'], ['\u2764\uFE0F', 'VsColor'], ['b \u2764', 'Inter']])))
  }

  test('a composite glyph\'s outline is its components\' outlines', () => {
    const face = { numGlyphs: (m => m[4] << 8 | m[5])(tablesOf(inter).find(([t]) => t === 'maxp')[1]), upem: 2048, coords: () => [] }
    const font = { id: 'T', fontName: 'Inter', style: 'normal', weight: 400, opsz: 0 }
    const outlines = Outlines.load(font, face)
    const [aacute] = get_glyph_ids('Á', 'Inter', 'normal', 400)
    const a = outlines.get(A), whole = outlines.get(aacute)
    ok(whole.length > a.length, 'the accent adds contours')
    eq(JSON.stringify(whole.slice(0, a.length)), JSON.stringify(a), 'the base letter sits unmoved')
    const bold = Outlines.load({ ...font, id: 'B', weight: 700 }, face).get(A)
    ok(JSON.stringify(bold) !== JSON.stringify(a), 'the weight instances the outlines')
  })

  test('Type 2 charstrings: width, hints, subroutines, every curve form and flex', () => {
    const op = (...ops) => ops.flatMap(o => o >= 100 ? [12, o - 100] : [o])
    const n = v => Number.isInteger(v) && v >= -107 && v <= 107 ? [v + 139] : v === Math.trunc(v) ? [28, v >> 8 & 255, v & 255] : [255, ...new Uint8Array(Int32Array.of(Math.round(v * 65536)).buffer).reverse()]
    const cs = (...parts) => parts.flatMap(p => Array.isArray(p) ? p : n(p))
    const RMOVE = op(21), RLINE = op(5), RRCURVE = op(8), END = op(14)
    const glyphs = [
      cs(END),
      cs(500, 0, 50, op(1), 100, 20, op(19), [0x80], 10, 20, RMOVE, 30, 0, RLINE, 0, 30, 10, 10, 20, 0, RRCURVE, END),
      cs(0, 0, RMOVE, -107, op(10), -107, op(29), 10, 20, 30, 40, op(27), 1, 2, 3, 4, op(26), 5, 6, 7, 8, 9, op(31),
        1, 1, 1, 1, 1, 1, 2, 2, op(24), 3, 3, 1, 1, 1, 1, 1, 1, op(25), 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 50, op(135), END),
      cs(1000, 0.5, RMOVE, END),
      // a leading width before a moveto, which would otherwise read as its first coordinate
      cs(500, 10, 20, RMOVE, END),
      cs(500, 30, op(22), END),
    ]
    const index = items => {
      const offs = [1]
      for (const it of items) offs.push(offs.at(-1) + it.length)
      const size = offs.at(-1) > 255 ? 2 : 1
      return [items.length >> 8, items.length & 255, size, ...offs.flatMap(o => size === 2 ? [o >> 8, o & 255] : [o]), ...items.flat()]
    }
    const int32 = v => [29, v >>> 24, v >> 16 & 255, v >> 8 & 255, v & 255]
    const local = index([cs(10, 0, RLINE, op(11))]), global = index([cs(0, 10, RLINE, op(11))])
    const head = [1, 0, 4, 1], names = index([[84]]), strings = [0, 0], charStrings = index(glyphs)
    // Subrs sits right after the Private DICT, its offset counted from the Private DICT's start
    const priv = [...int32(6), 19]
    // int32 operands keep the Top DICT one size whatever the offsets, so it's measured with zeros
    const topDict = (charStringsAt, privateAt) => index([[...int32(charStringsAt), 17, ...int32(priv.length), ...int32(privateAt), 18]])
    const charStringsAt = head.length + names.length + topDict(0, 0).length + strings.length + global.length
    const top = topDict(charStringsAt, charStringsAt + charStrings.length)
    const cff = new Uint8Array([...head, ...names, ...top, ...strings, ...global, ...charStrings, ...priv, ...local])
    const read = cffOutlines(new DataView(cff.buffer), false, [], 1000)
    eq(JSON.stringify(read(1)), JSON.stringify([{ start: [10, 20], segs: [[40, 20], [40, 50, 50, 60, 70, 60]] }]))
    eq(JSON.stringify(read(2)), JSON.stringify([{ start: [0, 0], segs: [
      [10, 0], [10, 10], [20, 10, 40, 40, 80, 40], [80, 41, 82, 44, 82, 48], [87, 48, 93, 55, 102, 63],
      [103, 64, 104, 65, 105, 66], [107, 68], [110, 71], [111, 72, 112, 73, 113, 74],
      [114, 74, 115, 74, 116, 74], [117, 74, 118, 74, 119, 74],
    ] }]))
    eq(JSON.stringify(read(3)), JSON.stringify([{ start: [1000, 0.5], segs: [] }]))
    eq(JSON.stringify(read(4)), JSON.stringify([{ start: [10, 20], segs: [] }]))
    eq(JSON.stringify(read(5)), JSON.stringify([{ start: [30, 0], segs: [] }]))
  })

  test('CFF2 blend applies its deltas at the instance', () => {
    const u16 = v => [v >> 8 & 255, v & 255], u32 = v => [v >>> 24, v >> 16 & 255, v >> 8 & 255, v & 255]
    const int32 = v => [29, ...u32(v)]
    // x = 100 + 50 × the region's scalar, then a moveto
    const charString = [100 + 139, 50 + 139, 1 + 139, 16, 0 + 139, 21]
    const index32 = items => [...u32(items.length), 1, 1, ...items.reduce((o, it) => [...o, o.at(-1) + it.length], [1]).slice(1), ...items.flat()]
    const store = [...u16(1), ...u32(12), ...u16(1), ...u32(12 + 10), ...u16(1), ...u16(1), 0, 0, 64, 0, 64, 0, ...u16(0), ...u16(0), ...u16(1), ...u16(0)]
    const topLen = 5 + 1 + 5 + 1
    const globalAt = 5 + topLen, charStringsAt = globalAt + 4, storeAt = charStringsAt + index32([charString]).length
    const cff2 = new Uint8Array([2, 0, 5, ...u16(topLen), ...int32(charStringsAt), 17, ...int32(storeAt), 24,
      ...u32(0), ...index32([charString]), ...u16(store.length), ...store])
    const at = coords => cffOutlines(new DataView(cff2.buffer), true, coords, 1000)(0)[0].start[0]
    eq(at([0]), 100)
    eq(at([0.5]), 125)
    eq(at([1]), 150)
  })
}
