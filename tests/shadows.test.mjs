import zlib from 'node:zlib'

function alphasIn(bytes) {
  const buf = Buffer.from(bytes)
  const s = buf.toString('latin1')
  // /ca entries in the ExtGState dictionaries
  return [...s.matchAll(/\/ca ([\d.]+)/g)].map(m => parseFloat(m[1]))
}
function contentOf(bytes) {
  const buf = Buffer.from(bytes)
  let out = ''
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length
    const end = buf.indexOf('endstream', start)
    try { out += zlib.inflateSync(buf.subarray(start, end)).toString('latin1') } catch {}
  }
  return out
}

export default async function ({ test, eq, ok, load }) {
  const { PdfDoc } = await load('tests/_entry.ts')
  const { emitShadows } = await load('src/pdf/shadows.ts')

  const square = { tl: { h: 0, v: 0 }, tr: { h: 0, v: 0 }, br: { h: 0, v: 0 }, bl: { h: 0, v: 0 } }
  const draw = shadows => {
    const d = new PdfDoc(300, 300)
    emitShadows(d, shadows, 50, 50, 100, 60, square)
    d.rect(50, 50, 100, 60)
    return d
  }

  test('an opaque hard shadow paints at full strength', () => {
    // box-shadow: 5pt 5pt 0 rgb(255,0,0) — no blur, so it is a solid offset copy
    const d = draw([{ x: 5, y: 5, blur: 0, color: [255, 0, 0, 255], inset: false }])
    const alphas = alphasIn(d.output()).filter(a => a < 1)
    ok(alphas.length === 0,
      `a zero-blur shadow should be opaque, but was painted at ${alphas.join(', ')}`)
  })

  test('the element\'s opacity and blend mode apply to its shadow', () => {
    const d = new PdfDoc(300, 300)
    emitShadows(d, [{ x: 0, y: 0, blur: 0, spread: 10, color: [0, 0, 0, 255], inset: false }], 50, 50, 100, 60, square, 0.3, 'Multiply')
    const out = Buffer.from(d.output()).toString('latin1')
    eq(alphasIn(d.output()).filter(a => a < 1).join(), '0.3')
    ok(/\/BM \/Multiply/.test(out), 'no Multiply blend on the shadow')
  })

  test('a blurred shadow still emits layers', () => {
    const d = draw([{ x: 0, y: 0, blur: 20, color: [0, 0, 0, 255], inset: false }])
    const c = contentOf(d.output())
    ok((c.match(/ re\b/g) ?? []).length > 5, 'expected several banded rects')
  })

  test('shadow layer count stays bounded for an absurd blur', () => {
    const d = draw([{ x: 0, y: 0, blur: 100000, color: [0, 0, 0, 255], inset: false }])
    const c = contentOf(d.output())
    const rects = (c.match(/ re\b/g) ?? []).length
    ok(rects <= 70, `expected the 60-step cap to hold, got ${rects} rects`)
  })

  // height is emitted negative throughout: PDF's origin is bottom-left and this
  // codebase draws from a top-left frame, so only a ZERO extent is degenerate
  test('a negative spread does not produce a zero-size rect', () => {
    const d = draw([{ x: 0, y: 0, blur: 2, spread: -200, color: [0, 0, 0, 255], inset: false }])
    const c = contentOf(d.output())
    const bad = [...c.matchAll(/(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+) re/g)]
      .filter(m => Math.abs(parseFloat(m[3])) === 0 || Math.abs(parseFloat(m[4])) === 0)
    ok(bad.length === 0, `zero-size rect emitted: ${bad.map(m => m[0]).join(' | ')}`)
  })

  test('graphics state is balanced around every shadow', () => {
    const c = contentOf(draw([
      { x: 2, y: 2, blur: 4, color: [0, 0, 0, 128], inset: false },
      { x: 0, y: 0, blur: 6, color: [0, 0, 0, 128], inset: true },
    ]).output())
    const q = (c.match(/(^|\s)q(\s|$)/g) ?? []).length
    const Q = (c.match(/(^|\s)Q(\s|$)/g) ?? []).length
    eq(q, Q, 'q/Q balance')
  })
}
