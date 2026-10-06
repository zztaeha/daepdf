import type { PathSeg, Color, ColorAlpha, Gradient, GradientStop } from '../types/index.js'
import { parseSvgPath } from '../html/clippath.js'
import { IDENTITY, composeAffine, type Affine } from '../types/affine.js'

export interface VectorShape {
  ops:         PathSeg[]
  evenOdd:     boolean
  fill?:       Color
  stroke?:     Color
  strokeWidth?: number
  dashArray?:  number[]
  lineCap?:    number
  lineJoin?:   number
  gradient?:    Gradient
  gradientBox?: { x: number; y: number; w: number; h: number }
  opacity?:     number
}

// Points stay in DOM/CSS Y-down page-relative pt the whole way through; PdfDoc's own
// Y-flip, shared with every other path and clip, happens once at the bottom.
function transformOps(ops: PathSeg[], m: Affine): PathSeg[] {
  return ops.map(seg => {
    const args = seg.args
    const out: number[] = new Array(args.length)
    for (let i = 0; i < args.length; i += 2) {
      const ax = args[i] ?? 0, ay = args[i + 1] ?? 0
      out[i]     = m[0] * ax + m[2] * ay + m[4]
      out[i + 1] = m[1] * ax + m[3] * ay + m[5]
    }
    return { op: seg.op, args: out }
  })
}

// distinct from CSS's single matrix(...) form — SVG's `transform` attribute is
// a space/comma-separated LIST of functions, composed left-to-right (each one
// nests inside the previous, exactly like nested <g> elements would)
function parseSvgTransformAttr(attr: string): Affine {
  let m: Affine = IDENTITY
  const re = /(\w+)\s*\(([^)]*)\)/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(attr)) !== null) {
    const fn   = mm[1]
    const args = (mm[2] ?? '').split(/[\s,]+/).filter(Boolean).map(Number)
    let fm: Affine = IDENTITY
    if (fn === 'translate') {
      fm = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0]
    } else if (fn === 'scale') {
      fm = [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0]
    } else if (fn === 'rotate') {
      const rad = (args[0] ?? 0) * Math.PI / 180
      const cos = Math.cos(rad), sin = Math.sin(rad)
      const cx = args[1] ?? 0, cy = args[2] ?? 0
      const rot: Affine = [cos, sin, -sin, cos, 0, 0]
      fm = composeAffine([1, 0, 0, 1, cx, cy], composeAffine(rot, [1, 0, 0, 1, -cx, -cy]))
    }
    if (fn === 'skewX') fm = [1, 0, Math.tan((args[0] ?? 0) * Math.PI / 180), 1, 0, 0]
    if (fn === 'skewY') fm = [1, Math.tan((args[0] ?? 0) * Math.PI / 180), 0, 1, 0, 0]
    if (fn === 'matrix') fm = [args[0] ?? 1, args[1] ?? 0, args[2] ?? 0, args[3] ?? 1, args[4] ?? 0, args[5] ?? 0]
    m = composeAffine(m, fm)
  }
  return m
}

// Anything else CSS accepts (all named colors, hsl(), hwb(), ...) is normalized by the
// browser's own parser: a canvas fillStyle reads back as #rrggbb or rgba().
let colorProbe: CanvasRenderingContext2D | null | undefined
function browserColor(v: string): ColorAlpha | null {
  colorProbe ??= document.createElement('canvas').getContext('2d')
  if (!colorProbe) return null
  const read = (sentinel: string) => { colorProbe!.fillStyle = sentinel; colorProbe!.fillStyle = v; return String(colorProbe!.fillStyle) }
  const out = read('#000001')
  // an invalid value leaves the sentinel in place; a second, different sentinel tells them apart
  if (out !== read('#000002')) return null
  const hex = out.match(/^#([0-9a-f]{6})$/)
  if (hex) { const n = parseInt(hex[1]!, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255] }
  const m = out.match(/^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/)
  return m ? [+m[1]!, +m[2]!, +m[3]!, m[4] !== undefined ? Math.round(+m[4] * 255) : 255] : null
}

// SVG attribute color values (fill="#f00"/"red"/"rgb(...)"/"none") aren't run
// through getComputedStyle (see the module doc comment on parseSvgColor's
// caller for why) — hex is by far the common case for real, tool-exported
// SVGs, so it needs its own small parser rather than reusing html/css.ts's
// parseColorAlpha, which only ever sees browser-normalized rgb()/rgba().
function parseSvgColor(v: string | null | undefined, currentColor: ColorAlpha): ColorAlpha | null {
  if (!v) return null
  const s = v.trim().toLowerCase()
  if (s === 'none') return null
  if (s === 'currentcolor') return currentColor
  const hex6 = s.match(/^#([0-9a-f]{6})$/)
  if (hex6) { const n = parseInt(hex6[1]!, 16); return [(n>>16)&255, (n>>8)&255, n&255, 255] }
  const hex3 = s.match(/^#([0-9a-f]{3})$/)
  if (hex3) { const [r = '0', g = '0', b = '0'] = hex3[1]!; return [parseInt(r+r,16), parseInt(g+g,16), parseInt(b+b,16), 255] }
  const rgbM = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/)
  if (rgbM) return [+rgbM[1]!, +rgbM[2]!, +rgbM[3]!, rgbM[4] !== undefined ? Math.round(+rgbM[4]*255) : 255]
  if (s === 'transparent') return [0, 0, 0, 0]
  return browserColor(s)
}

function parseNumOr(v: string | null | undefined, fallback: number): number {
  if (v === undefined || v === null) return fallback
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

function parsePercentOrNum(v: string | null | undefined, fallback: number): number {
  if (!v) return fallback
  const s = v.trim()
  if (s.endsWith('%')) return parseFloat(s) / 100
  const n = parseFloat(s)
  return Number.isNaN(n) ? fallback : n
}

// features with no faithful path-based equivalent — presence ANYWHERE in the
// document aborts vector conversion for the WHOLE SVG, falling through to
// the existing raster path (rasterizeSVGs), never a partial conversion
const BAIL_TAGS = ['filter', 'mask', 'pattern', 'clipPath', 'foreignObject', 'text', 'style', 'image', 'tspan', 'textPath']

// A gradient the vector path can paint: its own stops (not inherited through href) in
// objectBoundingBox units
function isPlainGradient(el: Element | null): boolean {
  if (!el || (el.tagName !== 'linearGradient' && el.tagName !== 'radialGradient')) return false
  return el.getElementsByTagName('stop').length >= 2 && el.getAttribute('gradientUnits') !== 'userSpaceOnUse'
}

function hasBailFeature(doc: Document): boolean {
  for (const tag of BAIL_TAGS) if (doc.getElementsByTagName(tag).length) return true
  // a nested <svg> opens its own viewport, which the walk doesn't model
  if (doc.getElementsByTagName('svg').length > 1) return true
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    for (const attr of ['filter', 'mask', 'clip-path']) {
      const v = el.getAttribute(attr)
      if (v && v.trim().startsWith('url(')) return true
    }
    // any paint server other than a plain gradient fill (gradient strokes, missing or
    // href-chained gradients) is painted by the raster path instead
    const style = el.getAttribute('style') ?? ''
    for (const prop of ['fill', 'stroke']) {
      const v = style.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(url\\([^)]*\\))`))?.[1] ?? el.getAttribute(prop)
      const ref = v?.trim().match(/^url\(\s*["']?#([^"')]+)["']?\s*\)/)
      if (v?.trim().startsWith('url(') && (prop === 'stroke' || !ref || !isPlainGradient(doc.getElementById(ref[1]!)))) return true
    }
  }
  return false
}

interface GradientDef {
  isRadial: boolean
  cx: number; cy: number; r: number
  // SVG's radial focal point — a true 0-radius inner circle in the two-circle
  // model. Per spec, fx/fy each independently default to cx/cy when absent
  fx: number; fy: number
  x1: number; y1: number; x2: number; y2: number
  stops: GradientStop[]
  // applied to cx/cy/fx/fy (radial) or x1/y1/x2/y2 (linear) at resolve time,
  // in the SAME bbox-fractional space those coordinates are already defined
  // in — same transform-list syntax as the `transform` attribute
  gradientTransform: Affine
}

function applyAffine(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function parseGradientDefs(doc: Document, currentColor: ColorAlpha): Map<string, GradientDef> {
  const defs = new Map<string, GradientDef>()
  for (const tag of ['linearGradient', 'radialGradient']) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      const id = el.getAttribute('id')
      if (!id) continue
      const stops: GradientStop[] = []
      for (const stopEl of Array.from(el.getElementsByTagName('stop'))) {
        const offset = parsePercentOrNum(stopEl.getAttribute('offset'), 0)
        const style = stopEl.getAttribute('style') ?? ''
        const styleColor = style.match(/stop-color\s*:\s*([^;]+)/)?.[1]
        const styleOpacity = style.match(/stop-opacity\s*:\s*([^;]+)/)?.[1]
        const color = parseSvgColor(styleColor ?? stopEl.getAttribute('stop-color') ?? 'black', currentColor) ?? [0,0,0,255]
        const opacity = parseNumOr(styleOpacity ?? stopEl.getAttribute('stop-opacity'), 1)
        // stop-opacity scales the color's own alpha ("transparent" is black at 0, not opaque)
        const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * color[3])
        stops.push({ position: Math.max(0, Math.min(1, offset)), color: [color[0], color[1], color[2], alpha] })
      }
      if (stops.length < 2) continue
      const cx = parsePercentOrNum(el.getAttribute('cx'), 0.5)
      const cy = parsePercentOrNum(el.getAttribute('cy'), 0.5)
      defs.set(id, {
        isRadial: tag === 'radialGradient',
        cx, cy,
        r:  parsePercentOrNum(el.getAttribute('r'),  0.5),
        fx: el.hasAttribute('fx') ? parsePercentOrNum(el.getAttribute('fx'), cx) : cx,
        fy: el.hasAttribute('fy') ? parsePercentOrNum(el.getAttribute('fy'), cy) : cy,
        x1: parsePercentOrNum(el.getAttribute('x1'), 0), y1: parsePercentOrNum(el.getAttribute('y1'), 0),
        x2: parsePercentOrNum(el.getAttribute('x2'), 1), y2: parsePercentOrNum(el.getAttribute('y2'), 0),
        stops,
        gradientTransform: el.hasAttribute('gradientTransform')
          ? parseSvgTransformAttr(el.getAttribute('gradientTransform')!)
          : IDENTITY,
      })
    }
  }
  return defs
}

interface Style {
  fill: ColorAlpha | null; stroke: ColorAlpha | null; strokeWidth: number
  fillOpacity: number; strokeOpacity: number
  // null = solid (the SVG default); PDF has the identical concept (a plain
  // `[] 0 d`), so this reuses PdfDoc's own set_line_dash rather than a new
  // mechanism — same primitive CSS dashed-border strokes already use
  dash: number[] | null
  // PDF's J/j operators use the exact same 0/1/2 enumeration as SVG's own
  // butt/round/square and miter/round/bevel keywords, so no remapping table
  // is needed beyond the keyword -> index lookup itself
  lineCap: number
  lineJoin: number
  evenOdd: boolean
}

const CAP_MAP:  Record<string, number> = { butt: 0, round: 1, square: 2 }
const JOIN_MAP: Record<string, number> = { miter: 0, round: 1, bevel: 2 }

function readStyle(el: Element, inherited: Style, currentColor: ColorAlpha): Style {
  const style = el.getAttribute('style') ?? ''
  const styleAttr = (name: string) => style.match(new RegExp(`${name}\\s*:\\s*([^;]+)`))?.[1]?.trim()
  const fillRaw   = styleAttr('fill')   ?? el.getAttribute('fill')
  const strokeRaw = styleAttr('stroke') ?? el.getAttribute('stroke')
  const swRaw     = styleAttr('stroke-width') ?? el.getAttribute('stroke-width')
  const foRaw     = styleAttr('fill-opacity') ?? el.getAttribute('fill-opacity')
  const soRaw     = styleAttr('stroke-opacity') ?? el.getAttribute('stroke-opacity')
  const dashRaw   = styleAttr('stroke-dasharray') ?? el.getAttribute('stroke-dasharray')
  const capRaw    = styleAttr('stroke-linecap') ?? el.getAttribute('stroke-linecap')
  const joinRaw   = styleAttr('stroke-linejoin') ?? el.getAttribute('stroke-linejoin')
  const ruleRaw   = styleAttr('fill-rule') ?? el.getAttribute('fill-rule')
  let dash = inherited.dash
  if (dashRaw !== null) {
    if (dashRaw === 'none') dash = null
    else {
      const nums = dashRaw.trim().split(/[\s,]+/).map(parseFloat).filter(n => !Number.isNaN(n) && n >= 0)
      dash = nums.length ? nums : null
    }
  }
  return {
    fill:   fillRaw   !== null ? (fillRaw === 'none' ? null : parseSvgColor(fillRaw, currentColor) ?? inherited.fill) : inherited.fill,
    stroke: strokeRaw !== null ? (strokeRaw === 'none' ? null : parseSvgColor(strokeRaw, currentColor) ?? inherited.stroke) : inherited.stroke,
    // through the same NaN-guarding helper the rest of this file uses: a bare
    // parseFloat here let stroke-width="thin" reach the content stream as the
    // literal token NaN, which a reader drops along with the whole operator
    strokeWidth:   parseNumOr(swRaw, inherited.strokeWidth),
    fillOpacity:   parseNumOr(foRaw, inherited.fillOpacity),
    strokeOpacity: parseNumOr(soRaw, inherited.strokeOpacity),
    dash,
    lineCap:  capRaw  != null && CAP_MAP[capRaw]  !== undefined ? CAP_MAP[capRaw]  : inherited.lineCap,
    lineJoin: joinRaw != null && JOIN_MAP[joinRaw] !== undefined ? JOIN_MAP[joinRaw] : inherited.lineJoin,
    evenOdd:  ruleRaw === 'evenodd' ? true : ruleRaw === 'nonzero' ? false : inherited.evenOdd,
  }
}

function fillUrlRef(el: Element): string | null {
  const style = el.getAttribute('style') ?? ''
  const raw = style.match(/fill\s*:\s*url\(([^)]+)\)/)?.[1] ?? el.getAttribute('fill')
  const m = raw?.match(/^url\((.+)\)$/)
  if (!m) return null
  return (m[1] ?? '').replace(/^["']|["']$/g, '').replace(/^#/, '')
}

function bboxOfOps(ops: PathSeg[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const seg of ops) {
    for (let i = 0; i + 1 < seg.args.length; i += 2) {
      const px = seg.args[i]!, py = seg.args[i + 1]!
      minX = Math.min(minX, px); maxX = Math.max(maxX, px)
      minY = Math.min(minY, py); maxY = Math.max(maxY, py)
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

function rectPathD(x: number, y: number, w: number, h: number, rx: number, ry: number): string {
  if (rx <= 0 || ry <= 0) return `M ${x} ${y} H ${x+w} V ${y+h} H ${x} Z`
  rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2)
  return `M ${x+rx} ${y} H ${x+w-rx} A ${rx} ${ry} 0 0 1 ${x+w} ${y+ry} V ${y+h-ry} A ${rx} ${ry} 0 0 1 ${x+w-rx} ${y+h} H ${x+rx} A ${rx} ${ry} 0 0 1 ${x} ${y+h-ry} V ${y+ry} A ${rx} ${ry} 0 0 1 ${x+rx} ${y} Z`
}

function ellipsePathD(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx-rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx+rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx-rx} ${cy} Z`
}

function shapeToOps(el: Element): PathSeg[] | null {
  const tag = el.tagName
  const num = (name: string, fallback = 0) => parseFloat(el.getAttribute(name) ?? '') || fallback
  if (tag === 'path') {
    const d = el.getAttribute('d')
    return d ? parseSvgPath(d) : null
  }
  if (tag === 'rect') {
    const w = num('width'), h = num('height')
    if (w <= 0 || h <= 0) return null
    let rx = el.hasAttribute('rx') ? num('rx') : (el.hasAttribute('ry') ? num('ry') : 0)
    let ry = el.hasAttribute('ry') ? num('ry') : rx
    return parseSvgPath(rectPathD(num('x'), num('y'), w, h, rx, ry))
  }
  if (tag === 'circle') {
    const r = num('r')
    if (r <= 0) return null
    return parseSvgPath(ellipsePathD(num('cx'), num('cy'), r, r))
  }
  if (tag === 'ellipse') {
    const rx = num('rx'), ry = num('ry')
    if (rx <= 0 || ry <= 0) return null
    return parseSvgPath(ellipsePathD(num('cx'), num('cy'), rx, ry))
  }
  if (tag === 'line') {
    return [{ op: 'm', args: [num('x1'), num('y1')] }, { op: 'l', args: [num('x2'), num('y2')] }]
  }
  if (tag === 'polyline' || tag === 'polygon') {
    const pts = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number)
    if (pts.length < 4) return null
    const ops: PathSeg[] = [{ op: 'm', args: [pts[0]!, pts[1]!] }]
    for (let i = 2; i + 1 < pts.length; i += 2) ops.push({ op: 'l', args: [pts[i]!, pts[i+1]!] })
    if (tag === 'polygon') ops.push({ op: 'l', args: [pts[0]!, pts[1]!] })
    return ops
  }
  return null
}

const MAX_USE_DEPTH = 12
const XLINK_NS = 'http://www.w3.org/1999/xlink'

function walk(
  el: Element, matrix: Affine, inherited: Style,
  gradientDefs: Map<string, GradientDef>, out: VectorShape[], currentColor: ColorAlpha,
  useDepth = 0, groupOpacity = 1,
): void {
  const tag = el.tagName
  if (tag === 'defs') return // definitions only, never painted directly
  // presentation attribute or inline style; an <img>'s SVG file keeps its own
  const prop = (name: string) => (el.getAttribute('style') ?? '').match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`))?.[1]?.trim() ?? el.getAttribute(name)
  if (prop('display') === 'none') return

  const local = el.getAttribute('transform')
  const m = local ? composeAffine(matrix, parseSvgTransformAttr(local)) : matrix
  const style = readStyle(el, inherited, currentColor)
  // a group's opacity reaches its children as a multiplier: exact for non-overlapping
  // children, the same approximation the HTML opacity stack makes
  const elOpacity = parsePercentOrNum(prop('opacity'), 1) * groupOpacity

  if (tag === 'g' || tag === 'svg' || tag === 'a') {
    for (const child of Array.from(el.children)) walk(child, m, style, gradientDefs, out, currentColor, useDepth, elOpacity)
    return
  }

  if (tag === 'use') {
    // <use> is spec'd as stamping a shadow copy of the referenced element,
    // offset by an implicit translate(x,y) INSIDE the use element's own
    // transform attribute (already folded into `m` above, since the
    // generic transform-attribute handling runs before this tag check
    // regardless of tag). A depth cap guards a reference cycle (a <use>
    // whose target directly or indirectly contains that same <use>) from
    // becoming unbounded recursion — real documents never nest this deep.
    if (useDepth >= MAX_USE_DEPTH) return
    const href = el.getAttributeNS(XLINK_NS, 'href') || el.getAttribute('href') || el.getAttribute('xlink:href')
    if (!href || !href.startsWith('#')) return
    const target = el.ownerDocument.getElementById(href.slice(1))
    if (!target) return
    const x = parseFloat(el.getAttribute('x') ?? '') || 0
    const y = parseFloat(el.getAttribute('y') ?? '') || 0
    const um = (x || y) ? composeAffine(m, [1, 0, 0, 1, x, y]) : m
    if (target.tagName !== 'symbol') {
      walk(target, um, style, gradientDefs, out, currentColor, useDepth + 1, elOpacity)
      return
    }
    // a symbol only renders through a <use>: its viewBox maps into the use's box when
    // both are given (meet, centered), otherwise it shares the use's coordinates
    const vb = (target.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
    const uw = parseFloat(el.getAttribute('width') ?? ''), uh = parseFloat(el.getAttribute('height') ?? '')
    let sm = um
    if (vb.length === 4 && vb.every(Number.isFinite) && vb[2]! > 0 && vb[3]! > 0 && uw > 0 && uh > 0) {
      const k = Math.min(uw / vb[2]!, uh / vb[3]!)
      sm = composeAffine(um, [k, 0, 0, k, (uw - vb[2]! * k) / 2 - vb[0]! * k, (uh - vb[3]! * k) / 2 - vb[1]! * k])
    }
    const symStyle = readStyle(target, style, currentColor)
    for (const child of Array.from(target.children)) walk(child, sm, symStyle, gradientDefs, out, currentColor, useDepth + 1, elOpacity)
    return
  }

  if (prop('visibility') === 'hidden') return
  const rawOps = shapeToOps(el)
  if (!rawOps || !rawOps.length) return
  const ops = transformOps(rawOps, m)

  const isLine = tag === 'line'
  const fillRef = !isLine ? fillUrlRef(el) : null
  const shape: VectorShape = {
    ops,
    evenOdd: style.evenOdd,
    opacity: elOpacity,
  }

  if (fillRef && gradientDefs.has(fillRef)) {
    const g = gradientDefs.get(fillRef)!
    const bbox = bboxOfOps(ops)
    const gStops = g.stops.map(s => ({ position: s.position, color: s.color }))
    if (g.isRadial) {
      // gradientTransform applies in the same bbox-fractional space cx/cy/
      // fx/fy are already defined in — transforming the two points here,
      // before they reach the device-space "farthest corner" radius math
      // downstream, correctly repositions/rotates the gradient's center and
      // focal point (a non-uniform-scale component still can't skew the
      // resulting circle into a true ellipse, since the shared radius is
      // synthesized from the box's own aspect ratio downstream, not carried
      // through as an explicit r — the same pre-existing simplification
      // CSS radial-gradients already rely on)
      const [tcx, tcy] = applyAffine(g.gradientTransform, g.cx, g.cy)
      const [tfx, tfy] = applyAffine(g.gradientTransform, g.fx, g.fy)
      shape.gradient = { type: 'radial', cx: tcx, cy: tcy, fx: tfx, fy: tfy, rx: g.r, ry: g.r, straightAlpha: true, stops: gStops }
    } else {
      // SVG's x1/y1->x2/y2 vector lives in Y-DOWN space; the downstream
      // consumer (build_resources.ts's ShadingType 2, shared with CSS
      // linear-gradient) computes its gradient LINE directly in FINAL,
      // Y-UP PDF space via dx=sin(angle),dy=cos(angle) — feeding it a
      // Y-down delta unmodified silently flips the gradient vertically
      // (confirmed via a real render: y1=0/y2=1 red->blue put blue at the
      // TOP instead of the bottom). Negating dy converts the Y-down SVG
      // delta into the Y-up delta the formula actually expects.
      // gradientTransform is applied to both endpoints (in the same
      // bbox-fractional space x1/y1/x2/y2 are defined in) before the
      // direction is derived — any translation component cancels out in
      // the subtraction below exactly like an untransformed endpoint
      // offset already does in this angle-only downstream model, while
      // rotation/scale correctly change the resulting angle.
      const [tx1, ty1] = applyAffine(g.gradientTransform, g.x1, g.y1)
      const [tx2, ty2] = applyAffine(g.gradientTransform, g.x2, g.y2)
      const dx = tx2 - tx1, dy = -(ty2 - ty1)
      const angle = Math.atan2(dx, dy) * 180 / Math.PI
      shape.gradient = { type: 'linear', angle, straightAlpha: true, stops: gStops }
    }
    shape.gradientBox = bbox
  } else if (!isLine && style.fill && style.fill[3] > 0) {
    shape.fill = [style.fill[0], style.fill[1], style.fill[2]]
  }

  if (style.stroke && style.stroke[3] > 0) {
    shape.stroke = [style.stroke[0], style.stroke[1], style.stroke[2]]
    // stroke-width is in the SAME user-space units as geometry, so it must
    // scale with the shape's own transform — approximated via the matrix's
    // average axis scale (exact only for uniform scale/rotation, the
    // overwhelmingly common real-world case; a non-uniform scale's stroke
    // would properly need an elliptical pen, out of scope here)
    const scale = (Math.hypot(m[0], m[1]) + Math.hypot(m[2], m[3])) / 2
    shape.strokeWidth = style.strokeWidth * scale
    // dash lengths are in the same user-space units as stroke-width, so they
    // scale identically
    if (style.dash) shape.dashArray = style.dash.map(n => n * scale)
    // only emit non-default values — matches PDF's own 0/0 (butt/miter)
    // default, so the common case costs nothing extra downstream
    if (style.lineCap)  shape.lineCap  = style.lineCap
    if (style.lineJoin) shape.lineJoin = style.lineJoin
  }

  if (!shape.fill && !shape.gradient && !shape.stroke) return

  // a fill+stroke shares one ExtGState alpha, so the fill's opacity wins (the stroke's when
  // there is no fill); an rgba() or transparent paint color's own alpha multiplies in
  const propOpacity = shape.gradient ? style.fillOpacity
    : shape.fill ? style.fillOpacity * style.fill![3] / 255
    : style.strokeOpacity * style.stroke![3] / 255
  shape.opacity = elOpacity * propOpacity

  out.push(shape)
}

// Parses an SVG document and converts it to a flat list of fill/stroke path
// shapes in page-relative pt (same Y-down convention as every other
// PathSeg-consuming command) — or null if anything in the document needs a
// feature with no faithful vector equivalent here (filters, masks, patterns,
// clip-paths, text, nested rasters, <style> blocks), in which case the
// caller must fall back to the existing raster path (rasterizeSVGs) for the
// WHOLE document rather than attempt a partial conversion.
export function svgToVectorShapes(
  svgStr: string, boxX: number, boxY: number, boxW: number, boxH: number,
  currentColor: ColorAlpha = [0, 0, 0, 255],
): VectorShape[] | null {
  if (boxW <= 0 || boxH <= 0) return null
  let doc: Document
  try {
    doc = new DOMParser().parseFromString(svgStr, 'image/svg+xml')
  } catch { return null }
  if (doc.getElementsByTagName('parsererror').length) return null
  const root = doc.documentElement
  if (root.tagName !== 'svg') return null
  if (hasBailFeature(doc)) return null

  const viewBoxAttr = root.getAttribute('viewBox')
  let vbX = 0, vbY = 0, vbW: number, vbH: number
  if (viewBoxAttr) {
    const parts = viewBoxAttr.trim().split(/[\s,]+/).map(Number)
    if (parts.length !== 4 || parts.some(Number.isNaN) || parts[2]! <= 0 || parts[3]! <= 0) return null
    ;[vbX, vbY, vbW, vbH] = parts as [number, number, number, number]
  } else {
    vbW = parseFloat(root.getAttribute('width') ?? '') || boxW
    vbH = parseFloat(root.getAttribute('height') ?? '') || boxH
  }

  // preserveAspectRatio: SVG's DEFAULT (the attribute absent, which is by far
  // the common case) is "xMidYMid meet" — uniform scale, centered, letterboxed
  // — NOT "stretch to fill both axes independently". Only an explicit "none"
  // wants the independent-scaleX/scaleY stretch every gradientTransform-less
  // case used to get unconditionally, which silently distorted (squashed/
  // stretched) any SVG whose viewBox aspect ratio didn't exactly match its
  // rendered box — confirmed via a real render (a 2:1 viewBox circle rendered
  // into a square box came out as a tall ellipse instead of a letterboxed,
  // still-round circle). "slice" (cover, cropping overflow) is approximated
  // as "meet" here rather than plumbing a clip region through the vector-
  // shape pipeline — a real but rare simplification: the image ends up
  // letterboxed instead of cropped-and-filling, never distorted or clipped
  // wrong.
  const parAttr = (root.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet').trim()
  const parTokens = parAttr.split(/\s+/)
  const align = parTokens.find(t => t !== 'defer') ?? 'xMidYMid'

  let scaleX: number, scaleY: number, tx = 0, ty = 0
  if (align === 'none') {
    scaleX = boxW / vbW
    scaleY = boxH / vbH
  } else {
    const scale = Math.min(boxW / vbW, boxH / vbH)
    scaleX = scale
    scaleY = scale
    const extraX = boxW - vbW * scale
    const extraY = boxH - vbH * scale
    if (align.startsWith('xMid')) tx = extraX / 2
    else if (align.startsWith('xMax')) tx = extraX
    if (align.endsWith('YMid')) ty = extraY / 2
    else if (align.endsWith('YMax')) ty = extraY
  }

  const base: Affine = composeAffine(
    [1, 0, 0, 1, boxX + tx, boxY + ty],
    composeAffine([scaleX, 0, 0, scaleY, 0, 0], [1, 0, 0, 1, -vbX, -vbY]),
  )

  const gradientDefs = parseGradientDefs(doc, currentColor)
  const defaultStyle: Style = { fill: [0,0,0,255], stroke: null, strokeWidth: 1, fillOpacity: 1, strokeOpacity: 1, dash: null, lineCap: 0, lineJoin: 0, evenOdd: false }
  // the root <svg> element can itself carry fill/stroke/etc. (a document-wide
  // default) — resolve it once here rather than hardcoding SVG's own initial
  // values as the base every child inherits from
  const rootStyle = readStyle(root, defaultStyle, currentColor)
  const out: VectorShape[] = []
  for (const child of Array.from(root.children)) walk(child, base, rootStyle, gradientDefs, out, currentColor)
  return out
}
