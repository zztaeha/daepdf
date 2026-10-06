import { readPdf } from './pdfread.mjs'

export default async function ({ test, eq, ok, load }) {
  const { PdfDoc } = await load('src/pdf_doc/index.ts')

  const build = () => {
    const d = new PdfDoc(300, 300)
    d.set_fill_color(10, 20, 30)
    d.rect(10, 10, 100, 50)
    d.save_graphics_state()
    d.set_alpha(0.5)
    d.rect(20, 20, 30, 30)
    d.restore_graphics_state()
    d.set_page(2)
    d.line(0, 0, 100, 100)
    return d
  }

  test('calling output() twice yields the same bytes', () => {
    const d = build()
    const a = d.output()
    const b = d.output()
    ok(a.length === b.length,
      `second output() differs in length: ${a.length} then ${b.length}`)
  })

  {
    const d = build()
    d.output()
    const second = d.output()
    let err = null, pages = 0
    try {
      pages = readPdf(second).numPages
    } catch (e) { err = e.message.split('\n')[0] }
    test('the second output() is still a readable PDF', () => {
      ok(err === null, `the reader could not open it: ${err}`)
      eq(pages, 2, 'page count after a second output()')
    })
  }

  test('every /Length matches its real stream end', () => {
    const buf = Buffer.from(build().output())
    const s = buf.toString('latin1')
    const problems = []
    for (const m of s.matchAll(/\/Length (\d+)[\s\S]{0,400}?stream\r?\n/g)) {
      const declared = parseInt(m[1], 10)
      const start = m.index + m[0].length
      const end = s.indexOf('endstream', start)
      const actual = end - start
      // writers may emit a trailing EOL before endstream
      if (actual !== declared && actual !== declared + 1 && actual !== declared + 2) {
        problems.push(`declared ${declared}, real ${actual}`)
      }
    }
    ok(problems.length === 0, problems.join(' | '))
  })

  {
    const zlib = await import('node:zlib')
    const buf = Buffer.from(build().output())
    const s = buf.toString('latin1')
    const bad = []
    let n = 0
    for (const m of s.matchAll(/stream\r?\n/g)) {
      const start = m.index + m[0].length
      const end = buf.indexOf('endstream', start)
      let body
      try { body = zlib.inflateSync(buf.subarray(start, end)).toString('latin1') } catch { continue }
      if (!/(^|\s)(re|m|Tf)(\s|$)/.test(body)) continue
      n++
      const q = (body.match(/(^|\s)q(\s|$)/g) ?? []).length
      const Q = (body.match(/(^|\s)Q(\s|$)/g) ?? []).length
      if (q !== Q) bad.push(`stream ${n}: ${q} q vs ${Q} Q`)
    }
    test(`graphics state balanced across ${n} content stream(s)`, () => {
      ok(bad.length === 0, bad.join(' | '))
    })
  }
}
