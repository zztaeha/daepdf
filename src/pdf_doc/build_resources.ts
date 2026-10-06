import type { Affine } from '../types/affine.js'
import type { InternalCtx, GradDef } from './types.js'
import { hpf, _te, bytesToHex } from './utils.js'
import { deflate } from './deflate.js'
import { IDENTITY, composeAffine } from '../types/affine.js'

// An image's own ICC profile, embedded once per distinct profile: without it the pixels
// would be read as plain sRGB, and a P3 or Adobe RGB photo would print off-color
function putIccProfile(ctx: InternalCtx, icc: Uint8Array, components: number, written: Map<string, number>): number {
  const key = `${components}:${bytesToHex(icc)}`
  const known = written.get(key)
  if (known !== undefined) return known
  const oid = ctx.newObject()
  ctx.out('<<')
  ctx.out(`/N ${components}`)
  ctx.out(`/Alternate /${components === 1 ? 'DeviceGray' : components === 4 ? 'DeviceCMYK' : 'DeviceRGB'}`)
  ctx.out(`/Length ${ctx.encryptedLength(icc.length)}`)
  ctx.out('>>')
  ctx.out('stream')
  ctx.outBytes(icc)
  ctx.out('endstream')
  ctx.out('endobj')
  written.set(key, oid)
  return oid
}

export function putImages(ctx: InternalCtx): void {
  const profiles = new Map<string, number>()
  for (const img of ctx.images) {
    const components = img.colorSpace === 'DeviceGray' ? 1 : img.colorSpace === 'DeviceCMYK' ? 4 : 3
    const colorSpace = img.icc ? `[/ICCBased ${putIccProfile(ctx, img.icc, components, profiles)} 0 R]` : `/${img.colorSpace}`

    let smaskObjId = 0
    if (img.smask) {
      const smaskData = deflate(img.smask)
      smaskObjId = ctx.newObject()
      ctx.out('<<')
      ctx.out('/Type /XObject')
      ctx.out('/Subtype /Image')
      ctx.out(`/Width ${img.width}`)
      ctx.out(`/Height ${img.height}`)
      ctx.out('/ColorSpace /DeviceGray')
      ctx.out('/BitsPerComponent 8')
      ctx.out('/Filter /FlateDecode')
      ctx.out(`/Length ${ctx.encryptedLength(smaskData.length)}`)
      ctx.out('>>')
      ctx.out('stream')
      ctx.outBytes(smaskData)
      ctx.out('endstream')
      ctx.out('endobj')
    }

    const oid = ctx.newObject()
    img.objectNumber = oid

    ctx.out('<<')
    ctx.out('/Type /XObject')
    ctx.out('/Subtype /Image')
    ctx.out(`/Width ${img.width}`)
    ctx.out(`/Height ${img.height}`)
    ctx.out(`/ColorSpace ${colorSpace}`)
    ctx.out('/BitsPerComponent 8')
    ctx.out(`/Filter ${img.filter}`)
    ctx.out(`/Length ${ctx.encryptedLength(img.data.length)}`)
    // Adobe CMYK JPEGs carry inverted channel values — flip them back per component
    if (img.decodeInvert) ctx.out('/Decode [1 0 1 0 1 0 1 0]')
    if (smaskObjId) ctx.out(`/SMask ${smaskObjId} 0 R`)
    ctx.out('>>')
    ctx.out('stream')
    ctx.outBytes(img.data)
    ctx.out('endstream')
    ctx.out('endobj')
  }
}

export type Stop5 = [number, number, number, number, number]
type GradGeom = { x: number; y: number; w: number; h: number; pageH: number }

// Stop positions are honored by padding the list to span [0,1] – the 2-stop fast
// path below otherwise ignores them entirely (linear-gradient(#fff 30%, #000 70%)
// ramped across the whole box instead of holding flat until 30%), and lists not
// starting at 0 had the same flat-region problem. Positions are clamped and kept
// strictly increasing so /Bounds stays valid (double-position stops repeat a value).
// Small enough that a million positions are separable, wide enough that the
// 2000-stop ceiling on a repeating gradient fits inside [0,1] with room over.
const BOUND_MIN_GAP = 1e-6
const boundFmt = (n: number): string =>
  (Number.isFinite(n) ? n : 0).toFixed(6).replace(/\.?0+$/, '')

export function normalizeStops(rawStops: Stop5[]): Stop5[] {
  const sp: Stop5[] = rawStops.map(st => [...st] as Stop5)
  let prev = 0
  for (const st of sp) {
    st[0] = Math.max(prev, Math.min(1, Math.max(0, st[0])))
    prev = st[0]
  }
  const head = sp[0]
  if (head && head[0] > 0) sp.unshift([0, head[1], head[2], head[3], head[4]])
  const tail = sp.at(-1)
  if (tail && tail[0] < 1) sp.push([1, tail[1], tail[2], tail[3], tail[4]])
  // Every interior stop has to be strictly greater than the one before it AND
  // still distinguishable once written out, so the separation is driven by the
  // precision /Bounds is formatted at (boundFmt below), not by hpf's three
  // decimals. Three decimals allowed only about a thousand distinct positions,
  // which a repeating gradient can exceed on its own.
  //
  // The ceiling shrinks as the list is walked so each stop leaves room for the
  // ones after it. Clamping every crowded stop to one fixed ceiling was the bug:
  // once a stop reached that value the next was clamped to the same place, or
  // below a neighbor already sitting at 1, and /Bounds came out decreasing.
  const last = sp.length - 1
  for (let k = 1; k < last; k++) {
    const cur = sp[k]!, before = sp[k - 1]!
    const ceiling = 1 - (last - k) * BOUND_MIN_GAP
    const floor   = before[0] + BOUND_MIN_GAP
    cur[0] = Math.min(Math.max(cur[0], floor), ceiling)
  }
  return sp
}

// shared by the color shading (DeviceRGB, picks r/g/b) and the alpha soft-mask
// shading (DeviceGray, picks alpha alone) — same stop list, different component(s)
export function buildFunction(stops: Stop5[], pick: (s: Stop5) => number[]): string {
  const comps = (s: Stop5) => pick(s).map(hpf).join(' ')
  if (stops.length <= 1) {
    const c = comps(stops[0] ?? [0, 0, 0, 0, 0])
    return `/Function << /FunctionType 2 /Domain [0 1] /C0 [${c}] /C1 [${c}] /N 1 >>`
  }
  if (stops.length === 2) {
    const s0 = stops[0]!, s1 = stops[1]!
    return `/Function << /FunctionType 2 /Domain [0 1] /C0 [${comps(s0)}] /C1 [${comps(s1)}] /N 1 >>`
  }
  const n      = stops.length
  const bounds = stops.slice(1, n - 1).map(s => boundFmt(s[0])).join(' ')
  const encode = Array.from({ length: n - 1 }, () => '0 1').join(' ')
  const funcs  = stops.slice(0, n - 1).map((s0, j) => {
    const s1 = stops[j + 1]!
    return `<< /FunctionType 2 /Domain [0 1] /C0 [${comps(s0)}] /C1 [${comps(s1)}] /N 1 >>`
  }).join(' ')
  return `/Function << /FunctionType 3 /Domain [0 1] /Bounds [${bounds}] /Encode [${encode}] /Functions [${funcs}] >>`
}

type Matrix = Affine

// shared by the color shading and the alpha soft-mask shading — both need
// identical /ShadingType + /Coords, only the colorspace/function differ. An ellipse
// is a unit circle in its own space, mapped onto the box by the returned matrix.
function shadingGeometry(def: GradDef, pat: GradGeom): { lines: [string, string]; matrix?: Matrix } {
  const cx  = pat.x + pat.w / 2
  const cyp = pat.pageH - pat.y - pat.h / 2

  if (def.gradType === 0) {
    // CSS angle direction in screen coords is (sin, -cos); PDF's y axis points up,
    // so the vertical component flips to +cos — with -cos, to-bottom gradients invert
    const rad = def.angle * Math.PI / 180
    const dx = Math.sin(rad), dy = Math.cos(rad)
    const hw = pat.w / 2, hh = pat.h / 2
    const projs = [-hw*dx - hh*dy, hw*dx - hh*dy, -hw*dx + hh*dy, hw*dx + hh*dy]
    const tMin  = Math.min(...projs), tMax = Math.max(...projs)
    return { lines: [
      '/ShadingType 2',
      `/Coords [${hpf(cx+tMin*dx)} ${hpf(cyp+tMin*dy)} ${hpf(cx+tMax*dx)} ${hpf(cyp+tMax*dy)}]`,
    ] }
  }
  const gcx  = pat.x + pat.w * def.cx
  const gcyp = pat.pageH - (pat.y + pat.h * def.cy)
  if (def.rx !== undefined && def.ry !== undefined) {
    const rx = Math.max(1e-3, pat.w * def.rx), ry = Math.max(1e-3, pat.h * def.ry)
    // the focal point in the unit circle's own space
    const fu = pat.w * (def.fx - def.cx) / rx
    const fv = -pat.h * (def.fy - def.cy) / ry
    return { lines: ['/ShadingType 3', `/Coords [${hpf(fu)} ${hpf(fv)} 0 0 0 1]`], matrix: [rx, 0, 0, ry, gcx, gcyp] }
  }
  // farthest-corner, the CSS default ending-shape size, measured from the real center
  const dxMax = Math.max(gcx - pat.x, pat.x + pat.w - gcx)
  const dyMax = Math.max((pat.pageH - pat.y) - gcyp, gcyp - (pat.pageH - pat.y - pat.h))
  const r = Math.hypot(dxMax, dyMax)
  // SVG's radial focal point: a true 0-radius inner circle, offset from the
  // outer circle's own center when fx/fy differ from cx/cy (fx/fy default to
  // cx/cy for CSS radial-gradient and any SVG one that doesn't set them,
  // reproducing the same-center behavior exactly)
  const gfx  = pat.x + pat.w * def.fx
  const gfyp = pat.pageH - (pat.y + pat.h * def.fy)
  return { lines: [
    '/ShadingType 3',
    `/Coords [${hpf(gfx)} ${hpf(gfyp)} 0 ${hpf(gcx)} ${hpf(gcyp)} ${hpf(r)}]`,
  ] }
}

const matrixStr = (m: Matrix) => m.map(hpf).join(' ')

export function putShadingPatterns(ctx: InternalCtx): void {
  if (!ctx.shadPats.length) return

  for (const pat of ctx.shadPats) {
    const def = ctx.gradDefs[pat.defIdx]
    if (!def) continue
    const oid = ctx.newObject()
    pat.objId = oid

    const stops = normalizeStops(def.stops)
    const geom  = shadingGeometry(def, pat)

    ctx.out('<<')
    ctx.out('/PatternType 2')
    ctx.out(`/Matrix [${matrixStr(composeAffine(pat.ctm, geom.matrix ?? IDENTITY))}]`)
    ctx.out('/Shading <<')
    ctx.out('/ColorSpace /DeviceRGB')
    ctx.out('/Extend [true true]')
    for (const line of geom.lines) ctx.out(line)
    ctx.out(buildFunction(stops, s => [s[1], s[2], s[3]]))
    ctx.out('>>')
    ctx.out('>>')
    ctx.out('endobj')
  }
}

// Only invoked for gradients with a sub-1-alpha stop (registerSoftMaskIfNeeded
// in pdf_doc/index.ts) — a fully-opaque gradient never reaches here, zero
// extra objects. Builds: an alpha-only DeviceGray shading (identical geometry
// to the color one), a Transparency-group Form XObject that paints it, and
// an ExtGState wiring that Form in as a /Luminosity /SMask. White (gray 1) =
// fully opaque, black (gray 0) = fully transparent, per the SMask convention.
export function putGradientSoftMasks(ctx: InternalCtx): void {
  for (const [i, sm] of ctx.gradSoftMasks.entries()) {
    const def = ctx.gradDefs[sm.defIdx]
    if (!def) continue
    const stops = normalizeStops(def.stops)
    const geom  = shadingGeometry(def, sm)

    const shadingOid = ctx.newObject()
    ctx.out('<<')
    for (const line of geom.lines) ctx.out(line)
    ctx.out('/ColorSpace /DeviceGray')
    ctx.out('/Extend [true true]')
    ctx.out(buildFunction(stops, s => [s[4]]))
    ctx.out('>>')
    ctx.out('endobj')

    const yp = sm.pageH - sm.y - sm.h
    const formOid = ctx.newObject()
    const formBody = _te.encode(geom.matrix ? `q ${matrixStr(geom.matrix)} cm /ShM${i} sh Q` : `/ShM${i} sh`)
    ctx.out('<<')
    ctx.out('/Type /XObject')
    ctx.out('/Subtype /Form')
    ctx.out('/FormType 1')
    ctx.out(`/BBox [${hpf(sm.x)} ${hpf(yp)} ${hpf(sm.x + sm.w)} ${hpf(yp + sm.h)}]`)
    ctx.out('/Group << /Type /Group /S /Transparency /CS /DeviceGray >>')
    ctx.out(`/Resources << /Shading << /ShM${i} ${shadingOid} 0 R >> >>`)
    ctx.out(`/Length ${ctx.encryptedLength(formBody.length)}`)
    ctx.out('>>')
    ctx.out('stream')
    ctx.outBytes(formBody)
    ctx.out('endstream')
    ctx.out('endobj')

    const gsOid = ctx.newObject()
    ctx.out('<<')
    ctx.out('/Type /ExtGState')
    ctx.out(`/SMask << /Type /Mask /S /Luminosity /G ${formOid} 0 R >>`)
    ctx.out('>>')
    ctx.out('endobj')

    sm.objId = gsOid
  }
}

export function putResourceDictionary(ctx: InternalCtx): void {
  ctx.newObjectDeferredBegin(ctx.resourceDictObjId)
  ctx.out('<<')
  ctx.out('/ProcSet [/PDF /Text /ImageB /ImageC /ImageI]')

  ctx.out('/Font <<')
  for (const font of ctx.fonts) {
    if (!ctx.usedFonts.has(font.id)) continue
    if (font.objectNumber > 0) ctx.out(`/${font.id} ${font.objectNumber} 0 R`)
    // A4: the vertical Type0 variant gets its own resource name (Vn suffix) —
    // content streams select it explicitly for vertical text, independent of
    // the horizontal entry above, so both can coexist for the same font
    if (font.usedVertically && font.verticalObjectNumber > 0) {
      ctx.out(`/${font.id}V ${font.verticalObjectNumber} 0 R`)
    }
  }
  ctx.out('>>')

  const colr = ctx.colrRes
  if (ctx.images.length || colr.forms.length) {
    ctx.out('/XObject <<')
    for (const img of ctx.images) ctx.out(`/${img.name} ${img.objectNumber} 0 R`)
    for (const [i, f] of colr.forms.entries()) ctx.out(`/CFm${i} ${f.oid} 0 R`)
    ctx.out('>>')
  }

  if (ctx.shadPats.length) {
    ctx.out('/Pattern <<')
    // object 0 is the free-list head, never a real object – an entry that
    // never got one is skipped rather than written as a dangling "0 0 R"
    for (const p of ctx.shadPats) if (p.objId) ctx.out(`/${p.patName} ${p.objId} 0 R`)
    ctx.out('>>')
  }

  if (ctx.extGStates.length || ctx.gradSoftMasks.length) {
    ctx.out('/ExtGState <<')
    for (const [i, st] of ctx.extGStates.entries()) {
      const v  = hpf(st.alpha)
      ctx.out(`/GS${i} << /Type /ExtGState /ca ${v} /CA ${v} /BM /${st.blend} >>`)
    }
    // the referenced Form XObject (SMask /G) needs no /XObject resource entry —
    // it's addressed directly via its indirect object reference, not looked up
    // by name the way a content-stream "/Im0 Do" operator would need
    for (const sm of ctx.gradSoftMasks) {
      if (sm.objId) ctx.out(`/${sm.gsName} ${sm.objId} 0 R`)
    }
    ctx.out('>>')
  }

  ctx.out('>>')
  ctx.out('endobj')
}

export function packObjStm(ctx: InternalCtx): void {
  if (!ctx.objStmQueue.length) return

  const items   = ctx.objStmQueue.splice(0)
  const hparts: string[] = []
  const bparts: string[] = []
  let boff = 0

  for (const { oid, content } of items) {
    hparts.push(`${oid} ${boff}`)
    boff += content.length + 1
    bparts.push(content)
  }

  const hstr   = hparts.join(' ')
  const body   = `${hstr}\n${bparts.join('\n')}`
  const comp   = deflate(_te.encode(body))
  const stmId  = ctx.newObject()

  ctx.out('<<')
  ctx.out('/Type /ObjStm')
  ctx.out(`/N ${items.length}`)
  ctx.out(`/First ${hstr.length + 1}`)
  ctx.out(`/Length ${ctx.encryptedLength(comp.length)}`)
  ctx.out('/Filter /FlateDecode')
  ctx.out('>>')
  ctx.out('stream')
  ctx.outBytes(comp)
  ctx.out('endstream')
  ctx.out('endobj')

  for (const [qi, it] of items.entries()) {
    ctx.objStmMembers.push([it.oid, stmId, qi])
  }
}
