import type { ConicGradient, Gradient, GradientStop } from '../types/index.js'
import { PX_PER_PT } from './types.js'
import { parseCSSGradient, parsePositionComponent, resolveGradientBox, splitByTopLevelComma, tileStops } from './css.js'

// Shared recursive Canvas2D painter — rasterizes a live element's own subtree
// (background/border/radius, text, images) at device-pixel-ratio scale. Used
// by both CSS filter (filters.ts) and mask-image (mask.ts), neither of which
// has a PDF operator equivalent and so can only be applied by rasterizing
// the element first.
//
// Deliberately NOT built on an SVG <foreignObject> + canvas.drawImage (the
// technique pdf/svg.ts uses for actual <svg> elements): confirmed by testing,
// not assumed, that drawing an SVG-sourced image containing a foreignObject
// permanently taints the destination canvas (toDataURL refuses to export) in
// current Chromium, regardless of the foreignObject's content. That
// technique only works for pure SVG with no embedded HTML — exactly what
// emitInlineSVG already limits itself to, which is why it never hit this wall.
//
// Known limits: the browser's own fonts, no url() backgrounds or text decorations, and a
// border drawn from its top side alone. Enough for the usual box, card, icon or label.

const TRANSPARENT = new Set(['rgba(0, 0, 0, 0)', 'transparent'])

// background color, then gradient layers (last listed first, as CSS paints them), inside
// the per-corner radius; the border reads only the top side
function paintBoxDecoration(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, cs: CSSStyleDeclaration, dpr: number): void {
  if (w <= 0 || h <= 0) return
  const corner = (v: string) => Math.min(parseFloat(v) || 0, w / 2 / dpr, h / 2 / dpr) * dpr
  const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(corner)

  c.beginPath()
  if (radii.some(r => r > 0)) c.roundRect(x, y, w, h, radii)
  else c.rect(x, y, w, h)

  const bg = cs.backgroundColor
  if (bg && !TRANSPARENT.has(bg)) { c.fillStyle = bg; c.fill() }

  if (cs.backgroundImage && cs.backgroundImage !== 'none') {
    const layers = splitByTopLevelComma(cs.backgroundImage)
    for (let i = layers.length - 1; i >= 0; i--) {
      const g = parseCSSGradient((layers[i] ?? '').trim())
      if (!g) continue
      c.save()
      c.clip()
      c.translate(x, y)
      fillGradient(c, resolveGradientBox(g, w / dpr / PX_PER_PT, h / dpr / PX_PER_PT), w, h)
      c.restore()
    }
  }

  const bw = parseFloat(cs.borderTopWidth) || 0
  if (bw > 0 && cs.borderTopStyle !== 'none') {
    c.lineWidth = bw * dpr
    c.strokeStyle = cs.borderTopColor
    c.stroke()
  }
}

function transformText(text: string, transform: string): string {
  if (transform === 'uppercase') return text.toUpperCase()
  if (transform === 'lowercase') return text.toLowerCase()
  return text
}

// Each word where the browser laid it out, on the font's own baseline. Drawn at the CSS
// size under a dpr scale: a variable font's optical size would follow a dpr-sized font.
function paintText(c: CanvasRenderingContext2D, node: Text, rootRect: DOMRect, cs: CSSStyleDeclaration, dpr: number): void {
  const text = node.textContent
  if (!text.trim()) return
  c.save()
  c.scale(dpr, dpr)
  c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  if ('letterSpacing' in c) c.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
  c.fillStyle = cs.color
  c.textBaseline = 'alphabetic'
  c.textAlign = 'left'
  const ascent = c.measureText('Hg').fontBoundingBoxAscent
  const range = node.ownerDocument.createRange()
  for (const m of text.matchAll(/\S+/g)) {
    range.setStart(node, m.index)
    range.setEnd(node, m.index + m[0].length)
    const r = range.getClientRects()[0]
    if (!r || (r.width < 0.1 && r.height < 0.1)) continue
    c.fillText(transformText(m[0], cs.textTransform), r.left - rootRect.left, r.top - rootRect.top + ascent)
  }
  c.restore()
}

function paintImage(c: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number): void {
  if (!img.complete || img.naturalWidth === 0) return
  try { c.drawImage(img, x, y, w, h) } catch { /* cross-origin source — skipped, not fatal to the rest */ }
}

export function paintNode(node: Element, c: CanvasRenderingContext2D, rootRect: DOMRect, dpr: number): void {
  const cs = getComputedStyle(node)
  if (cs.display === 'none' || cs.visibility === 'hidden') return

  const r = node.getBoundingClientRect()
  const x = (r.left - rootRect.left) * dpr
  const y = (r.top  - rootRect.top)  * dpr
  const w = r.width  * dpr
  const h = r.height * dpr

  if (node.tagName === 'IMG') { paintImage(c, node as HTMLImageElement, x, y, w, h); return }

  c.save()
  paintBoxDecoration(c, x, y, w, h, cs, dpr)
  c.restore()

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) paintNode(child as Element, c, rootRect, dpr)
    else if (child.nodeType === Node.TEXT_NODE) paintText(c, child as Text, rootRect, cs, dpr)
  }
}

// PNG bytes out of a canvas, synchronously (toDataURL, not toBlob) for the synchronous emit
// paths; null for a tainted canvas, so callers skip it
export function canvasToPngBytes(canvas: HTMLCanvasElement): Uint8Array | null {
  let dataUrl: string
  try { dataUrl = canvas.toDataURL('image/png') } catch { return null }
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null
  const bin = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// A url() source for a canvas: CORS mode so a CORS-enabled host can be exported from the
// canvas; any other cross-origin image fails to load instead of tainting it
export function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload  = () => resolve(img)
    img.onerror = () => resolve(null)
    img.src = url
  })
}

function addStops(grad: CanvasGradient, stops: GradientStop[]): void {
  for (const st of stops) {
    const [r, g, b, a] = st.color
    grad.addColorStop(Math.min(1, Math.max(0, st.position)), `rgba(${r},${g},${b},${a / 255})`)
  }
}

// Fills a w×h canvas with a conic gradient painted over a wPt×hPt box (its center resolves
// against the box). Canvas measures the start angle from +x, CSS from 12 o'clock.
export function fillConic(c: CanvasRenderingContext2D, cg: ConicGradient, w: number, h: number, wPt: number, hPt: number): void {
  if (typeof c.createConicGradient !== 'function') return
  const cx = wPt > 0 ? parsePositionComponent(cg.position?.[0], wPt) / wPt : 0.5
  const cy = hPt > 0 ? parsePositionComponent(cg.position?.[1], hPt) / hPt : 0.5
  const grad = c.createConicGradient((cg.fromDeg - 90) * Math.PI / 180, cx * w, cy * h)
  addStops(grad, tileStops(cg.stops, cg.repeating))
  c.fillStyle = grad
  c.fillRect(0, 0, w, h)
}

// Fills a w×h area at the current origin with a box-resolved gradient (resolveGradientBox),
// in canvas Y-down space; a radial ellipse is a circle of radius rx squashed to ry.
export function fillGradient(c: CanvasRenderingContext2D, g: Gradient, w: number, h: number): void {
  c.save()
  if (g.type === 'linear') {
    const rad = g.angle * Math.PI / 180
    const dx = Math.sin(rad), dy = -Math.cos(rad)
    const half = Math.abs(w * dx) / 2 + Math.abs(h * dy) / 2
    const grad = c.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half)
    addStops(grad, g.stops)
    c.fillStyle = grad
    c.fillRect(0, 0, w, h)
  } else {
    const rx = Math.max(1e-3, w * (g.rx ?? 0.5)), ry = Math.max(1e-3, h * (g.ry ?? 0.5))
    const k = ry / rx, cx = w * (g.cx ?? 0.5), cy = h * (g.cy ?? 0.5)
    c.transform(1, 0, 0, k, cx, cy)
    const grad = c.createRadialGradient(0, 0, 0, 0, 0, rx)
    addStops(grad, g.stops)
    c.fillStyle = grad
    // the w×h box, expressed in the squashed space the transform set up
    c.fillRect(-cx, -cy / k, w, h / k)
  }
  c.restore()
}
