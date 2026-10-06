import { readFileSync } from 'node:fs'
import { WASM, requireFont } from './fixtures.mjs'
import { psName, tablesOf, withTables } from './colrfont.mjs'

const VARIATIONS = ['fvar', 'gvar', 'avar', 'HVAR', 'MVAR', 'STAT', 'cvar']

export default async function ({ test, eq, ok, load }) {
  // bundled on its own so this module starts uninitialized, unlike the shared test entry
  const engine = await load('src/daegun/wasm/daegun.ts')
  const wasm = readFileSync(WASM)
  const font = new Uint8Array(readFileSync(requireFont()))

  // engine.ts's font loader and pdf.warmup() can both start the engine at once
  const first = engine.default(wasm)
  const second = engine.default(wasm)
  await first
  engine.register_font_raw('Inter', font)
  await second
  test('concurrent initEngine calls share one instance', () =>
    ok(engine.list_registered_fonts().includes('inter:normal'), `font lost: ${JSON.stringify(engine.list_registered_fonts())}`))

  // Faces made from the suite font with their OS/2 weight class and italic bit set: a named one is
  // static and answers with its name, an unnamed one stays variable
  const os2 = tablesOf(font).find(([t]) => t === 'OS/2')[1]
  const face = (name, weight, italic = false) => {
    const o = new Uint8Array(os2)
    o[4] = weight >> 8; o[5] = weight & 255
    const selection = (o[62] << 8 | o[63]) & ~0x41 | (italic ? 0x01 : 0x40)
    o[62] = selection >> 8; o[63] = selection & 255
    return name ? withTables(font, { 'OS/2': o, name: psName(name) }, VARIATIONS) : withTables(font, { 'OS/2': o })
  }
  const chosen = (family, style, weight) => engine.subset_font_full(family, style, weight, 0, new Uint16Array([1]))?.fontName
  const listed = family => engine.list_registered_fonts().filter(k => k.startsWith(`${family}:`)).join()

  test('faces are matched by style first, then by the nearest weight', () => {
    for (const [name, weight, italic] of [['R', 400], ['B', 700], ['I', 400, true], ['BI', 700, true], ['K', 900]]) {
      engine.register_font_raw('Fam', face(name, weight, italic))
    }
    eq(listed('fam'), 'fam:italic,fam:italic,fam:normal,fam:normal,fam:normal')
    const at = (style, weights) => weights.map(w => chosen('Fam', style, w)).join()
    eq(at('normal', [1, 400, 550, 600, 800, 850, 1000]), 'R,R,R,B,B,K,K', 'the nearest weight, the lighter on a tie')
    eq(at('italic', [400, 700, 1000]), 'I,BI,BI', 'an italic request keeps to italic faces')
    eq(at('oblique', [400, 850]), 'I,K', 'a style no face has falls back to every face')
    eq(chosen('FAM', 'normal', 700), 'B', 'family names match case-insensitively')
  })

  test('a variable face answers anywhere in its weight range', () => {
    engine.register_font_raw('Mix', face(null, 400))
    engine.register_font_raw('Mix', face('B', 700))
    ok(chosen('Mix', 'normal', 700).startsWith('InterVariable'), 'both fit 700 and the lighter weight class sorts first')
    engine.register_font_raw('Mix2', face(null, 700))
    engine.register_font_raw('Mix2', face('R', 400))
    eq(chosen('Mix2', 'normal', 400), 'R', 'both fit 400 and the static face sorts first')
    ok(chosen('Mix2', 'normal', 450).startsWith('InterVariable'), 'only the range fits 450')
  })

  test('registering a face again replaces it', () => {
    engine.register_font_raw('Swap', face('Old', 400))
    engine.register_font_raw('Swap', face('New', 400))
    eq(listed('swap'), 'swap:normal')
    eq(chosen('Swap', 'normal', 400), 'New')
  })

  test('an unknown family answers nothing', () => {
    ok(engine.shape_text('x', 'nope', 'normal', 400, 0, false) === null)
    ok(!engine.font_has_glyph('nope', 'normal', 65))
    eq(engine.get_glyph_ids('x', 'nope', 'normal', 400).length, 0)
    eq(engine.measure_string_width('x', 'nope', 'normal', 400, 0, 12), 0)
    ok(engine.subset_font_full('nope', 'normal', 400, 0, new Uint16Array([1])) === null)
  })

  test('a font that does not parse is refused with the reason', () => {
    let message = ''
    try { engine.register_font_raw('Bad', new Uint8Array(8)) } catch (e) { message = e.message }
    ok(/too short/.test(message), `refused with: ${message}`)
    eq(listed('bad'), '')
  })
}
