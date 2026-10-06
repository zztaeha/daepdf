import { readFileSync } from 'node:fs'
import { WASM, requireFont } from './fixtures.mjs'

export default async function ({ test, ok, load }) {
  const m = await load('tests/_entry.ts')
  const { PdfDoc, initEngine, register_font_raw } = m
  await initEngine(readFileSync(WASM))
  register_font_raw('Inter', new Uint8Array(readFileSync(requireFont())))
  const { aesCbcEncrypt } = await load('src/pdf_doc/aes.ts')

  test('encryptedLength matches what encryption actually produces', () => {
    const d = new PdfDoc(200, 200)
    d.set_security('', 'owner', -3904)
    const key = new Uint8Array(32).fill(7)
    const bad = []
    for (const n of [0, 1, 15, 16, 17, 31, 32, 33, 100, 4096]) {
      const real = 16 + aesCbcEncrypt(key, new Uint8Array(16), new Uint8Array(n), true).length
      const declared = d.encryptedLength(n)
      if (real !== declared) bad.push(`len ${n}: declared ${declared}, real ${real}`)
    }
    ok(bad.length === 0, bad.join(' | '))
  })

  test('every /Length in an encrypted document matches its real stream', () => {
    const d = new PdfDoc(300, 300)
    d.set_security('', 'owner-pw', -3904)
    d.set_font('Inter', 'normal', 400); d.set_font_size(12)
    d.text('Encrypted content here', 20, 100, 'alphabetic')
    d.set_fill_color(1, 2, 3); d.rect(10, 10, 50, 50)
    d.set_metadata('Title', 'Secret')
    const buf = Buffer.from(d.output())
    const s = buf.toString('latin1')
    const bad = []
    for (const mm of s.matchAll(/\/Length (\d+)[\s\S]{0,500}?stream\r?\n/g)) {
      const declared = parseInt(mm[1], 10)
      const start = mm.index + mm[0].length
      const end = s.indexOf('endstream', start)
      const actual = end - start
      if (actual !== declared && actual !== declared + 1 && actual !== declared + 2) {
        bad.push(`declared ${declared}, real ${actual}`)
      }
    }
    ok(bad.length === 0, bad.join(' | '))
  })

  test('an encrypted document declares the right handler', () => {
    const d = new PdfDoc(200, 200)
    d.set_security('', 'pw', -3904)
    d.rect(0, 0, 10, 10)
    const s = Buffer.from(d.output()).toString('latin1')
    ok(s.includes('/Filter /Standard'), 'standard security handler')
    ok(/\/V 5/.test(s) && /\/R 6/.test(s), 'V5/R6')
    ok(s.includes('/AESV3'), 'AESV3 crypt filter')
  })
}
