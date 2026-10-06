import zlib from 'node:zlib'
import { readPdf } from './pdfread.mjs'

// Inflate every stream so the content operators are readable.
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
  const { PdfDoc } = await load('src/pdf_doc/index.ts')

  const NON_NUMBERS = /(?:^|[\s[(<])(NaN|-?Infinity|[\d.]+e[+-]\d+)(?=[\s\]>)]|$)/m

  test('a NaN line width does not reach the content stream', () => {
    const d = new PdfDoc(200, 200)
    d.set_line_width(NaN)
    d.line(10, 10, 50, 50)
    const s = allText(d.output())
    const hit = s.match(NON_NUMBERS)
    ok(!hit, `emitted a non-number token: ${hit && hit[1]}`)
  })

  test('NaN path coordinates do not reach the content stream', () => {
    const d = new PdfDoc(200, 200)
    d.rect(NaN, 10, 50, NaN)
    const s = allText(d.output())
    const hit = s.match(NON_NUMBERS)
    ok(!hit, `emitted a non-number token: ${hit && hit[1]}`)
  })

  test('a NaN alpha does not reach the ExtGState', () => {
    const d = new PdfDoc(200, 200)
    d.set_alpha(NaN)
    d.rect(0, 0, 10, 10)
    const s = allText(d.output())
    const hit = s.match(NON_NUMBERS)
    ok(!hit, `emitted a non-number token: ${hit && hit[1]}`)
  })

  {
    const d = new PdfDoc(200, 200)
    d.set_fill_color(255, 0, 0)
    d.rect(10, 10, 100, 50)
    d.set_page(2)
    d.rect(0, 0, 20, 20)
    const bytes = d.output()
    const doc = readPdf(bytes)
    test('a well-formed document opens in the reader', () => eq(doc.numPages, 2))
  }

  test('set_page beyond the last page does not corrupt output', () => {
    const d = new PdfDoc(200, 200)
    d.set_page(99)
    d.rect(0, 0, 10, 10)
    const out = d.output()
    ok(out.length > 0 && Buffer.from(out).toString('latin1').startsWith('%PDF'), 'still a PDF')
  })
}
