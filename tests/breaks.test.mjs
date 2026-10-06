// The page-break engine needs a real layout engine, so these run inside headless Chrome.
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findChrome } from './chrome.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const PAGE_H = 841.89 * 96 / 72
const PAGE_W = 595.28 * 96 / 72
const IMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="black"/></svg>')

const para = n => Array.from({ length: n }, (_, i) => `<p data-text>Line ${i} lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor.</p>`).join('')
const grid = inner => `<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;align-items:start">${inner}</div>`
const card = h => `<div class="card" style="height:${h}px"></div>`

// data-whole: must end up on one page; data-top: must start a page; data-text: no line cut
const FIXTURES = [
  { name: 'issue #1: tall grid, image inside a cell',
    html: grid(card(400) + card(400) + card(300) + `<div class="card"><img data-whole width="360" height="800" src="${IMG}"></div>` + card(300) + card(300)),
    expect: { spacers: 1, margins: 0 } },
  { name: 'tall flex column wrapper with an image',
    html: `<div style="display:flex;flex-direction:column;gap:16px"><div style="height:900px"></div><img data-whole width="300" height="400" src="${IMG}">${para(6)}</div>`,
    expect: { spacers: 0, margins: 1 } },
  { name: 'image as the grid item itself',
    html: grid(card(400) + card(400) + card(300) + `<img data-whole width="360" height="800" src="${IMG}">` + card(300) + card(300)),
    expect: { spacers: 0, margins: 1 } },
  { name: 'short grid crossing the boundary is pushed whole',
    html: `<div style="height:900px"></div><div data-whole style="display:grid;grid-template-columns:1fr 1fr;gap:24px">${card(300)}${card(300)}</div>`,
    expect: { spacers: 1, margins: 0 } },
  { name: 'flex card inside a tall grid',
    html: grid(card(400) + card(400) + card(300) + `<div class="card" data-whole style="display:flex;flex-direction:column;height:800px"><span>caption</span></div>` + card(300) + card(300)),
    expect: { spacers: 0, margins: 1 } },
  { name: 'break-before: page on a grid item',
    html: grid(card(200) + card(200) + `<div class="card" data-top style="break-before:page;height:200px"></div>` + card(200)),
    expect: { spacers: 0, margins: 1 } },
  { name: 'two-column flex row with paragraphs',
    html: `<div style="display:flex;gap:24px"><div style="width:200px;height:1500px"></div><div style="flex:1">${para(60)}</div></div>`,
    expect: { margins: 0 } },
  { name: 'plain block-flow image',
    html: `<div style="height:900px"></div><img data-whole width="300" height="400" src="${IMG}">`,
    expect: { spacers: 1, margins: 0 } },
]

const PAGE = `<!doctype html><meta charset="utf-8">
<style>body{margin:0;font:16px/24px sans-serif}.card{border:1px solid #ccc;box-sizing:border-box}.card img{display:block;max-width:100%}</style>
<pre id="out"></pre><script src="breaks.js"></script><script>
const PAGE_H = ${PAGE_H}, FIXTURES = ${JSON.stringify(FIXTURES.map(f => f.html))}
const pageOf = (rel) => Math.floor(rel / PAGE_H)
function violations(root, top) {
  const bad = []
  for (const el of root.querySelectorAll('[data-whole]')) {
    const r = el.getBoundingClientRect()
    if (pageOf(r.top - top + 0.5) !== pageOf(r.bottom - top - 0.5)) bad.push('cut ' + el.tagName + ' ' + (r.top - top).toFixed(1) + '-' + (r.bottom - top).toFixed(1))
  }
  for (const el of root.querySelectorAll('[data-top]')) {
    const rel = (el.getBoundingClientRect().top - top) % PAGE_H
    if (rel >= 1 && rel <= PAGE_H - 1) bad.push('not at page top ' + rel.toFixed(1))
  }
  for (const el of root.querySelectorAll('[data-text]')) {
    const range = document.createRange()
    range.selectNodeContents(el)
    for (const r of range.getClientRects()) {
      if (r.height > 0.5 && pageOf(r.top - top + 0.5) !== pageOf(r.bottom - top - 0.5)) { bad.push('cut line ' + (r.top - top).toFixed(1)); break }
    }
  }
  return bad
}
const results = []
for (const html of FIXTURES) {
  const root = document.createElement('div')
  root.style.cssText = 'position:fixed;top:0;left:0;width:${PAGE_W}px;overflow:visible;transform:translateZ(0)'
  root.innerHTML = html
  document.body.appendChild(root)
  const before = root.innerHTML
  const warnings = []
  const warn = console.warn
  console.warn = (...a) => warnings.push(a.join(' '))
  Breaks.applyPageBreaks(root, PAGE_H)
  console.warn = warn
  const bad = violations(root, root.getBoundingClientRect().top)
  const spacers = root.querySelectorAll('[data-tpdf-break]').length
  const margins = root.querySelectorAll('[data-tpdf-break-margin]').length
  Breaks.undoPageBreaks(root)
  results.push({ bad, spacers, margins, warnings, undoClean: root.innerHTML === before })
  root.remove()
}
document.getElementById('out').textContent = JSON.stringify(results)
</script>`

async function runInChrome(chrome) {
  const dir = mkdtempSync(path.join(tmpdir(), 'daepdf-breaks-'))
  const bundle = await build({
    entryPoints: [path.join(ROOT, 'src/html/breaks.ts')],
    bundle: true, write: false, format: 'iife', globalName: 'Breaks', target: 'es2022',
  })
  writeFileSync(path.join(dir, 'breaks.js'), bundle.outputFiles[0].text)
  writeFileSync(path.join(dir, 'page.html'), PAGE)
  const dom = execFileSync(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox', '--window-size=1200,1200',
    '--virtual-time-budget=3000', '--dump-dom', `file://${dir}/page.html`,
  ], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 }).toString()
  const m = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/)
  if (!m) throw new Error('page produced no results')
  return JSON.parse(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
}

export default async function ({ test, eq, ok }) {
  const chrome = findChrome()
  if (!chrome) { console.log('  breaks: skipped, no Chrome found (set CHROME_BIN)'); return }
  const results = await runInChrome(chrome)

  FIXTURES.forEach((f, i) => test(f.name, () => {
    const r = results[i]
    eq(r.bad.join('; '), '', 'nothing may be cut')
    eq(r.warnings.join('; '), '', 'no fix-cap warning')
    ok(r.undoClean, 'undoPageBreaks must restore the DOM byte for byte')
    for (const [k, v] of Object.entries(f.expect)) eq(r[k], v, k)
  }))
}
