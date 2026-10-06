import { readPdf } from './pdfread.mjs'
import { WASM, requireFont } from './fixtures.mjs'

export default async function ({ test, eq, ok, load }) {
  const { readFileSync } = await import('node:fs')
  const m = await load('tests/_entry.ts')
  const { PdfDoc, initEngine, register_font_raw } = m
  await initEngine(readFileSync(WASM))
  register_font_raw('Inter', new Uint8Array(readFileSync(requireFont())))

  // x, y, w, h, fieldType, name, fontName, fontStyle, weight, size, color,
  // value, checked, options
  const withField = (name, value) => {
    const d = new PdfDoc(300, 300)
    d.rect(0, 0, 10, 10)
    d.add_form_field(10, 10, 120, 20, 'Tx', name,
                     'Inter', 'normal', 400, 12, [0, 0, 0],
                     value, undefined, undefined)
    return d
  }

  {
    const d = withField('fullName', 'Taeha')
    let anns = []
    try {
      anns = readPdf(d.output()).getPage(1).annotations()
    } catch (e) { anns = [{ error: e.message }] }
    test('one widget annotation', () => ok(anns.length >= 1, JSON.stringify(anns)))
    test('field name preserved', () =>
      ok(anns.some(a => a.fieldName === 'fullName'), JSON.stringify(anns.map(a => a.fieldName))))
  }

  {
    const d = withField('namn', 'Åkesson')
    const anns = readPdf(d.output()).getPage(1).annotations()
    test('a non-ASCII field value survives', () =>
      ok(anns.some(a => a.fieldValue === 'Åkesson'), JSON.stringify(anns.map(a => a.fieldValue))))
  }

  {
    const d = new PdfDoc(300, 300)
    for (const [i, v] of ['a', 'b', 'c'].entries()) {
      d.add_form_field(10, 10 + i * 30, 120, 20, 'Tx', 'q', 'Inter', 'normal', 400, 12, [0, 0, 0], v, undefined, undefined)
    }
    const names = readPdf(d.output()).getPage(1).annotations().map(a => a.fieldName)
    test('same-named fields get unique names', () => eq(names.join(','), 'q,q_2,q_3'))
  }

  {
    const d = new PdfDoc(300, 300)
    d.add_form_field(10, 10, 120, 20, 'Ch', 'country', 'Inter', 'normal', 400, 12, [0, 0, 0], 'us', undefined,
                     ['Sweden', 'United States'], { flags: 1 << 17, display: 'United States', exportValues: ['se', 'us'] })
    d.add_form_field(10, 40, 120, 20, 'Tx', 'pw', 'Inter', 'normal', 400, 12, [0, 0, 0], '', undefined, undefined,
                     { flags: 1 << 13, display: '•••' })
    d.add_form_field(10, 70, 120, 40, 'Tx', 'notes', 'Inter', 'normal', 400, 12, [0, 0, 0], 'one\ntwo', undefined, undefined,
                     { flags: 1 << 12 })
    const anns = readPdf(d.output()).getPage(1).annotations()
    const by = n => anns.find(a => a.fieldName === n)
    test('select is a combo box', () => eq(by('country')?.fieldFlags, 1 << 17))
    test('options carry export value and display text', () =>
      eq(JSON.stringify(by('country')?.fieldOptions), JSON.stringify([['se', 'Sweden'], ['us', 'United States']])))
    test('select value is the export value', () => eq(by('country')?.fieldValue, 'us'))
    test('password field is flagged and holds no value', () => {
      eq(by('pw')?.fieldFlags, 1 << 13)
      ok(!by('pw')?.fieldValue, `password value leaked: ${by('pw')?.fieldValue}`)
    })
    test('textarea is multiline', () => eq(by('notes')?.fieldFlags, 1 << 12))
    test('form fields print with the page', () => ok(anns.every(a => a.flags === 4), JSON.stringify(anns.map(a => a.flags))))
  }

  {
    const d = withField('förnamn', 'x')
    const anns = readPdf(d.output()).getPage(1).annotations()
    test('a non-ASCII field NAME survives', () =>
      ok(anns.some(a => a.fieldName === 'förnamn'), JSON.stringify(anns.map(a => a.fieldName))))
  }
}
