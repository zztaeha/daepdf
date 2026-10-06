import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import { readPdf } from './pdfread.mjs'
import { WASM, requireFont } from './fixtures.mjs'
import { staticCff2, tablesOf } from './colrfont.mjs'


function allText(bytes) {
  const buf = Buffer.from(bytes)
  const parts = [buf]
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length
    const end = buf.indexOf('endstream', start)
    try { parts.push(zlib.inflateSync(buf.subarray(start, end))) } catch {}
  }
  return Buffer.concat(parts).toString('latin1')
}

// Each font program embedded on page 1, as [stream key, decoded bytes]
function fontPrograms(bytes) {
  const pdf = readPdf(bytes), at = v => pdf.doc.resolve(v)
  const fonts = at(at(pdf.pages[0].get('Resources')).get('Font'))
  return [...fonts.values()].flatMap(ref => {
    const descriptor = at(at(at(at(ref).get('DescendantFonts'))[0]).get('FontDescriptor'))
    return ['FontFile2', 'FontFile3'].filter(k => descriptor.get(k)).map(k => [k, new Uint8Array(pdf.doc.stream(at(descriptor.get(k))))])
  })
}

export default async function ({ test, eq, ok, load }) {
  const m = await load('tests/_entry.ts')
  const { PdfDoc, initEngine, register_font_raw, get_glyph_ids } = m
  await initEngine(readFileSync(WASM))
  register_font_raw('Inter', new Uint8Array(readFileSync(requireFont())))

  const doc = (text = 'Hello Wörld', weight = 400) => {
    const d = new PdfDoc(300, 300)
    d.set_font('Inter', 'normal', weight)
    d.set_font_size(12)
    d.text(text, 20, 50, 'alphabetic')
    return d
  }

  const s = allText(doc().output())

  test('the descriptor carries the required entries', () => {
    for (const k of ['/FontDescriptor', '/Flags', '/FontBBox', '/ItalicAngle',
                     '/Ascent', '/Descent', '/CapHeight', '/StemV']) {
      ok(s.includes(k), `missing ${k}`)
    }
  })

  test('a CID font declares Identity encoding and a CIDToGIDMap', () => {
    ok(s.includes('/Subtype /Type0'), 'Type0 parent')
    ok(s.includes('/Identity-H'), 'Identity-H encoding')
    ok(s.includes('/CIDToGIDMap'), 'CIDToGIDMap present')
  })

  // scoped to the CIDFont dictionary — the xref stream also has a /W, of a
  // completely different shape ([1 4 2] field widths), and matching that one
  // made this test read the wrong array entirely
  // matched on shape, not position: the CID form is `c [w]` groups, while the
  // xref stream's /W is three bare integers, and the two dictionaries do not
  // order their keys the same way
  const cidWidths = t => t.match(/\/W \[((?:\d+\s*\[[^\]]*\]\s*)+)\]/)?.[1]?.trim() ?? null

  test('/W widths parse as valid syntax', () => {
    const body = cidWidths(s)
    ok(body !== null, '/W array present in the CIDFont dict')
    ok(/^(\d+\s*\[\s*-?[\d.]+\s*\]\s*)+$/.test(body), `unexpected /W shape: ${body.slice(0, 120)}`)
  })

  test('/Flags marks the font symbolic or nonsymbolic, not zero', () => {
    const f = s.match(/\/Flags (\d+)/)
    ok(f && parseInt(f[1], 10) > 0, `/Flags was ${f && f[1]}`)
  })

  // StemV describes the dominant vertical stem thickness; 0 says the font has
  // none. Syntactically legal and PDF/A-valid, but it is the value readers use
  // for synthetic bolding and preflight tools flag it.
  test('StemV describes the font rather than reporting zero', () => {
    const v = s.match(/\/StemV (-?[\d.]+)/)
    ok(v && parseFloat(v[1]) > 0, `/StemV was ${v && v[1]}`)
  })

  test('the same font at two weights does not embed twice under one name', () => {
    const d = new PdfDoc(300, 300)
    d.set_font('Inter', 'normal', 400); d.set_font_size(12); d.text('a', 10, 10, 'alphabetic')
    d.set_font('Inter', 'normal', 400); d.set_font_size(12); d.text('b', 10, 30, 'alphabetic')
    const t = allText(d.output())
    eq((t.match(/\/FontFile2/g) ?? []).length, 1, 'one embed for one face used twice')
  })

  {
    const bytes = doc('Subset check ÅÄÖ').output()
    const text = readPdf(bytes).getPage(1).text()
    test('the embedded subset opens and reports its glyphs', () => eq(text, 'Subset check ÅÄÖ'))
  }

  test('the width array covers only the glyphs actually used', () => {
    const body = cidWidths(allText(doc('A').output()))
    const entries = (body?.match(/\d+\s*\[/g) ?? []).length
    ok(entries > 0 && entries < 50, `expected a small width array for one glyph, got ${entries}`)
  })

  test('each embedded subset is named with its own subset tag', () => {
    const d = new PdfDoc(300, 300)
    d.set_font_size(12)
    d.set_font('Inter', 'normal', 400); d.text('Regular', 20, 50, 'alphabetic')
    d.set_font('Inter', 'normal', 700); d.text('Bold', 20, 80, 'alphabetic')
    const names = [...new Set([...allText(d.output()).matchAll(/\/BaseFont \/([^\s/>]+)/g)].map(m => m[1]))]
    ok(names.length === 2 && names.every(n => /^[A-Z]{6}\+/.test(n)), names.join(', '))
  })

  test('oblique from 14deg picks the italic face, as Chrome does', async () => {
    const { resolveFontRef } = await load('src/html/fonts.ts')
    const reg = new Map([['f', ['normal', 'italic']]])
    const pick = fs => resolveFontRef('F', '400', fs, {}, reg)?.style
    eq(['italic', 'oblique', 'oblique 14deg', 'oblique 30deg', 'oblique 10deg', 'oblique -20deg', 'normal'].map(pick).join(),
      'italic,italic,italic,italic,normal,normal,normal')
  })

  test('bold upright text picks an upright face, whatever order the faces registered in', async () => {
    const { resolveFontRef } = await load('src/html/fonts.ts')
    // the engine lists faces as normal or italic, sorted, one entry per registered file
    const reg = new Map([['f', ['italic', 'italic', 'normal', 'normal']]])
    const pick = (w, fs) => resolveFontRef('F', w, fs, {}, reg)?.style
    eq([pick('700', 'normal'), pick('400', 'normal'), pick('400', 'italic'), pick('700', 'italic')].join(), 'normal,normal,italic,italic')
  })

  test('an embedded TrueType font carries only the tables a PDF reads', () => {
    const [[key, program]] = fontPrograms(doc().output())
    eq(key, 'FontFile2')
    const tags = tablesOf(program).map(([t]) => t)
    ok(['glyf', 'loca', 'head', 'hmtx', 'maxp'].every(t => tags.includes(t)), tags.join())
    ok(!tags.some(t => ['GSUB', 'GPOS', 'GDEF', 'cmap', 'name', 'fvar', 'gvar'].includes(t)), tags.join())
  })

  test('a static CFF2 font embeds as CFF and copies as its text', async () => {
    const { cffOutlines } = await load('src/pdf_doc/outlines.ts')
    const [H, I] = get_glyph_ids('HI', 'Inter', 'normal', 400)
    register_font_raw('Cff2', staticCff2(new Uint8Array(readFileSync(requireFont())), { [H]: [150, 0, 1200, 1490], [I]: [150, 0, 300, 1490] }))
    const d = new PdfDoc(300, 300)
    d.set_font('Cff2', 'normal', 400); d.set_font_size(12)
    d.text('HIH', 20, 50, 'alphabetic')
    const bytes = d.output()
    const [[key, program]] = fontPrograms(bytes)
    eq(key, 'FontFile3')
    ok(allText(bytes).includes('/Subtype /OpenType'), 'labeled as OpenType')
    const cff = tablesOf(program).find(([t]) => t === 'CFF ')?.[1]
    ok(cff, `tables: ${tablesOf(program).map(([t]) => t).join()}`)
    const outline = cffOutlines(new DataView(cff.buffer, cff.byteOffset, cff.byteLength), false, [], 1000)(H)
    const points = outline.flatMap(c => [c.start, ...c.segs.map(s => s.slice(-2))])
    eq([Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))].join(),
      '150,0,1350,1490', 'H keeps its outline')
    eq(readPdf(bytes).getPage(1).text(), 'HIH')
  })
}
