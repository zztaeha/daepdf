import type { BorderRadius, Corner, PathSeg } from '../types/index.js'
import { PX_PER_PT } from './types.js'
import { pxToPt, resolveLength, splitByTopLevelComma, splitPositionPair } from './css.js'

export type ClipShape =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; radius?: BorderRadius | undefined }
  | { kind: 'path'; ops: PathSeg[]; evenOdd: boolean }

const RADIUS_TOK = '(closest-side|farthest-side|closest-corner|farthest-corner|[\\d.]+(?:px|%)|calc\\([^()]*\\))'

// px, % and calc(% ± px), as computed style serializes shape arguments
function lengthPct(tok: string | undefined, ref: number): number {
  return tok ? resolveLength(tok, ref) ?? 0 : 0
}

// circle()'s single radius keyword resolves against all four side distances at once
function circleKeywordRadius(kw: string, cx: number, cy: number, w: number, h: number): number {
  const sides   = [cx, w - cx, cy, h - cy]
  const corners = [Math.hypot(cx, cy), Math.hypot(w - cx, cy), Math.hypot(cx, h - cy), Math.hypot(w - cx, h - cy)]
  if (kw === 'closest-side')   return Math.min(...sides)
  if (kw === 'farthest-side')  return Math.max(...sides)
  if (kw === 'closest-corner') return Math.min(...corners)
  return Math.max(...corners) // farthest-corner
}

// ellipse()'s two radius keywords resolve independently, per axis. The exact
// spec formula for corner keywords couples both axes to the box's aspect ratio;
// approximated here with the same-axis side distance (documented simplification —
// corner keywords on ellipse() are rare in practice, unlike circle()'s default).
function ellipseAxisRadius(kw: string, centerAlongAxis: number, extent: number): number {
  const near = centerAlongAxis, far = extent - centerAlongAxis
  if (kw === 'closest-side' || kw === 'closest-corner') return Math.min(near, far)
  return Math.max(near, far)
}

function resolvePosition(atClause: string | undefined, w: number, h: number): { cx: number; cy: number } {
  if (!atClause) return { cx: w / 2, cy: h / 2 }
  const [xTok, yTok] = splitPositionPair(atClause)
  return { cx: lengthPct(xTok, w), cy: lengthPct(yTok, h) }
}

function parseInset(inner: string, w: number, h: number): ClipShape | null {
  const roundM  = inner.match(/^(.*?)(?:\s+round\s+(.+))?$/s)
  const sideStr = (roundM?.[1] ?? inner).trim()
  const roundStr = roundM?.[2]?.trim()

  const toks = splitPositionPair(sideStr).filter(Boolean)
  if (!toks.length || toks.length > 4) return null
  // margin/padding-style 1/2/3/4-value expansion — top/right/bottom/left resolve
  // against height/width/height/width respectively, per each side's own axis
  const top    = lengthPct(toks[0], h)
  const right  = lengthPct(toks[1] ?? toks[0], w)
  const bottom = lengthPct(toks[2] ?? toks[0], h)
  const left   = lengthPct(toks[3] ?? toks[1] ?? toks[0], w)

  const x = left, y = top
  const rw = Math.max(0, w - left - right)
  const rh = Math.max(0, h - top - bottom)

  let radius: BorderRadius | undefined
  if (roundStr) {
    // border-radius shorthand inside inset() can itself carry "H / V" components —
    // reuse the same per-corner parsing shape as border-radius (1-4 values, each
    // possibly "H V" for elliptical corners), resolved against the INSET rect
    const [hPart = '', vPart] = roundStr.split('/').map(s => s.trim())
    const hToks = splitPositionPair(hPart)
    const vToks = splitPositionPair(vPart ?? hPart)
    const at = (arr: string[], i: number) => arr[i] ?? arr[(i + 2) % arr.length] ?? arr[0]
    const corner = (i: number): Corner => ({
      h: lengthPct(at(hToks, i), rw),
      v: lengthPct(at(vToks, i), rh),
    })
    radius = { topLeft: corner(0), topRight: corner(1), bottomRight: corner(2), bottomLeft: corner(3) }
  }

  return { kind: 'rect', x, y, w: rw, h: rh, radius }
}

function parseCircle(inner: string, w: number, h: number): ClipShape | null {
  const re = new RegExp(`^\\s*(?:${RADIUS_TOK}\\s*)?(?:at\\s+(.+))?\\s*$`)
  const m = re.exec(inner)
  if (!m) return null
  const { cx, cy } = resolvePosition(m[2], w, h)
  const radTok = m[1]
  const r = !radTok ? circleKeywordRadius('closest-side', cx, cy, w, h)
    : !/^(closest|farthest)-/.test(radTok) ? lengthPct(radTok, Math.sqrt((w * w + h * h) / 2))
    : circleKeywordRadius(radTok, cx, cy, w, h)
  return { kind: 'rect', x: cx - r, y: cy - r, w: r * 2, h: r * 2, radius: { all: r } }
}

function parseEllipse(inner: string, w: number, h: number): ClipShape | null {
  const re = new RegExp(`^\\s*(?:${RADIUS_TOK}\\s+${RADIUS_TOK}\\s*)?(?:at\\s+(.+))?\\s*$`)
  const m = re.exec(inner)
  if (!m) return null
  const { cx, cy } = resolvePosition(m[3], w, h)
  const rxTok = m[1], ryTok = m[2]
  const rx = !rxTok ? ellipseAxisRadius('closest-side', cx, w)
    : !/^(closest|farthest)-/.test(rxTok) ? lengthPct(rxTok, w)
    : ellipseAxisRadius(rxTok, cx, w)
  const ry = !ryTok ? ellipseAxisRadius('closest-side', cy, h)
    : !/^(closest|farthest)-/.test(ryTok) ? lengthPct(ryTok, h)
    : ellipseAxisRadius(ryTok, cy, h)
  const corner: Corner = { h: rx, v: ry }
  return { kind: 'rect', x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2, radius: { topLeft: corner, topRight: corner, bottomRight: corner, bottomLeft: corner } }
}

function parsePolygon(inner: string, w: number, h: number): ClipShape | null {
  let rest = inner.trim()
  let evenOdd = false
  const ruleM = rest.match(/^(nonzero|evenodd)\s*,\s*/)
  if (ruleM) { evenOdd = ruleM[1] === 'evenodd'; rest = rest.slice(ruleM[0].length) }

  const points = splitByTopLevelComma(rest).map(pair => {
    const [xTok, yTok] = splitPositionPair(pair)
    return [lengthPct(xTok, w), lengthPct(yTok, h)] as [number, number]
  })
  if (points.length < 3) return null

  const [start, ...rest2] = points
  if (!start) return null
  const ops: PathSeg[] = [{ op: 'm', args: start }]
  for (const pt of rest2) ops.push({ op: 'l', args: pt })
  return { kind: 'path', ops, evenOdd }
}

// SVG path-data mini-parser: M/L/H/V/C/S/Q/T/A/Z, absolute and relative. Numbers are
// tokenized with a regex rather than a full SVG-number-grammar walk — adjacent
// unsigned numbers without a separator ("1.5.5" meaning "1.5" then ".5") are not
// split; this covers realistic author/tool-generated path data, not adversarial input.
function tokenizePathNumbers(s: string): number[] {
  return (s.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? []).map(Number)
}

// Arc flags are single digits that may run straight into the next number: "A7 7 0 105 9.3"
// is rx=7 ry=7 rot=0 laf=1 sf=0 x=5 y=9.3, where the generic tokenizer would read laf=105
function tokenizeArcArgs(s: string): number[] {
  const out: number[] = []
  let i = 0
  const numRe = /-?\d*\.?\d+(?:[eE][-+]?\d+)?/y
  const skipSep = () => { while (i < s.length && /[\s,]/.test(s[i]!)) i++ }
  const readNumber = (): number | undefined => {
    skipSep()
    numRe.lastIndex = i
    const m = numRe.exec(s)
    if (!m) return undefined
    i = numRe.lastIndex
    return Number(m[0])
  }
  const readFlag = (): number | undefined => {
    skipSep()
    const c = s[i]
    if (c !== '0' && c !== '1') return undefined
    i++
    return Number(c)
  }
  for (;;) {
    const rx = readNumber(); if (rx === undefined) break
    const ry = readNumber(); if (ry === undefined) break
    const rot = readNumber(); if (rot === undefined) break
    const laf = readFlag(); if (laf === undefined) break
    const sf = readFlag(); if (sf === undefined) break
    const x = readNumber(); if (x === undefined) break
    const y = readNumber(); if (y === undefined) break
    out.push(rx, ry, rot, laf, sf, x, y)
  }
  return out
}

function quadToCubic(x0: number, y0: number, qx: number, qy: number, x: number, y: number): number[] {
  return [
    x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0),
    x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
    x, y,
  ]
}

// endpoint-to-center parameterization (SVG spec F.6.5) + one cubic bezier per
// <=90° segment (standard kappa = 4/3*tan(delta/4) construction)
function arcToCubics(x0: number, y0: number, rx: number, ry: number, phiDeg: number,
                     largeArc: boolean, sweep: boolean, x: number, y: number): number[][] {
  if (rx === 0 || ry === 0) return [[x0 + (x - x0) / 3, y0 + (y - y0) / 3, x0 + 2 * (x - x0) / 3, y0 + 2 * (y - y0) / 3, x, y]]
  rx = Math.abs(rx); ry = Math.abs(ry)
  const phi = phiDeg * Math.PI / 180
  const cosP = Math.cos(phi), sinP = Math.sin(phi)

  const dx2 = (x0 - x) / 2, dy2 = (y0 - y) / 2
  const x1p =  cosP * dx2 + sinP * dy2
  const y1p = -sinP * dx2 + cosP * dy2

  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s }

  const sign = largeArc === sweep ? -1 : 1
  const num  = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den  = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const co   = sign * Math.sqrt(Math.max(0, num) / (den || 1e-9))
  const cxp  = co * (rx * y1p / ry)
  const cyp  = co * -(ry * x1p / rx)

  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2

  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    const a = Math.acos(Math.min(1, Math.max(-1, dot / (len || 1e-9))))
    return (ux * vy - uy * vx < 0 ? -1 : 1) * a
  }
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI

  const segments = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)))
  const delta = dtheta / segments
  const out: number[][] = []
  for (let i = 0; i < segments; i++) {
    const a1 = theta1 + i * delta, a2 = a1 + delta
    const k = (4 / 3) * Math.tan(delta / 4)
    const p0: [number, number] = [Math.cos(a1), Math.sin(a1)]
    const p3: [number, number] = [Math.cos(a2), Math.sin(a2)]
    const p1: [number, number] = [p0[0] - k * Math.sin(a1), p0[1] + k * Math.cos(a1)]
    const p2: [number, number] = [p3[0] + k * Math.sin(a2), p3[1] - k * Math.cos(a2)]
    const tf = (px: number, py: number): [number, number] =>
      [cx + cosP * rx * px - sinP * ry * py, cy + sinP * rx * px + cosP * ry * py]
    const [x1, y1] = tf(p1[0], p1[1])
    const [x2, y2] = tf(p2[0], p2[1])
    const [x3, y3] = tf(p3[0], p3[1])
    out.push([x1, y1, x2, y2, x3, y3])
  }
  return out
}

export function parseSvgPath(d: string): PathSeg[] {
  const ops: PathSeg[] = []
  let cx = 0, cy = 0, startX = 0, startY = 0
  let lastCubicCtrl: [number, number] | null = null
  let lastQuadCtrl: [number, number] | null = null

  const cmdRe = /([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g
  let m: RegExpExecArray | null
  while ((m = cmdRe.exec(d)) !== null) {
    const cmd  = m[1]!
    const rel  = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const args = C === 'A' ? tokenizeArcArgs(m[2] ?? '') : tokenizePathNumbers(m[2] ?? '')
    let ai = 0
    // a truncated command left the current point NaN, which poisoned every
    // coordinate after it; a missing number reads as 0, as hpf already did
    const next = () => args[ai++] ?? 0

    const emitLine = (x: number, y: number) => { ops.push({ op: 'l', args: [x, y] }); cx = x; cy = y }
    const emitCubic = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
      ops.push({ op: 'c', args: [x1, y1, x2, y2, x3, y3] }); cx = x3; cy = y3
    }

    do {
      if (C === 'M') {
        const x = next(), y = next()
        cx = rel ? cx + x : x; cy = rel ? cy + y : y
        startX = cx; startY = cy
        ops.push({ op: 'm', args: [cx, cy] })
        // subsequent coordinate pairs after an initial M are implicit linetos
        while (args[ai] !== undefined) {
          const lx = next(), ly = next()
          emitLine(rel ? cx + lx : lx, rel ? cy + ly : ly)
        }
      } else if (C === 'L') {
        const x = next(), y = next()
        emitLine(rel ? cx + x : x, rel ? cy + y : y)
      } else if (C === 'H') {
        const x = next()
        emitLine(rel ? cx + x : x, cy)
      } else if (C === 'V') {
        const y = next()
        emitLine(cx, rel ? cy + y : y)
      } else if (C === 'C') {
        const x1 = next(), y1 = next(), x2 = next(), y2 = next(), x = next(), y = next()
        const X1 = rel ? cx + x1 : x1, Y1 = rel ? cy + y1 : y1
        const X2 = rel ? cx + x2 : x2, Y2 = rel ? cy + y2 : y2
        const X  = rel ? cx + x  : x,  Y  = rel ? cy + y  : y
        lastCubicCtrl = [X2, Y2]; lastQuadCtrl = null
        emitCubic(X1, Y1, X2, Y2, X, Y)
      } else if (C === 'S') {
        const x2 = next(), y2 = next(), x = next(), y = next()
        const X2 = rel ? cx + x2 : x2, Y2 = rel ? cy + y2 : y2
        const X  = rel ? cx + x  : x,  Y  = rel ? cy + y  : y
        const rx1: number = lastCubicCtrl ? 2 * cx - lastCubicCtrl[0] : cx
        const ry1: number = lastCubicCtrl ? 2 * cy - lastCubicCtrl[1] : cy
        lastCubicCtrl = [X2, Y2]; lastQuadCtrl = null
        emitCubic(rx1, ry1, X2, Y2, X, Y)
      } else if (C === 'Q') {
        const qx = next(), qy = next(), x = next(), y = next()
        const QX = rel ? cx + qx : qx, QY = rel ? cy + qy : qy
        const X  = rel ? cx + x  : x,  Y  = rel ? cy + y  : y
        lastQuadCtrl = [QX, QY]; lastCubicCtrl = null
        emitCubic(...(quadToCubic(cx, cy, QX, QY, X, Y) as [number, number, number, number, number, number]))
      } else if (C === 'T') {
        const x = next(), y = next()
        const X = rel ? cx + x : x, Y = rel ? cy + y : y
        const tqx: number = lastQuadCtrl ? 2 * cx - lastQuadCtrl[0] : cx
        const tqy: number = lastQuadCtrl ? 2 * cy - lastQuadCtrl[1] : cy
        lastQuadCtrl = [tqx, tqy]; lastCubicCtrl = null
        emitCubic(...(quadToCubic(cx, cy, tqx, tqy, X, Y) as [number, number, number, number, number, number]))
      } else if (C === 'A') {
        const rx = next(), ry = next(), rot = next(), laf = next(), sf = next(), x = next(), y = next()
        const X = rel ? cx + x : x, Y = rel ? cy + y : y
        const x0 = cx, y0 = cy
        for (const seg of arcToCubics(x0, y0, rx, ry, rot, !!laf, !!sf, X, Y)) {
          ops.push({ op: 'c', args: seg })
        }
        cx = X; cy = Y
        lastCubicCtrl = null; lastQuadCtrl = null
      } else if (C === 'Z') {
        ops.push({ op: 'l', args: [startX, startY] })
        cx = startX; cy = startY
        lastCubicCtrl = null; lastQuadCtrl = null
        break
      }
    } while (C === 'M' ? false : args[ai] !== undefined && C !== 'Z')
  }
  return ops
}

function parsePathFn(inner: string): ClipShape | null {
  let rest = inner.trim()
  let evenOdd = false
  const ruleM = rest.match(/^(nonzero|evenodd)\s*,\s*/)
  if (ruleM) { evenOdd = ruleM[1] === 'evenodd'; rest = rest.slice(ruleM[0].length) }
  const strM = rest.match(/^"((?:[^"\\]|\\.)*)"$/) ?? rest.match(/^'((?:[^'\\]|\\.)*)'$/)
  if (!strM) return null
  const ops = parseSvgPath((strM[1] ?? '').replace(/\\(.)/g, '$1'))
  if (!ops.length) return null
  // path() coordinates are 1 unit = 1 CSS px in the reference box's own space
  const toPt = (seg: PathSeg): PathSeg => ({ op: seg.op, args: seg.args.map(v => v / PX_PER_PT) })
  return { kind: 'path', ops: ops.map(toPt), evenOdd }
}

type Box = { x: number; y: number; w: number; h: number }

// A shape's reference box: border-box by default, or the geometry box written next to it
// (SVG's fill/stroke/view-box map to border-box on HTML elements, as in browsers)
function referenceBox(kw: string | undefined, border: Box, s: CSSStyleDeclaration): Box {
  const side = (prop: string) => pxToPt((s as any)[prop] || '0px')
  const inset = (t: number, r: number, b: number, l: number): Box =>
    ({ x: border.x + l, y: border.y + t, w: Math.max(0, border.w - l - r), h: Math.max(0, border.h - t - b) })
  const bw = ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'].map(side)
  const pad = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].map(side)
  const mar = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'].map(side)
  if (kw === 'padding-box') return inset(bw[0]!, bw[1]!, bw[2]!, bw[3]!)
  if (kw === 'content-box') return inset(bw[0]! + pad[0]!, bw[1]! + pad[1]!, bw[2]! + pad[2]!, bw[3]! + pad[3]!)
  if (kw === 'margin-box') return inset(-mar[0]!, -mar[1]!, -mar[2]!, -mar[3]!)
  return border
}

// box: the border box in pt, container-relative. Returned shapes'
// coordinates are ALSO container-relative pt — ready to feed straight into a
// ClipCommand alongside x/y/w/h/radius (rect) or path (path), no further offset.
export function parseClipPath(value: string, border: Box, s: CSSStyleDeclaration): ClipShape | null {
  const v = value.trim()
  if (!v || v === 'none') return null

  const BOX = '(margin-box|border-box|padding-box|content-box|fill-box|stroke-box|view-box)'
  const fnM = v.match(new RegExp(`^(?:${BOX}\\s+)?(inset|circle|ellipse|polygon|path)\\((.+)\\)(?:\\s+${BOX})?$`, 's'))
  if (!fnM) return null
  const [, boxBefore, fn, argsRaw = '', boxAfter] = fnM
  const box = referenceBox(boxBefore ?? boxAfter, border, s)

  let shape: ClipShape | null = null
  if (fn === 'inset')   shape = parseInset(argsRaw, box.w, box.h)
  if (fn === 'circle')  shape = parseCircle(argsRaw, box.w, box.h)
  if (fn === 'ellipse') shape = parseEllipse(argsRaw, box.w, box.h)
  if (fn === 'polygon') shape = parsePolygon(argsRaw, box.w, box.h)
  if (fn === 'path')    shape = parsePathFn(argsRaw)
  if (!shape) return null

  if (shape.kind === 'rect') return { ...shape, x: shape.x + box.x, y: shape.y + box.y }
  return { ...shape, ops: shape.ops.map(seg => ({ op: seg.op, args: offsetArgs(seg.args, box.x, box.y) })) }
}

function offsetArgs(args: number[], dx: number, dy: number): number[] {
  return args.map((v, i) => v + (i % 2 === 0 ? dx : dy))
}
