// Issue #2: templates lay out in a page-sized frame, so media queries, vw and the preview
// follow the PDF page, not the browser window. Runs in a 1600px-wide headless Chrome.
import { browserUnavailable, runSuitePage } from './browser.mjs'

const PAGE_W_PT = 595.28

// Quasar-style breakpoints: on a 794px A4 page only the base rule applies
const grid = p => `.${p}row{display:flex;flex-wrap:wrap}:where(.${p}row>div){width:100%;height:20px}` +
  `.${p}row>div:nth-child(odd){background:#f00}.${p}row>div:nth-child(even){background:#00f}` +
  `@media (min-width:1024px){.${p}md{width:50%}}@media (min-width:1440px){.${p}lg{width:25%}}`
const cells = p => `<div class="${p}row">${`<div class="${p}md ${p}lg"></div>`.repeat(4)}</div>`

export default async function ({ test, ok }) {
  const why = browserUnavailable()
  if (why) { console.log(`  frame: skipped, ${why}`); return }

  const r = await runSuitePage(test, {
    head: `<style>${grid('h')}</style>`,
    body: '<div id="pv" style="zoom:0.5"></div>',
    script: `
      const grid = ${grid}, cells = ${cells}
      const widths = async html => (await D.fromHTML(html, { size: 'A4' })).commands
        .filter(c => c.type === 'rect' && c.fill).map(c => c.w)
      const pv = document.getElementById('pv')
      await D.previewHTML('<style>' + grid('p') + '</style>' + cells('p'), pv, { size: 'A4' })
      const frame = pv.querySelector('iframe')
      return {
        template: await widths('<style>' + grid('t') + '</style>' + cells('t')),
        host:     await widths(cells('h')),
        vw:       await widths('<div style="width:50vw;height:20px;background:#f00"></div>'),
        previewViewport: frame ? frame.contentWindow.innerWidth : null,
        previewCell:     frame ? frame.contentDocument.querySelector('.prow > div').getBoundingClientRect().width : null,
      }`,
  })
  if (!r) return
  const fullWidth = ws => ws.length === 4 && ws.every(w => Math.abs(w - PAGE_W_PT) < 0.5)

  test('template @media resolves against the page, not the window', () =>
    ok(fullWidth(r.template), `expected 4 full-width rows, got ${JSON.stringify(r.template)}`))
  test('host stylesheet @media resolves against the page', () =>
    ok(fullWidth(r.host), `expected 4 full-width rows, got ${JSON.stringify(r.host)}`))
  test('vw is relative to the page', () =>
    ok(r.vw?.length === 1 && Math.abs(r.vw[0] - PAGE_W_PT / 2) < 0.5, `expected ${PAGE_W_PT / 2}pt, got ${JSON.stringify(r.vw)}`))
  test('preview frame keeps a page-sized viewport inside a zoomed container', () => {
    ok(r.previewViewport === 794, `expected a 794px frame viewport, got ${r.previewViewport}`)
    ok(Math.abs(r.previewCell - 793.7) < 1, `expected a full-width cell, got ${r.previewCell}`)
  })
}
