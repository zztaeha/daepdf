import zlib from 'node:zlib'
import { readFileSync } from 'node:fs'
import { readPdf } from './pdfread.mjs'
import { WASM, requireFont } from './fixtures.mjs'

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

export default async function ({ test, eq, ok, load }) {
  const m = await load('tests/_entry.ts')
  const { PdfDoc, initEngine, register_font_raw } = m
  await initEngine(readFileSync(WASM))
  register_font_raw('Inter', new Uint8Array(readFileSync(requireFont())))

  const build = (fn = () => {}) => {
    const d = new PdfDoc(300, 300)
    d.set_pdfa('en-GB')
    d.set_font('Inter', 'normal', 400); d.set_font_size(12)
    d.text('PDF/A content', 20, 50, 'alphabetic')
    fn(d)
    return d.output()
  }

  const bytes = build()
  const s = allText(bytes)

  test('PDF/A emits an OutputIntent with an ICC profile', () => {
    ok(s.includes('/OutputIntent'), 'OutputIntents array')
    ok(s.includes('/GTS_PDFA1'), 'the PDF/A subtype')
    ok(s.includes('/DestOutputProfile'), 'an embedded destination profile')
    ok(s.includes('/N 3'), 'the ICC stream declares its component count')
  })

  test('PDF/A emits XMP metadata declaring conformance', () => {
    ok(s.includes('/Type /Metadata') && s.includes('/Subtype /XML'), 'a metadata stream')
    ok(/pdfaid[:\s]/.test(s), 'the pdfaid namespace')
    ok(/part[>"']?\s*[>:]?\s*['"]?[123]/.test(s), 'a declared part')
  })

  test('PDF/A sets a document language', () => {
    ok(/\/Lang/.test(s), 'a /Lang entry')
  })

  // Conformance level A needs a tag tree, and PDF/A forbids encryption. Both are
  // enforced one layer up, in renderHTMLtoPDF (src/html/index.ts): pdfA
  // implies taggedPdf, and pdfA + security throws. Driving PdfDoc directly here
  // bypasses those, so this only records what the writer itself claims.
  test('the writer claims conformance level A', () => {
    ok(/pdfaid:conformance[^A-Z]*A/.test(s), 'level A is what the XMP declares')
  })

  test('every font in a PDF/A file is embedded', () => {
    const baseFonts = [...s.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+#-]+)/g)].map(x => x[1])
    const embedded  = (s.match(/\/FontFile[23]?\b/g) ?? []).length
    ok(baseFonts.length > 0, 'a font is referenced')
    ok(embedded > 0, `PDF/A forbids non-embedded fonts; found ${baseFonts.length} fonts, ${embedded} embedded`)
  })

  {
    let pages = 0, err = null
    try { pages = readPdf(build()).numPages }
    catch (e) { err = e.message.split('\n')[0] }
    test('PDF/A output still opens cleanly', () => { ok(err === null, `${err}`); eq(pages, 1) })
  }

  // checked directly: an encrypted file hides pdfaid inside its encrypted metadata, so
  // searching the output for it would pass for exactly the broken case
  test('the writer refuses to encrypt a PDF/A document', () => {
    const d = new PdfDoc(300, 300)
    d.set_pdfa('en')
    d.set_security('', 'owner', -3904)
    d.rect(0, 0, 10, 10)
    let threw = false
    try { d.output() } catch { threw = true }
    ok(threw, 'output() must throw rather than write an encrypted PDF/A file')
  })

  const { applyToPDF } = await load('src/pdf/index.ts')
  const rect = [{ type: 'rect', page: 1, x: 0, y: 0, w: 10, h: 10, fill: [0, 0, 0] }]

  test('the XMP mirrors every Info entry, with the same creation date', () => {
    const meta = { title: 'T', author: 'A', subject: 'S', keywords: ['k1', 'k2'], creator: 'C' }
    const out = Buffer.from(applyToPDF(rect, { config: { size: 'A4' }, pdfA: true, metadata: meta })).toString('latin1')
    const xmp = out.match(/<x:xmpmeta[\s\S]*?<\/x:xmpmeta>/)?.[0] ?? ''
    for (const tag of ['dc:title', 'dc:creator', 'dc:description', 'pdf:Keywords', 'xmp:CreatorTool']) ok(xmp.includes('<' + tag + '>'), tag)
    ok(xmp.includes('k1, k2'), 'keywords as written to Info')
    const info = out.match(/\/CreationDate \(D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)/)
    eq(xmp.match(/<xmp:CreateDate>([^<]*)</)?.[1], `${info[1]}-${info[2]}-${info[3]}T${info[4]}:${info[5]}:${info[6]}+00:00`)
  })

  test('pdfA without a security option is not encrypted by default', () => {
    const out = Buffer.from(applyToPDF(rect, { config: { size: 'A4' }, pdfA: true })).toString('latin1')
    ok(!out.includes('/Encrypt'), 'the default security must be skipped for PDF/A')
    ok(out.includes('/Metadata'), 'still a PDF/A document')
  })

  test('pdfA with an explicit security option throws', () => {
    let threw = false
    try { applyToPDF(rect, { config: { size: 'A4' }, pdfA: true, security: { userPassword: 'x' } }) } catch { threw = true }
    ok(threw, 'an explicit security option cannot be honored for PDF/A')
  })

  test('pdfUA needs a title, at the command level too', () => {
    let threw = false
    try { applyToPDF(rect, { config: { size: 'A4' }, pdfUA: true }) } catch { threw = true }
    ok(threw, 'a PDF/UA document without a title cannot conform')
    const out = Buffer.from(applyToPDF(rect, { config: { size: 'A4' }, pdfUA: true, security: null, metadata: { title: 'T' } })).toString('latin1')
    ok(/<pdfuaid:part>1<\/pdfuaid:part>/.test(out) && /\/DisplayDocTitle true/.test(out), 'identified and showing its title')
  })
}
