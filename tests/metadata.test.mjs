// Drives the real writer and reads the result back through tests/pdfread.mjs,
// so this checks what a reader actually gets, not what we think we wrote.
import { readPdf } from './pdfread.mjs'

const CASES = [
  ['ASCII', 'Quarterly Report'],
  ['Swedish', 'Årsredovisning för Åkesson'],
  ['en dash', 'Taeha Beom – CV'],
  ['Japanese', '請求書'],
  ['emoji, astral', 'Invoice \u{1F9FE} 2026'],
  ['parens and backslash', 'a(b)c\\d'],
]

export default async function ({ test, eq, ok, load }) {
  const { PdfDoc } = await load('tests/_entry.ts')

  const withTitle = title => {
    const d = new PdfDoc(200, 200)
    d.set_metadata('Title', title)
    d.set_metadata('Author', title)
    d.rect(0, 0, 10, 10)
    return d.output()
  }
  const infoOf = bytes => readPdf(bytes).info

  test('the document language is a catalog entry, not document information', () => {
    const d = new PdfDoc(200, 200)
    d.set_metadata('Lang', 'sv-SE')
    d.rect(0, 0, 10, 10)
    const pdf = readPdf(d.output())
    eq(pdf.catalogEntry('Lang'), 'sv-SE')
    eq(pdf.info.Lang, undefined)
  })

  test('an AES-256 file declares the version that defines it', () => {
    const d = new PdfDoc(200, 200)
    d.set_security('', 'owner', 0xFFFFFFFC)
    d.rect(0, 0, 10, 10)
    const bytes = d.output()
    ok(Buffer.from(bytes).toString('latin1').startsWith('%PDF-1.7'), 'header')
    const adbe = readPdf(bytes).catalogEntry('Extensions')?.get('ADBE')
    eq(adbe?.get('ExtensionLevel'), 8)
  })

  for (const [label, title] of CASES) {
    const info = await infoOf(withTitle(title))
    test(`metadata survives: ${label}`, () => {
      eq(info.Title, title, 'Title')
      eq(info.Author, title, 'Author')
    })
  }

  {
    const info = await infoOf(withTitle('line1\rline2'))
    test('a CR in metadata is preserved rather than folded to LF', () => eq(info.Title, 'line1\rline2'))
  }

  {
    const d = new PdfDoc(200, 200)
    d.set_security('', 'owner', -3904)
    d.set_metadata('Title', 'Årsredovisning – 請求書')
    d.rect(0, 0, 10, 10)
    const info = readPdf(d.output(), { password: '' }).info
    test('encrypted metadata decrypts to the same text', () => eq(info.Title, 'Årsredovisning – 請求書'))
  }

  test('a non-ASCII link URI stays ASCII in the file', () => {
    const d = new PdfDoc(200, 200)
    d.add_link_annotation(0, 0, 50, 20, 'https://example.com/sökväg?q=ä')
    const s = Buffer.from(d.output()).toString('latin1')
    const m = s.match(/\/URI \(([^)]*)\)/)
    ok(m, `no /URI literal found`)
    ok(/^[\x20-\x7E]*$/.test(m[1]), `URI is not ASCII: ${JSON.stringify(m[1])}`)
    ok(m[1].includes('%C3%B6'), `expected percent-encoded UTF-8, got ${JSON.stringify(m[1])}`)
  })

  {
    const d = new PdfDoc(200, 200)
    d.rect(0, 0, 10, 10)
    d.add_bookmark('Översikt', 1, 0, 0)
    const outline = readPdf(d.output()).outline
    test('bookmark titles survive too', () => eq(outline?.[0]?.title, 'Översikt'))
  }
}
