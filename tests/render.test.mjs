// Capture-level regressions that need a real layout engine. One page runs every check;
// each test below asserts on its slice of the result.
import { browserUnavailable, hasTestFont, runSuitePage } from './browser.mjs'
import { readPdf } from './pdfread.mjs'
import zlib from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import { FONT as FONT_FILE } from './fixtures.mjs'

// a solid-color 8-bit RGB PNG, built here so the suite needs no binary fixtures
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = buf => { let c = 0xFFFFFFFF; for (const x of buf) c = crcTable[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data]), sum = Buffer.alloc(4); sum.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, sum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk('IEND', Buffer.alloc(0))])
}

const FONT = '<style>@font-face{font-family:T;src:url(font.ttf)}</style>'
// a Hebrew font without Latin digits, for RTL font fallback; macOS ships one, elsewhere it's skipped
const HEBREW = '/System/Library/Fonts/SFHebrew.ttf'
const hasHebrew = existsSync(HEBREW)

const SCRIPT = `
const FONT = ${JSON.stringify(FONT)}
const HAS_HEBREW = ${hasHebrew}
const cap = async (html, extra) => (await D.fromHTML(html, { size: 'A4' }, {}, extra)).commands
const pixels = async png => {
  const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }))
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
  const x = c.getContext('2d'); x.drawImage(bmp, 0, 0)
  return x.getImageData(0, 0, c.width, c.height).data
}
const out = {}

// filter/mask rasters paint text with the template's own font
{
  const raster = async family => (await cap(FONT + '<div style="filter:grayscale(0.01);font:40px ' + family + ';width:200px;height:60px">Wg</div>'))
    .find(c => c.type === 'image')?.src
  const a = await raster('T'), b = await raster('serif')
  if (a && b) {
    const pa = await pixels(a), pb = await pixels(b)
    let diff = 0
    for (let i = 3; i < pa.length; i += 4) if (Math.abs(pa[i] - pb[i]) > 64) diff++
    out.filterFontDiffers = diff > 50
  }
}

// form controls: unique names, flags, masked password, select display text
{
  const html = FONT + '<div style="font-family:T"><input name="q" value="one" style="font-family:T"><input name="q" value="two" style="font-family:T">' +
    '<input type="password" name="pw" value="hunter2" style="font-family:T">' +
    '<select name="c" style="font-family:T"><option value="se">Sweden</option><option value="us" selected>United States</option></select>' +
    '<textarea name="t" style="font-family:T">a&#10;b</textarea><input name="ro" value="x" readonly style="font-family:T">' +
    '<select name="dis" disabled style="font-family:T"><option>a</option></select><input type="checkbox" name="cb" disabled></div>'
  const fields = (await cap(html)).filter(c => c.type === 'field')
  out.passwordCapture = fields.find(f => f.name === 'pw')
  out.formsPdf = toB64(await D.renderHTMLtoPDF(html, { size: 'A4' }, { security: null }))
}

// link and field annotations follow the content under a header, and sit in the footer band
out.chromePdf = toB64(await D.renderHTMLtoPDF(
  '<div style="padding:20px"><a href="https://e.com/c" style="display:inline-block;width:40px;height:30px">L</a><br><input name="f"></div>',
  { size: 'A4' },
  { security: null, header: () => '<div style="height:72px"></div>',
    footer: () => '<div style="height:40px"><a href="https://e.com/f" style="display:inline-block;width:40px;height:20px">F</a></div>' }))

// pseudo-elements land where the browser draws them
{
  const css = '<style>.p{font:14px T;padding:20px}.a::before{content:"AB "}.h::before{content:"LABEL";display:block}' +
    '.j{display:flex;gap:8px}.j::before{content:"";width:12px;height:12px;background:#e33}</style>'
  const cmds = await cap(FONT + css + '<div class="p"><p class="a">Hello</p><div class="h">Body</div><div class="j">Flex</div></div>')
  const t = name => cmds.find(c => c.type === 'text' && c.text.trim() === name)
  out.pseudo = { ab: t('AB'), hello: t('Hello'), label: t('LABEL'), body: t('Body'),
    flexIcon: cmds.some(c => c.type === 'rect' && c.fill && c.fill[0] === 238 && Math.abs(c.w - 9) < 0.1) }
}

// inline SVG paints what its stylesheet says, not just its attributes
{
  const html = '<style>.ic path{fill:#e33}.st{stroke:#3a3;stroke-width:4px}.sp{color:#36c}</style>' +
    '<svg class="ic" width="40" height="40" viewBox="0 0 10 10"><path d="M0 0H10V10H0Z"/></svg>' +
    '<svg width="40" height="40" viewBox="0 0 10 10"><g opacity="0.5"><rect width="10" height="10" fill="#00f"/></g></svg>' +
    '<svg width="40" height="40" viewBox="0 0 10 10"><rect width="10" height="10" fill="steelblue"/><rect width="5" height="5" fill="#f00" display="none"/></svg>' +
    '<svg width="40" height="40" viewBox="0 0 10 10"><line class="st" x1="0" y1="5" x2="10" y2="5"/></svg>' +
    '<svg class="sp" width="40" height="40" viewBox="0 0 10 10"><defs><symbol id="s"><path d="M0 0H10V10H0Z"/></symbol></defs><use href="#s" fill="currentColor"/></svg>'
  out.svg = (await cap(html)).filter(c => c.type === 'path').map(c => ({ fill: c.fill, stroke: c.stroke, w: c.strokeWidth, op: c.opacity }))
  const sized = (await cap('<svg width="40" height="40" viewBox="0 0 10 10"><defs><symbol id="b" viewBox="0 0 100 100"><path d="M0 0H100V100H0Z"/></symbol></defs><use href="#b" width="5" height="5"/></svg>'))
    .find(c => c.type === 'path')
  const xs = sized ? sized.ops.flatMap(o => o.args.filter((_, i) => i % 2 === 0)) : []
  out.symbolWidth = xs.length ? Math.max(...xs) - Math.min(...xs) : null
}

// radial gradients resolve to the CSS ending shape against their box
{
  const g = async bg => (await cap('<div style="width:300px;height:100px;background:' + bg + '"></div>')).find(c => c.gradient)?.gradient
  const r4 = v => Math.round(v * 1e4) / 1e4
  const pick = x => x && [r4(x.cx), r4(x.cy), r4(x.rx), r4(x.ry)]
  out.radial = { dflt: pick(await g('radial-gradient(red, blue)')), sized: pick(await g('radial-gradient(60px 30px at 20px 30px, red, blue)')),
    circle: pick(await g('radial-gradient(circle closest-side at 25% 50%, red, blue)')) }
}

// list markers: reversed lists, string and greek styles
out.markers = (await cap(FONT + '<div style="font-family:T">' +
  '<ol reversed><li>a</li><li>b</li><li>c</li></ol><ol reversed start="10"><li>x</li><li>y</li></ol>' +
  '<ul style="list-style-type:' + "'→ '" + '"><li>s</li></ul><ol style="list-style-type:lower-greek"><li>g</li><li>h</li></ol></div>'))
  .filter(c => c.type === 'text' && !/^[a-z]$/.test(c.text)).map(c => c.text)

// italic text in a family with no italic face is slanted, as the browser synthesizes it
out.skew = await Promise.all(['italic', 'oblique', 'oblique 20deg', 'oblique 10deg', 'normal'].map(async fs =>
  (await cap(FONT + '<p style="font:16px T;font-style:' + fs + '">Slant</p>')).find(c => c.type === 'text')?.skew ?? 0))
out.skewOff = (await cap(FONT + '<p style="font:italic 16px T;font-synthesis:none">Slant</p>')).find(c => c.type === 'text')?.skew ?? 0

// small caps are synthesized the way Chrome does it, and land where Chrome puts them
{
  const caps = async mode => (await cap(FONT + '<p style="margin:0;font:20px T;white-space:nowrap;font-variant-caps:' + mode + '">Hello, World</p>'))
    .filter(c => c.type === 'text').map(c => [c.text, Math.round(c.size * 100) / 100, c.x])
  out.caps = { sc: await caps('small-caps'), all: await caps('all-small-caps'), uni: await caps('unicase') }
  document.head.insertAdjacentHTML('beforeend', FONT)
  const probe = document.createElement('span')
  probe.style.cssText = 'font:20px T;white-space:pre;font-variant-caps:small-caps;font-optical-sizing:none'
  probe.textContent = 'Hello, W'
  document.body.appendChild(probe)
  await document.fonts.load('20px T'); await document.fonts.ready
  out.capsChromeX = probe.getBoundingClientRect().width * 0.75
  probe.remove()
}

// the sanitizer removes what the README lists, and keeps an inline SVG's embedded image
{
  const c = document.createElement('canvas'); c.width = c.height = 4
  const g = c.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 4, 4)
  const png = c.toDataURL()
  const html = '<a id="js" href="javascript:alert(1)">a</a><a id="dt" href="data:text/html,x">b</a><a id="vb" href=" vbscript:x">c</a>' +
    '<a id="ok" href="https://e.com/" onclick="alert(1)">d</a><scr' + 'ipt>window.ran = 1</scr' + 'ipt><iframe></iframe>' +
    '<svg width="40" height="40" viewBox="0 0 4 4"><a id="sa" xlink:href="javascript:alert(1)"><rect width="1" height="1"/></a>' +
    '<image id="si" href="' + png + '" width="4" height="4"/></svg>'
  const pv = document.createElement('div'); document.body.appendChild(pv)
  await D.previewHTML(html, pv, { size: 'A4' })
  const fd = pv.querySelector('iframe')?.contentDocument ?? document
  const attr = (id, name) => fd.getElementById(id)?.getAttribute(name) ?? null
  out.sanitized = {
    hrefs: ['js', 'dt', 'vb', 'ok'].map(id => attr(id, 'href')), onclick: attr('ok', 'onclick'),
    svgLink: fd.getElementById('sa')?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? null,
    svgImage: attr('si', 'href') === png, script: fd.querySelectorAll('script, iframe').length, ran: !!window.ran,
  }
  pv.remove()
  const cmds = await cap(html)
  await D.rasterizeSVGs(cmds)
  const img = cmds.find(cm => cm.type === 'image')
  if (img?.format === 'png') {
    const px = await pixels(img.src)
    const mid = (Math.floor(px.length / 8) & ~3)
    out.sanitized.svgImageRed = px[mid] > 200 && px[mid + 1] < 50 && px[mid + 3] > 200
  }
}

// url() background layers paint in their CSS slot: under the layers above them and the border
{
  const order = cmds => cmds.map(c => c.type === 'image' || c.type === 'raw-image' ? 'img' : c.gradient ? 'grad' : c.type === 'path' || c.type === 'line' ? 'border' : null).filter(Boolean)
  const uniq = list => list.filter((v, i) => v !== list[i - 1]).join(' ')
  out.bgOrder = {
    tint: uniq(order(await cap('<div style="width:120px;height:80px;background:linear-gradient(rgba(0,0,0,.6),rgba(0,0,0,.6)),url(red.png) center/cover"></div>'))),
    under: uniq(order(await cap('<div style="width:120px;height:80px;border:8px dashed #00f;background:url(red.png) 0 0/10px 10px"></div>'))),
    root: (await cap('<style>body{background:url(red.png) 0 0/20px 20px}</style><p>x</p>')).filter(c => c.type === 'image' || c.type === 'raw-image').length,
  }
}

// a line broken at a soft hyphen shows the hyphen and starts the next line at the right letter
out.softHyphen = (await cap(FONT + '<div style="font:20px T;width:130px">Broken su&shy;per&shy;cali&shy;fragilistic</div>'))
  .filter(c => c.type === 'text').map(c => [c.text.replace(/\u00AD/g, ''), Math.round(c.x)])

// transforms: links follow their element, and a pivot on a later page uses that page's coordinates
{
  const chromeBox = (html, sel, pageOffsetPx = 0) => {
    const host = document.createElement('div')
    host.style.cssText = 'position:absolute;left:0;top:0;width:794px'
    host.innerHTML = html
    document.body.appendChild(host)
    const hr = host.getBoundingClientRect(), r = host.querySelector(sel).getBoundingClientRect()
    host.remove()
    return [r.left - hr.left, r.top - hr.top - pageOffsetPx, r.width, r.height].map(v => Math.round(v * 0.75))
  }
  const linkHtml = '<div style="position:relative;height:200px"><div style="position:absolute;left:300px;top:100px;transform:translate(-50%,-50%) scale(2)"><a href="https://e.com/" style="display:inline-block;width:40px;height:20px">L</a></div></div>'
  const link = (await cap(linkHtml)).find(c => c.type === 'link')
  out.transformedLink = { ours: link && [link.x, link.y, link.w, link.h].map(Math.round), chrome: chromeBox(linkHtml, 'a') }

  const boxHtml = '<div style="height:1300px"></div><div id="tb" style="margin-left:200px;width:200px;height:100px;background:#f00;transform:scale(0.5) rotate(10deg)"></div>'
  out.page2Transform = { pdf: toB64(await D.renderHTMLtoPDF(boxHtml, { size: 'A4' }, { security: null })), chrome: chromeBox(boxHtml, '#tb', 841.89 / 0.75) }
  // the same under a header and footer, whose bands change the content area's height
  const banded = '<div style="height:100px"></div><div id="tb" style="margin-left:200px;width:200px;height:100px;background:#f00;transform:rotate(30deg)"></div>'
  out.bandedTransform = {
    pdf: toB64(await D.renderHTMLtoPDF(banded, { size: 'A4' }, { security: null, header: () => '<div style="height:150px"></div>', footer: () => '<div style="height:60px"></div>' })),
    chrome: chromeBox(banded, '#tb').map((v, i) => i === 1 ? v + 112.5 : v),
  }
  // a gradient below a header lines up with its box
  out.gradientUnderHeader = toB64(await D.renderHTMLtoPDF('<div style="height:100px;background:linear-gradient(#f00,#00f)"></div>', { size: 'A4' },
    { security: null, header: () => '<div style="height:150px"></div>' }))
}

// a wrapped inline box in RTL keeps its right (start) border on the first fragment
out.rtlFragments = (await cap(FONT + '<div dir="rtl" style="font:16px T;width:200px">abc <span style="border:4px solid #00f;border-right-color:#f00;border-left-color:#0a0">one two three four five six</span> end</div>'))
  .filter(c => c.type === 'path' && (c.fill[0] === 255 || c.fill[1] === 170)).map(c => c.fill[0] === 255 ? 'right' : 'left')

// a conic gradient's px center resolves against its box: centered on the top-left corner,
// the box sits entirely in the blue quarter-turns
{
  const img = (await cap('<div style="width:100px;height:60px;background:conic-gradient(at 0px 0px, #f00 0 25%, #00f 25% 100%)"></div>'))
    .find(c => c.type === 'image')
  if (img) {
    const px = await pixels(img.src), bmp = await createImageBitmap(new Blob([img.src], { type: 'image/png' }))
    const at = (x, y) => Array.from(px.slice((y * bmp.width + x) * 4, (y * bmp.width + x) * 4 + 3)).join()
    out.conicCorner = [at(bmp.width - 2, 1), at(bmp.width >> 1, bmp.height >> 1)]
  }
}

// mix-blend-mode reaches images, background tiles and SVG shapes, not just boxes and text
out.imageBlend = (await cap('<div style="background:#cde;padding:4px">' +
  '<img src="red.png" style="width:20px;height:20px;mix-blend-mode:multiply">' +
  '<div style="width:20px;height:20px;background:url(red.png);mix-blend-mode:multiply"></div>' +
  '<svg width="20" height="20" viewBox="0 0 2 2" style="mix-blend-mode:multiply"><rect width="2" height="2" fill="#f00"/></svg></div>'))
  .filter(c => c.type === 'image' || c.type === 'raw-image' || c.type === 'path').map(c => c.type + ':' + c.blend)

// background-repeat round scales tiles to a whole number, space spreads whole tiles edge to edge
{
  const tiles = async rep => {
    const imgs = (await cap('<div style="width:100px;height:70px;background:url(red.png) 0 0/30px 30px ' + rep + '"></div>'))
      .filter(c => c.type === 'image' || c.type === 'raw-image')
    const r2 = v => Math.round(v * 100) / 100
    return [[...new Set(imgs.map(c => r2(c.x)))].join(' '), [...new Set(imgs.map(c => r2(c.y)))].join(' '), r2(imgs[0]?.w ?? 0), r2(imgs[0]?.h ?? 0)]
  }
  out.bgRepeat = { round: await tiles('round'), space: await tiles('space') }
}

// a cross-origin border-image without CORS is skipped, not fatal to the export
try {
  const other = 'http://localhost:' + location.port + '/sq.png'
  out.crossOriginBorderImage = (await cap('<div style="width:60px;height:30px;border:10px solid;border-image:url(' + other + ') 10"></div><div style="width:20px;height:20px;background:#0f0"></div>'))
    .some(c => c.type === 'rect' && c.fill?.[1] === 255)
} catch (e) { out.crossOriginBorderImage = String(e) }

// a url() mask is sized, positioned and tiled like a background, not stretched over the box
{
  const img = (await cap('<div style="width:200px;height:100px;background:#00f;mask:url(icon) center/contain no-repeat;-webkit-mask:url(icon) center/contain no-repeat"></div>'))
    .find(c => c.type === 'image')
  if (img) {
    const px = await pixels(img.src), w = 600, a = (x, y) => px[(Math.round(y * 3) * w + Math.round(x * 3)) * 4 + 3]
    out.maskContain = [a(20, 50), a(100, 50), a(180, 50)]
  }
}

// SVG gradient stops keep their color's alpha and interpolate straight, as browsers paint SVG
out.svgStops = (await cap('<svg width="100" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="transparent"/></linearGradient>' +
  '<linearGradient id="h"><stop offset="0" stop-color="rgba(0,0,255,0.5)"/><stop offset="1" stop-color="blue" stop-opacity="0.5"/></linearGradient></defs>' +
  '<rect width="50" height="20" fill="url(#g)"/><rect x="50" width="50" height="20" fill="url(#h)"/></svg>'))
  .filter(c => c.type === 'path').map(c => [c.gradient?.straightAlpha, c.gradient?.stops.map(st => st.color[3])])

// SVG paint colors carry their alpha: transparent paints nothing, rgba() is translucent
out.svgPaintAlpha = (await cap('<svg width="100" height="20"><rect width="30" height="20" fill="transparent"/><rect x="35" width="30" height="20" fill="rgba(255,0,0,0.5)"/>' +
  '<rect x="70" width="30" height="20" fill="none" stroke="rgba(0,0,255,0.25)" stroke-width="2"/></svg>'))
  .filter(c => c.type === 'path').map(c => [c.fill ?? c.stroke, Math.round(c.opacity * 100) / 100])

// a field's accessible name follows accname: labelledby, aria-label, label (not its options), title, placeholder
out.fieldNames = (await cap(FONT + '<span id="lb">From id</span><input name="a" aria-labelledby="lb" aria-label="Attr" style="font-family:T">' +
  '<label>Wrapped <select name="s" style="font-family:T"><option>Opt</option></select></label>' +
  '<input name="p" placeholder="Hint" style="font-family:T"><input name="plain" style="font-family:T">'))
  .filter(c => c.type === 'field').map(c => c.tooltip)

// RTL text with characters its font lacks (SF Hebrew has no digits): each run sits where the browser put it, in its own direction
if (HAS_HEBREW) {
  const cmds = await cap(FONT + '<style>@font-face{font-family:He;src:url(he.ttf)}</style><p dir="rtl" style="font:16px He, T;width:400px;margin:0">שלום 123.</p>')
  const t = cmds.filter(c => c.type === 'text')
  const p = document.createElement('p')
  p.dir = 'rtl'; p.style.cssText = 'font:16px He, T;width:400px;margin:0'; p.textContent = 'שלום 123.'
  document.body.appendChild(p); await document.fonts.ready
  const node = p.firstChild, range = document.createRange(), base = p.getBoundingClientRect()
  range.setStart(node, 5); range.setEnd(node, 8)
  const digitsLeftPt = (range.getBoundingClientRect().left - base.left) * 0.75
  p.remove()
  const digits = t.find(c => c.text === '123')
  out.rtlFallback = { hebrew: t.find(c => c.text === 'שלום')?.direction, digitsFont: digits?.font, digitsDir: digits?.direction, at: digits ? Math.abs(digits.x - digitsLeftPt) < 0.5 : null }
}

// accessible tagging (PDF/UA): one template exported tagged, untagged, as PDF/UA and as PDF/UA + PDF/A
{
  const html = FONT + '<div style="font:13px T"><h1>Title</h1><p>Para <a href="https://example.com">site</a></p>' +
    '<ul><li>One</li></ul><ol><li>First</li></ol>' +
    '<table><thead><tr><th>Col</th></tr></thead><tbody><tr><th>Row</th><td>1</td></tr></tbody></table>' +
    '<svg width="40" height="20"><title>Green bar</title><rect width="40" height="20" fill="#0a0"/></svg>' +
    '<img src="red.png" alt="" style="width:8px">' +
    '<div style="width:60px;height:20px;background:#eee;border:1px solid #000"></div>' +
    '<label>Name <input name="n" value="v" style="font:13px T"></label></div>'
  const footer = () => '<div style="font:10px T"><a href="https://example.com/footer">Footer</a></div>'
  const meta = { title: 'Accessible', language: 'en' }
  out.ua = {
    tagged:   toB64(await D.renderHTMLtoPDF(html, { size: 'A4' }, { security: null, taggedPdf: true, footer })),
    untagged: toB64(await D.renderHTMLtoPDF(html, { size: 'A4' }, { security: null, footer })),
    ua:       toB64(await D.renderHTMLtoPDF(html, { size: 'A4' }, { security: null, pdfUA: true, metadata: meta })),
    uaa:      toB64(await D.renderHTMLtoPDF(html, { size: 'A4' }, { pdfUA: true, pdfA: true, metadata: meta })),
  }
  try { await D.renderHTMLtoPDF(html, { size: 'A4' }, { pdfUA: true }); out.uaNoTitle = 'no error' } catch (e) { out.uaNoTitle = e.message }
}

// shadows keep their own strength under a translucent background and paint in CSS order:
// outer under the background, inset over its color and image layers
{
  const order = async html => (await cap(html)).filter(c => c.type === 'rect')
    .map(c => (c.gradient ? 'gradient' : c.fill ? 'fill' : '') + (c.shadow ? c.shadow.map(sh => sh.inset ? '+inset' : '+outer').join('') : '') + (c.opacity ? '@' + c.opacity.toFixed(2) : ''))
  out.shadowOrder = {
    translucent: await order('<div style="width:100px;height:50px;background:rgba(255,255,255,.5);box-shadow:0 2px 8px rgba(0,0,0,.3)"></div>'),
    gradient: await order('<div style="width:100px;height:50px;background:linear-gradient(#fff,#eee);box-shadow:inset 0 0 10px #000, 0 2px 8px #000"></div>'),
  }
}

// tagged output puts link and field annotations in their structure elements
out.taggedAnnots = toB64(await D.renderHTMLtoPDF(FONT + '<p style="font-family:T"><a href="https://example.com">site</a> <a href="#nowhere">gone</a></p>' +
  '<input name="n" value="v" style="font-family:T">', { size: 'A4' }, { security: null, taggedPdf: true }))

// mask-repeat round on one axis keeps the image's aspect ratio on the other, like backgrounds
{
  const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>')
  const mask = "url('data:image/svg+xml," + svg + "') 0 0/auto round no-repeat"
  const img = (await cap('<div style="width:110px;height:60px;background:#00f;mask:' + mask + ';-webkit-mask:' + mask + '"></div>')).find(c => c.type === 'image')
  if (img) {
    const px = await pixels(img.src), w = 330, a = y => px[(Math.round(y * 3) * w + 150) * 4 + 3]
    out.maskRound = [a(8.5), a(9.6)]
  }
}

// a calc() background size resolves against the box; auto keeps the image's ratio
out.bgCalcSize = (await cap('<div style="width:200px;height:100px;background:url(red.png) 0 0/calc(100% - 20px) auto no-repeat"></div>'))
  .filter(c => c.type === 'image' || c.type === 'raw-image').map(c => [c.w, c.h])

// a forced page break declared in the app's own CSS applies to short content too
{
  const st = document.createElement('style')
  st.textContent = '.host-break{break-before:page}'
  document.head.appendChild(st)
  out.hostBreakPages = (await D.fromHTML('<div>A</div><div class="host-break">B</div>', { size: 'A4' })).pageCount
  st.remove()
  out.rectoPages = (await D.fromHTML('<div>A</div><div style="break-before:recto">B</div><div style="break-after:verso">C</div><div>D</div>', { size: 'A4' })).pageCount
}

// the built-in list-item counter, counters() separators, and sibling resets that replace
{
  const texts = async html => (await cap(FONT + '<div style="font:16px T">' + html + '</div>'))
    .filter(c => c.type === 'text').map(c => c.text.trim()).filter(Boolean)
  out.listItemCounter = await texts('<style>.c{list-style:none}.c li::before{content:counter(list-item) ". "}</style>' +
    '<ol class="c" start="5"><li>a</li><li>b</li></ol><ol class="c" reversed><li>x</li><li>y</li></ol>')
  out.nestedCounters = await texts('<style>.n{list-style:none}.n li::before{content:counters(list-item, ", ") "|"}</style>' +
    '<ol class="n"><li>a<ol class="n"><li>b</li></ol></li></ol><ol class="n"><li>c</li></ol>')
  out.siblingReset = await texts('<style>.s::before{content:counters(sub, ".") "|"}</style>' +
    '<h2 style="counter-reset:sub">H</h2><p class="s" style="counter-increment:sub">p</p><h2 style="counter-reset:sub">H</h2><p class="s" style="counter-increment:sub">q</p>')
}

// border-image repeat centers its tiles on the edge, space spreads them with gaps at both ends
// (corner slices excluded: they sit at -15 and 72)
{
  const topTiles = async mode => (await cap('<div style="width:96px;height:30px;border:20px solid;border-image:url(sq.png) 10 / 20px ' + mode + '"></div>'))
    .filter(c => c.type === 'image' && c.y < 1 && Math.abs(c.w - 15) < 0.01).map(c => Math.round((c.x - 15) * 10) / 10)
    .filter(x => x > -15 && x < 72)
  out.borderImageTiles = { repeat: await topTiles('repeat'), space: await topTiles('space') }
  // the filled middle scales like the top edge across (2x) and the left edge down (1x)
  const mid = (await cap('<div style="width:96px;height:60px;border-style:solid;border-width:20px 10px;border-image:url(sq.png) 10 fill / 20px 10px repeat"></div>'))
    .filter(c => c.type === 'image' && c.y >= 15 - 0.01 && c.y + c.h <= 60 + 0.01 && c.x >= 7.5 - 0.01 && c.x + c.w <= 79.5 + 0.01)
  out.borderImageMiddle = [...new Set(mid.map(c => c.w + 'x' + c.h))]
}

// filter rasters: grown by the filter's reach, gradient backgrounds painted, text on every line
{
  const raster = async html => (await cap(html)).find(c => c.type === 'image')
  const blurred = await raster('<div style="width:120px;height:40px;background:#2a6;filter:blur(4px)"></div>')
  out.filterBox = blurred && [blurred.x, blurred.y, blurred.w, blurred.h]
  const card = await raster(FONT + '<div style="width:200px;font:16px/20px T;background:linear-gradient(#f00,#f00);filter:grayscale(0.01)">one two three four five six seven eight nine ten</div>')
  if (card) {
    const px = await pixels(card.src), bmp = await createImageBitmap(new Blob([card.src], { type: 'image/png' }))
    const at = (x, y) => px.slice((y * bmp.width + x) * 4, (y * bmp.width + x) * 4 + 3)
    // separate bands of dark (text) rows over the red background: one per laid-out line
    let bands = 0, prevInk = false
    for (let y = 0; y < bmp.height; y++) {
      let ink = false
      for (let x = 0; x < bmp.width && !ink; x++) ink = at(x, y)[0] < 120
      if (ink && !prevInk) bands++
      prevInk = ink
    }
    out.filterCard = { bands, bg: Array.from(at(bmp.width - 2, 1)).join() }
  }
}

// SVG files: unsupported paint falls back to a raster instead of dropping shapes, and
// fill-rule, opacity and display are read where exported files put them
{
  const kinds = async file => (await cap('<img src="' + file + '" style="width:40px;height:40px">'))
    .filter(c => c.type === 'path' || c.type === 'image' || c.type === 'raw-image')
    .map(c => c.type === 'path' ? 'path' + (c.evenOdd ? ':evenodd' : '') + (c.opacity !== undefined && c.opacity < 1 ? ':' + c.opacity : '') : 'raster')
  out.svgFiles = { userSpace: await kinds('user.svg'), strokeGrad: await kinds('strokegrad.svg'), styled: await kinds('styled.svg') }
}

// text after a clipped box that spans a page break still selects its font on the new page
{
  const html = FONT + '<div style="font:16px T"><p>First</p><div style="overflow:hidden;height:1200px"><p>inside</p></div><p>After</p></div>'
  const pdf = await D.renderHTMLtoPDF(html, { size: 'A4' }, { security: null })
  out.afterClipPdf = toB64(pdf)
}

// multi-column text keeps each column's lines apart, at the column's own x
out.columnLines = (await cap(FONT + '<div style="font:16px/20px T;width:600px;column-count:3;column-gap:30px">one two three four five six seven eight nine ten eleven twelve thirteen fourteen</div>'))
  .filter(c => c.type === 'text').map(c => [c.text, Math.round(c.x), Math.round(c.maxWidth)])

// unstyled controls are drawn as Chrome paints them natively, not with their UA inset/outset
{
  const ring = async html => {
    const c = (await cap(html)).find(c => c.type === 'rect' && c.stroke)
    return c && [c.stroke.join('.'), c.strokeWidth, c.radius?.all !== undefined ? Math.round(c.radius.all * 100) / 100 : null]
  }
  out.native = {
    input: await ring('<input value="x">'), button: await ring('<button>b</button>'), check: await ring('<input type="checkbox">'),
    radio: await ring('<input type="radio" style="width:12px;height:12px">'), styled: await ring('<input style="border:1px solid #f00">'),
    painted: (await cap('<button style="background:#36c">b</button>')).filter(c => c.type === 'path').length,
  }
}

// bullet and disclosure markers are shapes, so a font without those glyphs still shows them
{
  const marker = async html => {
    const cmds = await cap(FONT + '<div style="font:20px/30px T">' + html + '</div>')
    const p = cmds.find(c => c.type === 'path')
    const xs = p ? p.ops.flatMap(o => o.args.filter((_, i) => i % 2 === 0)) : []
    return { texts: cmds.filter(c => c.type === 'text').map(c => c.text), width: xs.length ? Math.round((Math.max(...xs) - Math.min(...xs)) * 100) / 100 : null, ring: !!p?.stroke }
  }
  out.shapeMarkers = { disc: await marker('<ul><li>a</li></ul>'), circle: await marker('<ul style="list-style:circle"><li>a</li></ul>'),
    open: await marker('<details open><summary>s</summary></details>') }
}

// a rounded card with one heavier side keeps its round corners
out.accentCard = (await cap('<div style="width:120px;height:60px;border-radius:8px;border:1px solid #ccc;border-left:6px solid #36c"></div>'))
  .filter(c => c.type === 'path').map(c => (c.fill ? c.fill.join('.') : '') + (c.evenOdd ? ':ring' : '') + (c.ops.some(o => o.op === 'c') ? ':curved' : ''))

// inline SVG text carries the template's font with it into the rasterized image
{
  const img = (await cap(FONT + '<svg width="100" height="40"><text x="5" y="25" style="font:16px T">Label</text></svg>')).find(c => c.type === 'image')
  const svg = img?.format === 'svg' ? new TextDecoder().decode(img.src) : ''
  out.svgTextFont = { face: /@font-face[^}]*font-family:\\s*T[^}]*url\\(data:/.test(svg), family: /<text[^>]*font-family="T"/.test(svg) }
}

// text-overflow: ellipsis cuts the line to fit the box, ellipsis included
out.ellipsis = (await cap(FONT + '<div style="font:13px T;width:90px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">An overflowing line of text</div>'))
  .filter(c => c.type === 'text').map(c => [c.text, c.x + c.maxWidth])

// a blended list item blends its marker too, numbered or shaped
out.markerBlend = (await cap(FONT + '<ol style="font:13px T"><li style="mix-blend-mode:multiply">a</li></ol><ul style="font:13px T"><li style="mix-blend-mode:multiply">b</li></ul>'))
  .filter(c => (c.type === 'text' && c.text === '1.') || c.type === 'path').map(c => c.blend)

// word spacing widens the gaps the ellipsis has to fit around
out.ellipsisWs = (await cap(FONT + '<div style="font:13px T;width:90px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;word-spacing:12px">An overflowing line of text</div>'))
  .filter(c => c.type === 'text').map(c => [c.text, c.wordSpacing])

// -webkit-line-clamp ends its last visible line with an ellipsis
out.lineClamp = (await cap(FONT + '<div style="width:120px;font:13px/16px T;-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden">Clamped to two lines of text here and more words after it</div>'))
  .filter(c => c.type === 'text').map(c => c.text)

// a live element captured again after its clamp changed is clamped by its current style
{
  const root = document.createElement('div')
  root.innerHTML = FONT + '<div style="width:120px;font:13px/16px T;overflow:hidden">Clamped to two lines of text here and more words after it</div>'
  document.body.appendChild(root)
  await document.fonts.ready
  const texts = async () => (await D.fromDOM(root, { size: 'A4' })).commands.filter(c => c.type === 'text').map(c => c.text)
  const before = await texts()
  root.lastElementChild.style.cssText += ';display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2'
  out.reclamp = { before, after: await texts() }
  root.remove()
}

// a select laid out before its web font arrives keeps the fallback font's baseline in Chrome
// unless it is laid out again, so the capture must not measure that stale position
if (${hasTestFont()}) {
  const row = f => '<p style="margin:0;font:13px ' + f + '">Name <input name="i" value="v" style="font:13px ' + f + '">' +
    '<select name="s" style="font:13px ' + f + '"><option>One</option></select></p>'
  const cmds = (await D.fromHTML('<style>@font-face{font-family:Late;src:url(late.ttf)}</style>' + row('Late'), { size: 'A4' })).commands
  const y = n => cmds.find(c => c.type === 'field' && c.name === n)?.y
  const face = new FontFace('LateRef', 'url(late.ttf)')
  document.fonts.add(face)
  await face.load()
  const ref = document.createElement('div')
  ref.innerHTML = row('LateRef')
  document.body.appendChild(ref)
  const top = sel => ref.querySelector(sel).getBoundingClientRect().top
  out.lateSelect = [+((y('s') - y('i')) / 0.75).toFixed(3), +(top('select') - top('input')).toFixed(3)]
  ref.remove()
}

// a header waits for its images like the content does, so a slow logo is drawn at its size
{
  const cmds = (await D.fromHTML('<p>x</p>', { size: 'A4' }, {}, { header: () => '<img src="slow.png" style="display:block;height:20px">' })).commands
  out.headerImage = cmds.filter(c => c.type === 'image' || c.type === 'raw-image').map(c => [Math.round(c.w), Math.round(c.h)])
}

// a hidden page runs no frames, so the export must not wait for one, there or once hidden midway
{
  const raf = window.requestAnimationFrame
  window.requestAnimationFrame = () => 0
  const within = p => Promise.race([p.then(() => true), new Promise(r => setTimeout(() => r(false), 3000))])
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
  const hidden = await within(D.fromHTML('<p>x</p>', { size: 'A4' }))
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  const hiding = D.fromHTML('<p>x</p>', { size: 'A4' })
  setTimeout(() => document.dispatchEvent(new Event('visibilitychange')), 300)
  out.hiddenPage = [hidden, await within(hiding)]
  delete document.hidden
  window.requestAnimationFrame = raf
}

// a live <canvas> is captured as its drawn pixels, inside its border and padding
{
  const root = document.createElement('div')
  const canvas = document.createElement('canvas')
  canvas.width = 20; canvas.height = 10
  canvas.style.cssText = 'display:block;border:3px solid #000;padding:2px'
  const c2d = canvas.getContext('2d'); c2d.fillStyle = '#f00'; c2d.fillRect(0, 0, 20, 10)
  root.appendChild(canvas)
  document.body.appendChild(root)
  const img = (await D.fromDOM(root, { size: 'A4' })).commands.find(c => c.type === 'image')
  root.remove()
  out.canvas = img ? { box: [img.x, img.y, img.w, img.h].map(v => Math.round(v / 0.75)), px: [...(await pixels(img.src)).slice(0, 4)] } : null
}

// fromDOM may be handed the caller's own element: its style attribute comes back as it was
{
  const styles = []
  for (const attr of [null, 'color: red; display: block']) {
    const root = document.createElement('div')
    if (attr !== null) root.setAttribute('style', attr)
    root.innerHTML = '<p>x</p>'
    document.body.appendChild(root)
    await D.fromDOM(root, { size: 'A4' })
    styles.push(root.getAttribute('style'))
    root.remove()
  }
  out.liveStyle = styles
}

// in RTL the markers sit to the right of the content, and the number's period shows first
{
  const cmds = await cap(FONT + '<div dir="rtl" style="font:20px/30px T;width:300px"><ul style="margin:0"><li>Item one</li></ul><ol style="margin:0"><li>Item two</li></ol></div>')
  const texts = cmds.filter(c => c.type === 'text'), disc = cmds.find(c => c.type === 'path')
  const one = texts.find(t => t.text === 'Item one'), two = texts.find(t => t.text === 'Item two'), num = texts.find(t => /1/.test(t.text) && t !== two)
  out.rtlMarkers = { discRight: disc ? Math.min(...disc.ops.flatMap(o => o.args.filter((_, i) => i % 2 === 0))) > one.x + one.maxWidth : null,
    numText: num?.text, numRight: num ? num.x > two.x + two.maxWidth : null }
}

// 3D border styles use Chrome's shades, sides mitered at the corners
{
  const sides = async border => (await cap('<div style="width:40px;height:20px;border:' + border + '"></div>'))
    .filter(c => c.type === 'path').map(c => c.fill.join('.'))
  out.border3d = { inset: await sides('8px inset #888'), groove: await sides('8px groove #888'), black: await sides('8px outset #000'),
    white: await sides('8px inset #fff') }
  const top = (await cap('<div style="width:40px;height:20px;border:8px inset #888"></div>')).find(c => c.type === 'path')
  out.border3dTop = top?.ops.map(o => o.args.map(v => Math.round(v * 100) / 100).join(',')).join(' ')
}

// paint order matches Chrome's: each case's top color at a probe point, by hit testing
// in Chrome (which reports a pseudo as its element) and by the last rect drawn there
{
  const neg = '<div style="position:absolute;z-index:-1;width:60px;height:30px;background:#f00"></div>'
  const box = style => '<div style="width:60px;height:30px;background:#00f;' + style + '">' + neg + '</div>'
  const cases = ['', 'position:relative', 'z-index:0', 'position:relative;z-index:0', 'opacity:.9', 'transform:translateX(0)',
    'mix-blend-mode:multiply', 'isolation:isolate', 'clip-path:inset(0)', 'contain:paint', 'will-change:transform',
    'perspective:100px', 'position:sticky'].map(t => [t || 'plain parent', box(t)])
  cases.push(
    ['positioned child over a later sibling', '<div><div style="height:10px"><div style="position:absolute;width:60px;height:30px;background:#f00"></div></div><div style="height:30px;width:60px;background:#00f"></div></div>'],
    ['z-index across wrappers', '<div><div style="height:10px"><div style="position:absolute;z-index:2;width:60px;height:30px;background:#f00"></div></div><div style="position:relative;z-index:1;height:30px;width:60px;background:#00f"></div></div>'],
    ['flex items order by z-index', '<div style="display:flex;width:60px"><div style="z-index:2;flex:0 0 60px;height:30px;background:#f00"></div><div style="z-index:1;flex:0 0 60px;height:30px;margin-left:-60px;background:#00f"></div></div>'],
    ['positioned ::before over a later sibling', '<style>.pb::before{content:"";position:absolute;width:60px;height:30px;background:#f00}</style><div><div class="pb" style="height:10px"></div><div style="height:30px;width:60px;background:#00f"></div></div>'])
  const key = c => c && c.slice(0, 3).join(',')
  out.stacking = []
  for (const [name, html] of cases) {
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:794px;z-index:2147483647;background:#fff'
    host.innerHTML = html
    document.body.appendChild(host)
    const hit = document.elementFromPoint(30, 20)
    const chrome = key(String(getComputedStyle(hit, hit.classList.contains('pb') ? '::before' : null).backgroundColor).match(/\\d+/g)?.map(Number).concat(255))
    host.remove()
    let top = null
    for (const c of await cap(html)) {
      if (c.type === 'rect' && c.fill && c.x <= 22.5 && c.x + c.w >= 22.5 && c.y <= 15 && c.y + c.h >= 15) top = key(c.fill)
    }
    out.stacking.push([name, chrome, top ?? '255,255,255'])
  }
}

// an SVG served from a URL without an .svg extension is still recognized
out.extensionlessSvg = (await cap('<img src="icon" style="width:40px;height:40px">')).filter(c => c.type === 'path').length

// the PDF has as many pages as the layout (and the preview), trailing blank space included
{
  const html = '<div style="height:30px;background:#f00"></div><div style="height:2300px"></div>'
  const pv = document.createElement('div'); document.body.appendChild(pv)
  await D.previewHTML(html, pv, { size: 'A4' })
  out.pages = { preview: pv.querySelectorAll(':scope > [data-tpdf-page]').length, pdf: toB64(await D.renderHTMLtoPDF(html, { size: 'A4' }, { security: null })) }
  pv.remove()
}

// tel: links and relative links become real link annotations; other schemes don't
out.links = (await cap('<a href="tel:+46123">t</a> <a href="/path">p</a> <a href="rel.html">r</a> <a href="ftp://x/y">f</a> <a href="#x">x</a><p id="x">x</p>'))
  .filter(c => c.type === 'link').map(c => c.href.replace(location.origin, 'ORIGIN'))

// vertical text keeps its color's alpha
out.verticalOpacity = (await cap(FONT + '<div style="writing-mode:vertical-rl;font:16px T;color:rgba(0,0,0,0.5);height:200px">縦書き</div>'))
  .find(c => c.type === 'text')?.opacity

// capture time grows linearly with text: a probe per text node made it quadratic
{
  const time = async n => {
    const html = FONT + '<ol style="font:8px T">' + '<li>Lorem ipsum dolor</li>'.repeat(n) + '</ol>'
    await D.fromHTML(html, { size: 'A4' })
    const t0 = performance.now(); await D.fromHTML(html, { size: 'A4' }); return performance.now() - t0
  }
  out.textScaling = (await time(1600)) / (await time(400))
}

// images that load slowly are waited for, not dropped
{
  const cmds = await cap('<div style="font-size:0"><img src="slow.png" style="height:50px"><img srcset="slow2.png 80w" sizes="40px"></div>')
  out.slowImages = cmds.filter(c => c.type === 'image' || c.type === 'raw-image').map(c => [Math.round(c.w), Math.round(c.h)])
}

return out
`

export default async function ({ test, eq, ok }) {
  const why = browserUnavailable()
  if (why) { console.log(`  render: skipped, ${why}`); return }
  const slow = { body: png(80, 20, [255, 0, 0]), delayMs: 1500 }
  const icon = { body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#00f"/></svg>', type: 'image/svg+xml' }
  const svg = body => ({ body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' + body + '</svg>', type: 'image/svg+xml' })
  const svgFiles = {
    'user.svg': svg('<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="10" y2="0"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
      '<rect width="10" height="5" fill="#0a0"/><rect y="5" width="10" height="5" fill="url(#g)"/>'),
    'strokegrad.svg': svg('<defs><linearGradient id="s"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
      '<rect x="1" y="1" width="8" height="8" fill="none" stroke="url(#s)"/>'),
    'styled.svg': svg('<g fill-rule="evenodd"><path d="M0 0H10V10H0Z M2 2H8V8H2Z"/></g><rect width="5" height="5" style="opacity:0.5"/><rect width="5" height="5" style="display:none"/>'),
  }
  const r = await runSuitePage(test, { script: SCRIPT, files: { ...svgFiles, 'slow.png': slow, 'slow2.png': slow, icon, 'red.png': png(8, 8, [255, 0, 0]), 'sq.png': png(30, 30, [0, 0, 0]),
    ...(hasHebrew ? { 'he.ttf': readFileSync(HEBREW) } : {}),
    ...(hasTestFont() ? { 'late.ttf': { body: readFileSync(FONT_FILE), type: 'font/ttf', delayMs: 400 } } : {}) } })
  if (!r) return

  {
    const anns = readPdf(Buffer.from(r.formsPdf, 'base64')).getPage(1).annotations()
    const by = n => anns.find(a => a.fieldName === n)
    test('same-named inputs become distinct fields', () =>
      eq(anns.filter(a => a.fieldName?.startsWith('q')).map(a => a.fieldName).join(','), 'q,q_2'))
    test('a password value never reaches the PDF', () => {
      eq(r.passwordCapture?.value ?? '', '')
      ok(!by('pw')?.fieldValue, 'no /V for a password field')
      eq(by('pw')?.fieldFlags, 1 << 13)
    })
    test('a select is a combo box showing option text, valued by option value', () => {
      eq(by('c')?.fieldFlags, 1 << 17)
      eq(by('c')?.fieldValue, 'us')
      eq(JSON.stringify(by('c')?.fieldOptions), JSON.stringify([['se', 'Sweden'], ['us', 'United States']]))
    })
    test('a textarea is multiline', () => eq(by('t')?.fieldFlags, 1 << 12))
    test('readonly and disabled controls are read-only fields', () =>
      eq(['ro', 'dis', 'cb'].map(n => by(n)?.fieldFlags).join(), [1, 1 | 1 << 17, 1].join()))
  }

  {
    const anns = readPdf(Buffer.from(r.chromePdf, 'base64')).getPage(1).annotations()
    const top = a => 841.89 - a.rect[3]
    const content = anns.find(a => a.url === 'https://e.com/c'), footer = anns.find(a => a.url === 'https://e.com/f')
    const field = anns.find(a => a.fieldName === 'f')
    test('a content link moves down with the content under a header', () =>
      ok(content && Math.abs(top(content) - 69) < 0.5, `link top ${content && top(content)}, want 69`))
    test('a form field moves down with the content under a header', () =>
      ok(field && top(field) > 69, `field top ${field && top(field)}, want below the 54pt header`))
    test('a footer link sits in the footer band', () =>
      ok(footer && top(footer) > 841.89 - 31, `footer link top ${footer && top(footer)}, want in the bottom 30pt`))
  }

  test('the PDF has as many pages as the preview', () => {
    eq(r.pages.preview, 3)
    eq(readPdf(Buffer.from(r.pages.pdf, 'base64')).numPages, 3)
  })

  test('tel: and relative links are kept, other schemes are not', () =>
    eq(JSON.stringify(r.links), JSON.stringify(['tel:+46123', 'ORIGIN/path', 'ORIGIN/rel.html', '#x'])))

  test('an SVG without an .svg extension is still drawn', () => eq(r.extensionlessSvg, 1))
  if (hasTestFont()) test('a select sits where a fresh layout puts it, even when its font arrived late', () =>
    eq(r.lateSelect?.[0], r.lateSelect?.[1], 'select top minus input top, captured vs laid out with the font loaded (px)'))
  test('a header waits for a slow image and draws it at its size', () => eq(JSON.stringify(r.headerImage), JSON.stringify([[60, 15]])))
  test('a live element keeps its style attribute exactly', () => eq(JSON.stringify(r.liveStyle), JSON.stringify([null, 'color: red; display: block'])))
  test('a hidden page exports without waiting for a frame', () => eq(JSON.stringify(r.hiddenPage), '[true,true]'))
  test('a live canvas is drawn in its content box with its pixels', () =>
    eq(JSON.stringify(r.canvas), JSON.stringify({ box: [5, 5, 20, 10], px: [255, 0, 0, 255] })))

  test('slow-loading images are waited for, at their real size', () =>
    eq(JSON.stringify(r.slowImages), JSON.stringify([[150, 38], [30, 8]])))

  const lazy = await runSuitePage(test, { init: false, script: `return (await D.pdf.render('<p>x</p>', 'A4', null)).length` })
  test('pdf.render() starts the engine itself, without warmup()', () => ok(lazy > 0, `render returned ${lazy}`))

  test('inline SVG follows its stylesheet, group opacity, display and named colors', () => eq(JSON.stringify(r.svg), JSON.stringify([
    { fill: [238, 51, 51], op: 1 },           // fill from a class rule
    { fill: [0, 0, 255], op: 0.5 },           // <g opacity> reaches its child
    { fill: [70, 130, 180], op: 1 },          // steelblue; the display:none rect is skipped
    { stroke: [51, 170, 51], w: 12, op: 1 },  // stroke and width from a class rule
    { fill: [51, 102, 204], op: 1 },          // a <use> sprite inherits currentColor from the <use>
  ])))

  test('a sized <use> maps its symbol viewBox into the use box', () =>
    ok(Math.abs(r.symbolWidth - 15) < 0.01, `symbol drew ${r.symbolWidth}pt wide, want 15`))

  test('radial gradients resolve to the CSS ending shape', () => {
    eq(JSON.stringify(r.radial.dflt), JSON.stringify([0.5, 0.5, 0.7071, 0.7071]))      // ellipse through the corners
    eq(JSON.stringify(r.radial.sized), JSON.stringify([0.0667, 0.3, 0.2, 0.3]))        // 60×30px at 20px 30px
    eq(JSON.stringify(r.radial.circle), JSON.stringify([0.25, 0.5, 0.1667, 0.5]))      // 50px circle: rx 50/300, ry 50/100
  })

  test('a flex-parent pseudo box is drawn', () => ok(r.pseudo.flexIcon, 'no 9pt red box for the ::before icon'))

  test('the sanitizer strips script schemes, handlers and scripts', () => {
    const z = r.sanitized
    eq(JSON.stringify([z.hrefs, z.onclick, z.svgLink, z.script, z.ran]), JSON.stringify([[null, null, null, 'https://e.com/'], null, null, 0, false]))
  })
  test('an inline SVG keeps its embedded data: image', () => ok(r.sanitized.svgImage && r.sanitized.svgImageRed, JSON.stringify(r.sanitized)))
  test('url() backgrounds paint under the gradient above them and under the border', () => {
    eq(r.bgOrder.tint, 'img grad')
    eq(r.bgOrder.under, 'img border')
  })
  test('the template body\'s url() background is drawn', () => ok(r.bgOrder.root > 0, `${r.bgOrder.root} image tiles`))
  test('a link inside a transform is placed where the browser draws it', () =>
    eq(JSON.stringify(r.transformedLink.ours), JSON.stringify(r.transformedLink.chrome)))
  // the red box's corners, through every cm in front of it (these tests nest, never close one),
  // as a y-down bounding box in pt
  const transformedBox = (b64, page) => {
    const content = readPdf(Buffer.from(b64, 'base64')).getPage(page).content()
    const box = content.match(/1 0 0 rg\n([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) re/)
    if (!box) return null
    const cms = [...content.slice(0, box.index).matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) cm/g)].map(m => m.slice(1).map(Number))
    const apply = ([px, py]) => cms.reduceRight(([qx, qy], [a, b, c, d, e, f]) => [a * qx + c * qy + e, b * qx + d * qy + f], [px, py])
    const [x, y, w, h] = box.slice(1).map(Number)
    const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(p => apply(p)).map(([px, py]) => [px, 841.89 - py])
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)].map(Math.round)
  }
  test('a rotated, scaled box on page 2 lands where the browser draws it', () => {
    const ours = transformedBox(r.page2Transform.pdf, 2), chrome = r.page2Transform.chrome
    ok(ours && ours.every((v, i) => Math.abs(v - chrome[i]) <= 1), `ours ${ours}, Chrome ${chrome}`)
  })
  test('a rotated box under a header and footer lands where the browser draws it', () => {
    const ours = transformedBox(r.bandedTransform.pdf, 1), chrome = r.bandedTransform.chrome
    ok(ours && ours.every((v, i) => Math.abs(v - chrome[i]) <= 1), `ours ${ours}, Chrome ${chrome}`)
  })
  test('a gradient below a header is placed with its box', () => {
    const raw = Buffer.from(r.gradientUnderHeader, 'base64').toString('latin1')
    ok(/\/PatternType 2\s*\/Matrix \[1 0 0 1 0 -112\.5\]/.test(raw), raw.match(/\/Matrix \[[^\]]*\]/)?.[0])
  })
  test('a conic gradient centered by px paints around that point', () => eq(JSON.stringify(r.conicCorner), JSON.stringify(['0,0,255', '0,0,255'])))
  test('mix-blend-mode applies to images, background tiles and SVG shapes', () =>
    eq([...new Set(r.imageBlend)].join(' '), 'image:Multiply path:Multiply'))
  test('background-repeat round and space tile like the browser', () => {
    eq(JSON.stringify(r.bgRepeat.round), JSON.stringify(['0 25 50', '0 26.25', 25, 26.25]))
    eq(JSON.stringify(r.bgRepeat.space), JSON.stringify(['0 26.25 52.5', '0 30', 22.5, 22.5]))
  })
  test('a page break from the app\'s stylesheet splits short content', () => eq(r.hostBreakPages, 2))
  test('break-before: recto and break-after: verso force page breaks', () => eq(r.rectoPages, 3))
  test('border-image repeat and space place edge tiles like the browser', () => {
    eq(r.borderImageTiles.repeat.join(' '), '-1.5 13.5 28.5 43.5 58.5')
    eq(r.borderImageTiles.space.join(' '), '2.4 19.8 37.2 54.6')
  })
  test('a border-image middle tiles at the edges\' scale', () => eq(r.borderImageMiddle.join(), '15x7.5'))
  test('a filter raster grows by how far the filter paints outside the box', () =>
    eq(JSON.stringify(r.filterBox), JSON.stringify([-9, -9, 108, 48])))
  test('a filter raster keeps a gradient background', () => ok(r.filterCard && /^2[0-9]{2},[0-9]{1,2},[0-9]{1,2}$/.test(r.filterCard.bg), JSON.stringify(r.filterCard)))
  if (hasTestFont()) {
    test('a filter raster draws text on every line', () => eq(r.filterCard?.bands, 2))
  }
  test('an SVG file with paint the vector path can\'t do is rasterized whole', () => {
    eq(r.svgFiles.userSpace.join(), 'raster')
    eq(r.svgFiles.strokeGrad.join(), 'raster')
  })
  test('an SVG file\'s inherited fill-rule and inline-style opacity and display apply', () =>
    eq(r.svgFiles.styled.join(), 'path:evenodd,path:0.5'))
  test('unstyled form controls get Chrome\'s native border, authored ones keep theirs', () => {
    const n = r.native
    eq(JSON.stringify([n.input, n.button, n.check]), JSON.stringify(Array(3).fill(['118.118.118', 0.75, 1.5])))
    eq(JSON.stringify(n.radio), JSON.stringify(['118.118.118', 0.75, 4.5]))
    eq(n.styled?.[0], '255.0.0')
    eq(n.painted, 4, 'a button with an authored background keeps its CSS outset border')
  })
  test('a rounded box with mixed borders keeps round corners', () =>
    eq(r.accentCard.join(' '), ['204.204.204', '204.204.204', '204.204.204', '51.102.204'].map(c => c + ':ring:curved').join(' ')))
  test('3D borders shade like Chrome', () => {
    const d = '52.52.52', l = '221.221.221'
    eq(r.border3d.inset.join(' '), [d, l, l, d].join(' '))
    eq(r.border3d.groove.join(' '), [d, l, l, d, l, d, d, l].join(' '))
    eq(r.border3d.black.join(' '), ['168.168.168', '84.84.84', '84.84.84', '168.168.168'].join(' '))
    eq(r.border3d.white.join(' '), ['171.171.171', '255.255.255', '255.255.255', '171.171.171'].join(' '))
  })
  test('a border side is a trapezoid mitered into its neighbors', () => eq(r.border3dTop, '0,0 42,0 36,6 6,6'))

  for (const [name, chrome, ours] of r.stacking) test(`paint order like Chrome: ${name}`, () => eq(String(ours), String(chrome)))

  if (hasTestFont()) {
    // quadratic would be ~16x for 4x the items (a probe per text node measured 12.5x)
    test('capture time grows about linearly with the number of text nodes', () =>
      ok(r.textScaling < 8, `4x the list items took ${r.textScaling.toFixed(1)}x the time`))

    test('vertical text keeps its color alpha', () =>
      ok(r.verticalOpacity !== undefined && Math.abs(r.verticalOpacity - 0.5) < 0.01, `opacity ${r.verticalOpacity}`))

    test('list markers: reversed counts down, string and greek styles', () =>
      eq(JSON.stringify(r.markers), JSON.stringify(['3.', '2.', '1.', '10.', '9.', '→ ', 'α.', 'β.'])))

    const { ab, hello, label, body } = r.pseudo
    test('::before text starts at the block start, before the element text', () => {
      ok(ab && Math.abs(ab.x - 15) < 0.5, `::before at x ${ab?.x}, want 15 (the 20px padding)`)
      ok(ab && hello && hello.x > ab.x + 5, `"Hello" at ${hello?.x} overlaps "AB " at ${ab?.x}`)
    })
    test('a block ::before label sits on its own line above the content', () =>
      ok(label && body && label.y < body.y - 5, `label y ${label?.y}, body y ${body?.y}`))
    test('italic without an italic face is slanted like the browser does it', () => {
      eq(JSON.stringify(r.skew), JSON.stringify([0.25, 0.25, 0.25, 0, 0]))
      eq(r.skewOff, 0)
    })
    test('small caps: lowercase shrinks to uppercase at 0.7x, at Chrome\'s positions', () => {
      const shape = list => list.map(([t, size]) => t + '@' + size).join('|')
      eq(shape(r.caps.sc), 'H@15|ELLO@10.5|, W@15|ORLD@10.5')
      eq(shape(r.caps.all), 'HELLO, WORLD@10.5')
      eq(shape(r.caps.uni), 'H@10.5|ello@15|, W@10.5|orld@15')
      const orld = r.caps.sc[3]
      ok(orld && Math.abs(orld[2] - r.capsChromeX) < 0.4, `ORLD at ${orld?.[2]}pt, Chrome puts it at ${r.capsChromeX}pt`)
    })
    test('a soft hyphen line break draws the hyphen, and the next line starts at its letter', () =>
      eq(JSON.stringify(r.softHyphen), JSON.stringify([['Broken super-', 0], ['califragilistic', 0]])))
    test('RTL inline fragments: start border on the first, end border on the last', () =>
      eq(r.rtlFragments.join(' '), 'right left'))
    test('counter(list-item) numbers custom list markers like the list markers', () =>
      eq(r.listItemCounter.join(' '), '5. a 6. b 2. x 1. y'))
    test('counters() keeps a separator with a comma and nests list-item per list', () =>
      eq(r.nestedCounters.join(' '), '1| a 1, 1| b 1| c'))
    test('a sibling counter-reset replaces the earlier instance instead of nesting', () =>
      eq(r.siblingReset.join(' '), 'H 1| p H 1| q'))
    test('text after a page-spanning clip has its font on the next page', () =>
      eq(readPdf(Buffer.from(r.afterClipPdf, 'base64')).getPage(2).text(), 'After'))
    // 600px over three columns with 30px gaps: each column is 180px, 135pt
    test('multi-column text keeps its columns apart', () =>
      ok(r.columnLines.length >= 4 && r.columnLines.every(([, , w]) => w <= 135), JSON.stringify(r.columnLines)))
    test('bullets and disclosure triangles are shapes sized like Chrome\'s', () => {
      const m = r.shapeMarkers
      eq(JSON.stringify([m.disc.texts, m.disc.width, m.disc.ring]), JSON.stringify([['a'], 4.5, false]))
      eq(JSON.stringify([m.circle.width, m.circle.ring]), JSON.stringify([4.5, true]))
      eq(JSON.stringify([m.open.texts, m.open.width]), JSON.stringify([['s'], 9.75]))
    })
    test('inline SVG text embeds the template font it uses', () => eq(JSON.stringify(r.svgTextFont), JSON.stringify({ face: true, family: true })))
    test('an ellipsized line is cut to fit the box', () => {
      const [[text]] = r.ellipsis
      ok(text.endsWith('…') && text.length < 'An overflowing line of text'.length, text)
    })
    test('a cross-origin border-image does not abort the export', () => eq(r.crossOriginBorderImage, true))
    test('a url() mask follows mask-size and mask-position', () =>
      eq(JSON.stringify(r.maskContain), JSON.stringify([0, 255, 0])))
    test('SVG gradient stops keep their alpha and interpolate straight', () =>
      eq(JSON.stringify(r.svgStops), JSON.stringify([[true, [255, 0]], [true, [128, 128]]])))
    test('SVG paint alpha: transparent paints nothing, rgba() is translucent', () =>
      eq(JSON.stringify(r.svgPaintAlpha), JSON.stringify([[[255, 0, 0], 0.5], [[0, 0, 255], 0.25]])))
    {
      const load = key => { const pdf = readPdf(Buffer.from(r.ua[key], 'base64')); return { pdf, page: pdf.getPage(1), d: pdf.getPage(1).doc } }
      // every painting operator inside an MCID span or an artifact
      const unmarked = content => {
        const stack = [], bad = []
        for (const m of content.matchAll(/\/(\w+)\s*<<(.*?)>>\s*BDC|\/(\w+)\s+BMC|\bEMC\b|(?<![\w/])(f\*?|S|B\*?|Tj|TJ|Do|sh)(?![\w*])/gs)) {
          if (m[1] !== undefined) stack.push(/\/MCID/.test(m[2]) ? 'content' : m[1] === 'Artifact' ? 'artifact' : 'other')
          else if (m[3] !== undefined) stack.push(m[3] === 'Artifact' ? 'artifact' : 'other')
          else if (m[0] === 'EMC') stack.pop()
          else if (!stack.includes('content') && !stack.includes('artifact')) bad.push(m[4])
        }
        return bad
      }
      test('tagged output marks every untagged drawing as an artifact', () => {
        const { page } = load('tagged')
        eq(JSON.stringify(unmarked(page.content())), '[]', page.content().slice(0, 400))
        ok(/\/Artifact << \/Type \/Pagination \/Subtype \/Footer >> BDC/.test(page.content()), 'the footer is a pagination artifact')
      })
      test('untagged output carries no artifact marks', () => ok(!/Artifact/.test(load('untagged').page.content())))

      // the structure tree, as tag paths ("L>LI>Lbl"), with TH scopes and figure alt text
      const tree = key => {
        const { pdf, d } = load(key), paths = []
        const walk = (node, path) => {
          const n = d.resolve(node)
          if (!(n instanceof Map) || !n.get('S')) return
          const tag = n.get('S').name, here = path ? path + '>' + tag : tag
          const scope = d.resolve(n.get('A'))?.get('Scope')?.name
          const alt = d.resolve(n.get('Alt'))?.str?.toString('latin1')
          paths.push(here + (scope ? '[' + scope + ']' : '') + (alt ? '"' + alt + '"' : ''))
          for (const k of [d.resolve(n.get('K'))].flat()) walk(k, here)
        }
        for (const k of [d.resolve(pdf.catalogEntry('StructTreeRoot').get('K'))].flat()) walk(k, '')
        return paths
      }
      test('list items hold an Lbl and an LBody', () => {
        const t = tree('tagged')
        ok(t.filter(p => /L>LI>Lbl$/.test(p)).length === 2 && t.filter(p => /L>LI>LBody/.test(p)).length >= 2, t.join('\n'))
      })
      test('table headers carry their scope', () => {
        const t = tree('tagged')
        ok(t.some(p => p.endsWith('THead>TR>TH[Column]')) && t.some(p => p.endsWith('TBody>TR>TH[Row]')), t.join('\n'))
      })
      test('an SVG figure takes its title as alt; a decorative image stays out of the tree', () => {
        const figures = tree('tagged').filter(p => /Figure/.test(p))
        eq(JSON.stringify(figures.map(p => p.replace(/^.*Figure/, 'Figure'))), JSON.stringify(['Figure"Green bar"']))
      })
      test('header/footer links get their own Link element', () =>
        ok(tree('tagged').filter(p => p === 'Link').length === 1, tree('tagged').join('\n')))

      test('tagged links and fields carry their descriptions; pages tab in structure order', () => {
        const desc = key => {
          const { page, d } = load(key)
          const annots = (d.resolve(page.dict.get('Annots')) ?? []).map(ref => d.resolve(ref))
          return { contents: annots.map(a => d.resolve(a.get('Contents'))?.str?.toString('latin1')).filter(Boolean),
            tu: annots.map(a => d.resolve(a.get('TU'))?.str?.toString('latin1')).filter(Boolean), tabs: page.dict.get('Tabs')?.name }
        }
        eq(JSON.stringify(desc('tagged')), JSON.stringify({ contents: ['site', 'Footer'], tu: ['Name'], tabs: 'S' }))
        eq(JSON.stringify(desc('untagged')), JSON.stringify({ contents: [], tu: [] }))
      })

      test('PDF/UA declares itself and shows the document title', () => {
        const xmp = key => { const { pdf } = load(key); return pdf.doc.stream(pdf.catalogEntry('Metadata')).toString('utf8') }
        const ua = xmp('ua'), uaa = xmp('uaa')
        ok(/<pdfuaid:part>1<\/pdfuaid:part>/.test(ua) && /<dc:title>/.test(ua) && !/pdfaid:part/.test(ua), ua)
        ok(/pdfaExtension:schemas/.test(uaa) && /<pdfaid:part>2/.test(uaa) && /<pdfuaid:part>1/.test(uaa), 'PDF/A + UA declares the pdfuaid schema')
        const prefs = load('ua').pdf.catalogEntry('ViewerPreferences')
        ok(prefs?.get('DisplayDocTitle') === true, 'DisplayDocTitle')
        ok(!load('tagged').pdf.catalogEntry('ViewerPreferences'), 'only PDF/UA sets it')
      })
      test('RTL text falls back per run, each where the browser drew it', () => {
      if (!hasHebrew) { ok(true); return }
      eq(JSON.stringify(r.rtlFallback), JSON.stringify({ hebrew: 'rtl', digitsFont: 'T', digitsDir: 'ltr', at: true }))
    })
    test('form fields are named the way browsers name them', () =>
      eq(JSON.stringify(r.fieldNames), JSON.stringify(['From id', 'Wrapped', 'Hint', 'plain'])))
    test('PDF/UA without a title is refused', () => ok(/PDF\/UA requires a document title/.test(r.uaNoTitle), r.uaNoTitle))
    }
    test('box shadows ignore background alpha and paint in CSS order', () =>
      eq(JSON.stringify(r.shadowOrder), JSON.stringify({ translucent: ['+outer', 'fill@0.50'], gradient: ['+outer', 'gradient', '+inset'] })))
    test('tagged link and field annotations sit in Link and Form elements', () => {
      const pdf = readPdf(Buffer.from(r.taggedAnnots, 'base64')), page = pdf.getPage(1), d = page.doc
      const tree = d.resolve(pdf.catalogEntry('StructTreeRoot').get('ParentTree'))
      const nums = d.resolve(tree.get('Nums'))
      const found = (d.resolve(page.dict.get('Annots')) ?? []).map(ref => {
        const key = Number(d.resolve(d.resolve(ref).get('StructParent')))
        const at = nums.findIndex((v, i) => i % 2 === 0 && Number(v) === key)
        const elem = at >= 0 ? d.resolve(nums[at + 1]) : null
        const kids = [d.resolve(elem?.get('K'))].flat().map(k => d.resolve(k))
        return [elem?.get('S')?.name, kids.some(k => k instanceof Map && k.get('Obj')?.num === ref.num)]
      })
      eq(JSON.stringify(found), JSON.stringify([['Link', true], ['Form', true]]))
    })
    test('mask-repeat round keeps the mask image\'s aspect ratio', () =>
      eq(JSON.stringify(r.maskRound), JSON.stringify([255, 0])))
    test('a calc() background size resolves against the box', () =>
      eq(JSON.stringify(r.bgCalcSize), JSON.stringify([[135, 135]])))
    test('a blended list item blends its numbered and shaped markers', () =>
      eq(JSON.stringify(r.markerBlend), JSON.stringify(['Multiply', 'Multiply'])))
    test('an ellipsized line with word spacing keeps fewer characters and carries the spacing', () => {
      const [[text, ws]] = r.ellipsisWs, [[plain]] = r.ellipsis
      ok(text.endsWith('…') && text.length < plain.length && ws === 9, JSON.stringify([text, plain, ws]))
    })
    test('a line-clamped box ends its last visible line with an ellipsis', () =>
      ok(r.lineClamp.length >= 3 && r.lineClamp[1].endsWith('…') && !r.lineClamp[0].endsWith('…'), JSON.stringify(r.lineClamp)))
    test('a live element re-captured after gaining a clamp gets its ellipsis', () =>
      ok(!r.reclamp.before.some(t => t.endsWith('…')) && r.reclamp.after[1]?.endsWith('…'), JSON.stringify(r.reclamp)))
    test('RTL list markers sit right of the content, the period first', () =>
      eq(JSON.stringify(r.rtlMarkers), JSON.stringify({ discRight: true, numText: '.1', numRight: true })))
    test('filter raster text uses the template font, not a fallback', () =>
      ok(r.filterFontDiffers === true, `template-font raster identical to serif: ${r.filterFontDiffers}`))
  }
}
