import type { ImageCommand, RawImageCommand, PathCommand } from '../types/index.js'
import { PX_PER_PT, domRectToPt, paginateSpan, stackOpacity, stackBlend, type WalkerCtx } from './types.js'
import { pxToPt, parseBorderRadius, insetBorderRadius, splitByTopLevelComma, splitPositionPair, parseColorAlpha, parsePositionComponent, resolveLength } from './css.js'
import { sniffFormat, pngNeedsBrowserDecode } from '../images/sniff.js'
import { decodeToRaw, type RawImage } from '../images/decode.js'
import { svgToVectorShapes, type VectorShape } from '../pdf/svgvector.js'
import { templateFontFaces } from './prep.js'
import { canvasToPngBytes } from './canvaspaint.js'

// D5 (SVG as true vectors): pushes one PathCommand per shape, shifting each
// shape's own Y coordinates by `dy` — used by the paginateSpan loops below
// exactly like the raster path shifts its own image y per spanned page,
// letting one vector conversion serve every page it touches without
// re-parsing the source SVG per page.
function pushVectorShapes(ctx: WalkerCtx, page: number, shapes: VectorShape[], dy: number, opacity: number | undefined): void {
  for (const shape of shapes) {
    const ops = dy === 0 ? shape.ops : shape.ops.map(seg => ({
      op: seg.op,
      args: seg.args.map((v, i) => i % 2 === 1 ? v + dy : v),
    }))
    const gradientBox = shape.gradientBox && (dy === 0 ? shape.gradientBox : { ...shape.gradientBox, y: shape.gradientBox.y + dy })
    ctx.commands.push({
      type: 'path', page, ops, evenOdd: shape.evenOdd,
      fill: shape.fill, stroke: shape.stroke, strokeWidth: shape.strokeWidth, dashArray: shape.dashArray,
      lineCap: shape.lineCap, lineJoin: shape.lineJoin,
      gradient: shape.gradient, gradientBox,
      opacity: opacity !== undefined && shape.opacity !== undefined ? opacity * shape.opacity : (opacity ?? shape.opacity),
      blend: stackBlend(ctx),
    } as PathCommand)
  }
}

const _imageCache   = new Map<string, Promise<Uint8Array | null>>()
const _dataUriCache = new Map<string, Uint8Array | null>()

// A length+prefix+suffix sample was tried first, but real EXIF-orientation
// test files proved it collides: two JPEGs differing only in a single EXIF
// byte near the start (e.g. orientation 2 vs 3) can encode to an IDENTICAL
// sampled prefix/suffix, silently reusing the WRONG cached image for a
// completely different picture — confirmed by rendering all 8 orientations
// of the same photo and finding only 3 distinct cache keys among them.
// Two independent full-string hashes (every character, not a sample) close
// this: an accidental collision needs both 32-bit hashes to match on top of
// an exact length match, astronomically unlikely for any realistic document.
function _dataUriKey(uri: string): string {
  let h1 = 5381, h2 = 52711
  for (let i = 0; i < uri.length; i++) {
    const c = uri.charCodeAt(i)
    h1 = (h1 * 33) ^ c
    h2 = (h2 * 31 + c) | 0
  }
  return uri.length + ':' + (h1 >>> 0).toString(36) + ':' + (h2 >>> 0).toString(36)
}

function _fetchImageCached(url: string): Promise<Uint8Array | null> {
  if (!_imageCache.has(url)) {
    const p = fetch(url)
      .then(r => r.ok ? r.arrayBuffer().then(b => new Uint8Array(b)) : null)
      .catch(() => null)
    p.then(result => { if (!result) _imageCache.delete(url) })
    _imageCache.set(url, p)
  }
  return _imageCache.get(url)!
}

type ImageFormat = 'png' | 'jpg' | 'svg'

type ResolvedImage =
  | { kind: 'bytes'; src: Uint8Array; format: ImageFormat }
  | { kind: 'raw'; raw: RawImage }

async function resolveImage(srcUrl: string): Promise<ResolvedImage | null> {
  let src: Uint8Array | null
  let format: ImageFormat = 'png'

  if (srcUrl.startsWith('data:')) {
    const comma = srcUrl.indexOf(',')
    if (comma < 0) return null
    const header = srcUrl.slice(0, comma)
    if (header.includes('svg'))                                  format = 'svg'
    else if (header.includes('jpeg') || header.includes('jpg')) format = 'jpg'
    const duKey = _dataUriKey(srcUrl)
    if (_dataUriCache.has(duKey)) {
      src = _dataUriCache.get(duKey)!
    } else if (header.includes(';base64')) {
      try {
        const bin = atob(srcUrl.slice(comma + 1))
        src = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) src[i] = bin.charCodeAt(i)
      } catch { _dataUriCache.set(duKey, null); return null }
      _dataUriCache.set(duKey, src)
    } else {
      try { src = new TextEncoder().encode(decodeURIComponent(srcUrl.slice(comma + 1))) }
      catch { _dataUriCache.set(duKey, null); return null }
      _dataUriCache.set(duKey, src)
    }
  } else {
    const ext = (srcUrl.split('?')[0] ?? '').split('.').pop()?.toLowerCase()
    if (ext === 'svg')                        format = 'svg'
    else if (ext === 'jpg' || ext === 'jpeg') format = 'jpg'
    src = await _fetchImageCached(srcUrl)
  }

  if (!src) return null

  // exactly 4 officially supported raster formats: JPEG and PNG are parsed
  // natively (DCT passthrough / byte-exact fast path), WebP and AVIF are
  // browser-decoded straight to raw pixels (no PNG re-encode round trip).
  // Everything else (GIF, BMP, ICO, TIFF, ...) is detected and skipped
  // entirely, valid bytes or not — not decoded by anything.
  if (format !== 'svg') {
    const f = sniffFormat(src)
    if (f === 'svg') return { kind: 'bytes', src, format: 'svg' }
    const wasmHandles = f === 'jpeg' || (f === 'png' && !pngNeedsBrowserDecode(src))
    if (!wasmHandles) {
      if (f !== 'png' && f !== 'webp' && f !== 'avif') return null
      const raw = await decodeToRaw(src)
      return raw ? { kind: 'raw', raw } : null
    }
  }

  return { kind: 'bytes', src, format }
}

export function extractBgUrl(layer: string): string | null {
  const m = layer.match(/^url\(["']?([^"')]+)["']?\)$/)
  return m ? m[1] ?? null : null
}

interface ObjectFitRect { x: number; y: number; w: number; h: number; needsClip: boolean }

// object-fit/object-position on <img> weren't read at all — the image was always
// stretched to exactly fill the box, distorting aspect ratio for cover/contain usage.
function computeObjectFitRect(
  fit: string, position: string,
  boxX: number, boxY: number, boxW: number, boxH: number,
  naturalW: number, naturalH: number,
): ObjectFitRect {
  if (fit === 'fill' || !naturalW || !naturalH) {
    return { x: boxX, y: boxY, w: boxW, h: boxH, needsClip: false }
  }

  let drawW: number, drawH: number
  if (fit === 'none') {
    drawW = naturalW; drawH = naturalH
  } else {
    const scaleContain = Math.min(boxW / naturalW, boxH / naturalH)
    const scaleCover   = Math.max(boxW / naturalW, boxH / naturalH)
    const scale = fit === 'cover' ? scaleCover : scaleContain
    drawW = naturalW * scale
    drawH = naturalH * scale
    if (fit === 'scale-down' && naturalW <= drawW && naturalH <= drawH) {
      drawW = naturalW; drawH = naturalH
    }
  }

  const [posXRaw, posYRaw] = splitPositionPair(position || '50% 50%')
  const offX = parsePositionComponent(posXRaw, boxW - drawW)
  const offY = parsePositionComponent(posYRaw, boxH - drawH)

  const eps = 0.01
  const needsClip = drawW > boxW + eps || drawH > boxH + eps
  return { x: boxX + offX, y: boxY + offY, w: drawW, h: drawH, needsClip }
}

export async function emitImage(el: HTMLImageElement, ctx: WalkerCtx): Promise<void> {
  const domRect = el.getBoundingClientRect()
  if (domRect.width < 1 || domRect.height < 1) return

  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)

  const srcUrl = el.currentSrc || el.src || ''
  if (!srcUrl) return

  const img = await resolveImage(srcUrl)
  if (!img) { console.warn(`[daepdf] Could not fetch image: ${srcUrl}`); return }

  const cs = getComputedStyle(el)
  // the image itself lays out in the content box — a bordered/padded <img> must not
  // paint over its own border the way the border-box rect would
  const insL = pxToPt(cs.borderLeftWidth   || '0px') + pxToPt(cs.paddingLeft   || '0px')
  const insT = pxToPt(cs.borderTopWidth    || '0px') + pxToPt(cs.paddingTop    || '0px')
  const insR = pxToPt(cs.borderRightWidth  || '0px') + pxToPt(cs.paddingRight  || '0px')
  const insB = pxToPt(cs.borderBottomWidth || '0px') + pxToPt(cs.paddingBottom || '0px')
  const cbX = x + insL, cbY = y + insT
  const cbW = Math.max(0, w - insL - insR)
  const cbH = Math.max(0, h - insT - insB)
  if (cbW <= 0 || cbH <= 0) return

  const naturalW = (el.naturalWidth  || 0) / PX_PER_PT
  const naturalH = (el.naturalHeight || 0) / PX_PER_PT
  const fit = computeObjectFitRect(cs.objectFit || 'fill', cs.objectPosition, cbX, cbY, cbW, cbH, naturalW, naturalH)

  // an <img> with border-radius (avatars) clips itself — no overflow:hidden involved
  const clipRadius = insetBorderRadius(parseBorderRadius(cs, el), insT, insR, insB, insL)
  const needsClip  = fit.needsClip || !!clipRadius

  const opacity = stackOpacity(ctx)
  const blend   = stackBlend(ctx)

  // D5: an <img src="*.svg"> attempts true-vector conversion first, same
  // fallback contract as emitInlineSVG — a file with an unsupported feature
  // falls through to the untouched raster path below
  let vectorShapes: VectorShape[] | null = null
  if (img.kind === 'bytes' && img.format === 'svg') {
    const svgStr = new TextDecoder().decode(img.src)
    const currentColor = parseColorAlpha(cs.color) ?? [0, 0, 0, 255]
    vectorShapes = svgToVectorShapes(svgStr, fit.x, fit.y, fit.w, fit.h, currentColor)
  }

  // an image taller than one page draws the same full, unscaled placement on every
  // page it touches — each page's MediaBox clips it to the right visible slice
  for (const { page, y: boxLy } of paginateSpan(cbY, cbH, ctx.pageH)) {
    const pageOffset = cbY - boxLy
    const imgLy = fit.y - pageOffset
    if (needsClip) ctx.commands.push({ type: 'clip-push', page, x: cbX, y: boxLy, w: cbW, h: cbH, radius: clipRadius })
    if (vectorShapes) {
      pushVectorShapes(ctx, page, vectorShapes, imgLy - fit.y, opacity)
    } else {
      ctx.commands.push(img.kind === 'raw'
        ? { type: 'raw-image', page, raw: img.raw, x: fit.x, y: imgLy, w: fit.w, h: fit.h, opacity, blend } as RawImageCommand
        : { type: 'image', page, src: img.src, format: img.format, x: fit.x, y: imgLy, w: fit.w, h: fit.h, opacity, blend } as ImageCommand)
    }
    if (needsClip) ctx.commands.push({ type: 'clip-pop', page })
  }
}

// a <canvas> has no src to fetch — snapshot whatever is currently drawn on it,
// laid out in the content box like <img> (borders/padding painted by emitBox)
export function emitCanvas(el: HTMLCanvasElement, ctx: WalkerCtx): void {
  const domRect = el.getBoundingClientRect()
  if (domRect.width < 1 || domRect.height < 1) return
  if (!el.width || !el.height) return

  const src = canvasToPngBytes(el)
  if (!src) return

  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)
  const cs   = getComputedStyle(el)
  const insL = pxToPt(cs.borderLeftWidth   || '0px') + pxToPt(cs.paddingLeft   || '0px')
  const insT = pxToPt(cs.borderTopWidth    || '0px') + pxToPt(cs.paddingTop    || '0px')
  const insR = pxToPt(cs.borderRightWidth  || '0px') + pxToPt(cs.paddingRight  || '0px')
  const insB = pxToPt(cs.borderBottomWidth || '0px') + pxToPt(cs.paddingBottom || '0px')
  const cbX = x + insL, cbY = y + insT
  const cbW = Math.max(0, w - insL - insR)
  const cbH = Math.max(0, h - insT - insB)
  if (cbW <= 0 || cbH <= 0) return

  const clipRadius = insetBorderRadius(parseBorderRadius(cs, el), insT, insR, insB, insL)
  const opacity = stackOpacity(ctx)
  for (const { page, y: ly } of paginateSpan(cbY, cbH, ctx.pageH)) {
    if (clipRadius) ctx.commands.push({ type: 'clip-push', page, x: cbX, y: ly, w: cbW, h: cbH, radius: clipRadius })
    ctx.commands.push({
      type: 'image', page, src, format: 'png',
      x: cbX, y: ly, w: cbW, h: cbH,
      opacity, blend: stackBlend(ctx),
    } as ImageCommand)
    if (clipRadius) ctx.commands.push({ type: 'clip-pop', page })
  }
}

const PAINT_PROPS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'opacity', 'visibility', 'display',
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
]

const _fontDataUrls = new Map<string, Promise<string | null>>()

function fontDataUrl(url: string): Promise<string | null> {
  let hit = _fontDataUrls.get(url)
  if (!hit) {
    hit = fetch(url).then(r => r.ok ? r.arrayBuffer() : null).then(buf => {
      if (!buf) return null
      const bytes = new Uint8Array(buf)
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return `data:application/octet-stream;base64,${btoa(bin)}`
    }).catch(() => null)
    _fontDataUrls.set(url, hit)
  }
  return hit
}

// @font-face rules for the template fonts an SVG's text uses, their files inlined: an SVG
// drawn as an image loads nothing, so its text would otherwise fall back to the default font
async function svgFontFaces(svg: SVGSVGElement): Promise<string> {
  const families = new Set<string>()
  for (const t of Array.from(svg.querySelectorAll('text, tspan, textPath'))) {
    for (const f of getComputedStyle(t).fontFamily.split(',')) families.add(f.trim().replace(/^["']|["']$/g, ''))
  }
  const blocks = [...families].flatMap(templateFontFaces)
  const inlined = await Promise.all(blocks.map(async block => {
    let out = block
    for (const m of block.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
      const data = await fontDataUrl(m[2]!)
      if (data) out = out.replace(m[0], `url(${data})`)
    }
    return out
  }))
  return inlined.join('\n')
}

// Serializing drops stylesheet rules, so computed paint is written back as attributes. Inside
// <defs>/<symbol> only stop colors are: a <use> instance inherits from the <use> instead.
function bakeComputedPaint(live: Element, clone: Element): void {
  if (live.tagName === 'defs' || live.tagName === 'symbol') {
    const stops = live.querySelectorAll('stop'), cloneStops = clone.querySelectorAll('stop')
    stops.forEach((stop, i) => {
      const cs = getComputedStyle(stop), target = cloneStops[i]
      target?.setAttribute('stop-color', cs.getPropertyValue('stop-color'))
      target?.setAttribute('stop-opacity', cs.getPropertyValue('stop-opacity'))
      ;(target as SVGElement | undefined)?.style.removeProperty('stop-color')
      ;(target as SVGElement | undefined)?.style.removeProperty('stop-opacity')
    })
    return
  }
  const cs = getComputedStyle(live)
  for (const prop of PAINT_PROPS) {
    const v = cs.getPropertyValue(prop)
    // a gradient reference keeps its authored form, which the vector path resolves itself
    if (!v || ((prop === 'fill' || prop === 'stroke') && v.startsWith('url('))) continue
    clone.setAttribute(prop, v)
    ;(clone as SVGElement).style.removeProperty(prop)
  }
  for (let i = 0; i < live.children.length; i++) {
    const c = clone.children[i]
    if (c) bakeComputedPaint(live.children[i]!, c)
  }
}

export async function emitInlineSVG(el: SVGSVGElement, ctx: WalkerCtx): Promise<void> {
  const domRect = el.getBoundingClientRect()
  if (domRect.width < 1 || domRect.height < 1) return

  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)

  // serialization drops inherited CSS — a fill="currentColor" icon would rasterize
  // with the initial color (black) instead of the color it inherits in the page, so
  // bake the inherited values onto the root; explicit dimensions keep %-sized or
  // attribute-less SVGs rendering at their laid-out size instead of the 300x150 default
  const cs    = getComputedStyle(el)
  const clone = el.cloneNode(true) as SVGSVGElement
  bakeComputedPaint(el, clone)
  // the svg's own opacity is already on the walker's opacity stack
  clone.removeAttribute('opacity')
  clone.style.color      = cs.color
  clone.style.fontFamily = cs.fontFamily
  clone.style.fontSize   = cs.fontSize
  clone.setAttribute('width',  String(domRect.width))
  clone.setAttribute('height', String(domRect.height))
  const faces = await svgFontFaces(el)
  if (faces) {
    const style = clone.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style')
    style.textContent = faces
    clone.insertBefore(style, clone.firstChild)
  }
  const svgStr = new XMLSerializer().serializeToString(clone)
  const opacity = stackOpacity(ctx)

  // D5: try a true-vector conversion first — falls back to the untouched
  // raster path below on any unsupported feature (filters/masks/patterns/
  // clip-paths/text/nested rasters/<style> blocks), never a partial convert
  const currentColor = parseColorAlpha(cs.color) ?? [0, 0, 0, 255]
  const shapes = svgToVectorShapes(svgStr, x, y, w, h, currentColor)
  if (shapes) {
    for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
      pushVectorShapes(ctx, page, shapes, ly - y, opacity)
    }
    return
  }

  const src = new TextEncoder().encode(svgStr)
  for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
    ctx.commands.push({
      type: 'image', page, src, format: 'svg',
      x, y: ly, w, h,
      opacity, blend: stackBlend(ctx),
    } as ImageCommand)
  }
}

const _naturalSizeCache = new Map<Uint8Array, Promise<{ w: number; h: number } | null>>()

async function getNaturalSize(bytes: Uint8Array): Promise<{ w: number; h: number } | null> {
  if (_naturalSizeCache.has(bytes)) return _naturalSizeCache.get(bytes)!
  const p = createImageBitmap(new Blob([bytes as unknown as ArrayBuffer]))
    .then(bmp => { const size = { w: bmp.width, h: bmp.height }; bmp.close(); return size })
    .catch(() => null)
  _naturalSizeCache.set(bytes, p)
  return p
}

function nthCyclic(list: string[], i: number): string {
  return list[i % list.length]?.trim() ?? ''
}

function parseBgSize(
  sizeStr: string, boxW: number, boxH: number, naturalW: number, naturalH: number,
): { tileW: number; tileH: number } {
  const val = sizeStr || 'auto'
  if (val === 'cover' || val === 'contain') {
    if (!naturalW || !naturalH) return { tileW: boxW, tileH: boxH }
    const scale = val === 'cover'
      ? Math.max(boxW / naturalW, boxH / naturalH)
      : Math.min(boxW / naturalW, boxH / naturalH)
    return { tileW: naturalW * scale, tileH: naturalH * scale }
  }

  const parseComponent = (v: string | undefined, ref: number): number | null =>
    !v || v === 'auto' ? null : resolveLength(v, ref)

  const [wRaw, hRaw] = splitPositionPair(val)
  let tw = parseComponent(wRaw, boxW)
  let th = parseComponent(hRaw, boxH)

  if (tw === null && th === null)      { tw = naturalW || boxW; th = naturalH || boxH }
  else if (tw === null && th !== null) { tw = naturalW && naturalH ? (naturalW / naturalH) * th : boxW }
  else if (th === null && tw !== null) { th = naturalW && naturalH ? (naturalH / naturalW) * tw : boxH }

  return { tileW: tw ?? boxW, tileH: th ?? boxH }
}

type RepeatMode = 'repeat' | 'no-repeat' | 'round' | 'space'

function parseBgRepeat(repeatStr: string): { x: RepeatMode; y: RepeatMode } {
  const parts = (repeatStr || 'repeat').trim().split(/\s+/) as RepeatMode[]
  const v = parts[0] as string
  if (parts.length > 1) return { x: parts[0]!, y: parts[1]! }
  if (v === 'repeat-x') return { x: 'repeat', y: 'no-repeat' }
  if (v === 'repeat-y') return { x: 'no-repeat', y: 'repeat' }
  return { x: parts[0]!, y: parts[0]! }
}

// One axis of a background's tiling (CSS Backgrounds 3): round fits a whole number of tiles
// into the origin box; space spreads whole ones edge to edge, or doesn't repeat if under two fit.
function tileAxis(mode: RepeatMode, tile: number, start: number, len: number, pos: string | undefined): { size: number; step: number; ref: number; repeat: boolean } {
  if (mode === 'space' && tile > 0.01) {
    const count = Math.floor(len / tile)
    if (count >= 2) return { size: tile, step: tile + (len - count * tile) / (count - 1), ref: start, repeat: true }
    mode = 'no-repeat'
  }
  const size = mode === 'round' && tile > 0.01 ? len / Math.max(1, Math.round(len / tile)) : tile
  return { size, step: size, ref: start + parsePositionComponent(pos, len - size), repeat: mode !== 'no-repeat' }
}

// Both axes of a background (or mask) laid over `origin`: size, repeat and position resolved
export function tileAxes(
  sizeStr: string, repeatStr: string, positionStr: string,
  origin: { x: number; y: number; w: number; h: number }, naturalW: number, naturalH: number,
): { ax: ReturnType<typeof tileAxis>; ay: ReturnType<typeof tileAxis> } {
  const sized = parseBgSize(sizeStr, origin.w, origin.h, naturalW, naturalH)
  const modes = parseBgRepeat(repeatStr)
  const [posX, posY] = splitPositionPair(positionStr)
  const ax = tileAxis(modes.x, sized.tileW, origin.x, origin.w, posX)
  const ay = tileAxis(modes.y, sized.tileH, origin.y, origin.h, posY)
  // round on one axis with an auto size on the other keeps the image's aspect ratio
  const [sizeW = 'auto', sizeH = 'auto'] = /cover|contain/.test(sizeStr) ? [] : splitPositionPair(sizeStr)
  if (modes.x === 'round' && modes.y !== 'round' && sizeH === 'auto' && sized.tileW > 0.01) {
    ay.size = ay.step = sized.tileH * ax.size / sized.tileW
    ay.ref = origin.y + parsePositionComponent(posY, origin.h - ay.size)
  } else if (modes.y === 'round' && modes.x !== 'round' && sizeW === 'auto' && sized.tileH > 0.01) {
    ax.size = ax.step = sized.tileW * ay.size / sized.tileH
    ax.ref = origin.x + parsePositionComponent(posX, origin.w - ax.size)
  }
  return { ax, ay }
}

const MAX_BG_TILES = 500

// Where one axis's tiles start, covering [from, to): just the anchor when it doesn't repeat
export function tilePositions(a: ReturnType<typeof tileAxis>, from: number, to: number): number[] {
  if (a.size <= 0.01 || !a.repeat) return [a.ref]
  const out: number[] = []
  for (let t = a.ref - Math.ceil((a.ref - from) / a.step) * a.step; t < to && out.length < MAX_BG_TILES; t += a.step) out.push(t)
  return out
}

export interface BgImage { img: ResolvedImage; natural: { w: number; h: number } | null }

// Fetched up front, by layer index, so emitBox can paint each url() layer in its own slot:
// above the background color and the layers below it, under the border.
export async function resolveBgImages(s: CSSStyleDeclaration): Promise<Map<number, BgImage> | undefined> {
  if (!s.backgroundImage || s.backgroundImage === 'none') return undefined
  const out = new Map<number, BgImage>()
  await Promise.all(splitByTopLevelComma(s.backgroundImage).map(async (layer, i) => {
    const url = extractBgUrl(layer.trim())
    if (!url) return
    const img = await resolveImage(url)
    if (!img) { console.warn(`[daepdf] Could not resolve background-image: ${url}`); return }
    const natural = img.kind === 'raw'
      ? { w: img.raw.width, h: img.raw.height }
      : img.format === 'svg' ? null : await getNaturalSize(img.src)
    out.set(i, { img, natural })
  }))
  return out.size ? out : undefined
}

// onlyPage: emitBox paints a box page by page, so each page gets its own slice in order
export function emitBgImage(
  el: Element, bg: BgImage, ctx: WalkerCtx, layerIndex: number, layerCount: number, onlyPage: number,
): void {
  const domRect = el.getBoundingClientRect()
  if (domRect.width < 1 || domRect.height < 1) return

  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)
  const { img, natural } = bg

  const cs = getComputedStyle(el)
  const pick = (list: string[], fallback: string) =>
    (layerCount > 1 ? nthCyclic(list, layerIndex) : list[0]?.trim() ?? fallback) || fallback
  // top-level split only — min()/clamp()/calc() values carry their own commas
  const sizeStr     = pick(splitByTopLevelComma(cs.backgroundSize     || 'auto'),        'auto')
  const positionStr = pick(splitByTopLevelComma(cs.backgroundPosition || '0% 0%'),       '0% 0%')
  const repeatStr   = pick(splitByTopLevelComma(cs.backgroundRepeat   || 'repeat'),      'repeat')
  const originStr   = pick(splitByTopLevelComma(cs.backgroundOrigin   || 'padding-box'), 'padding-box')
  const clipStr     = pick(splitByTopLevelComma(cs.backgroundClip     || 'border-box'),  'border-box')
  // paged-media 'fixed': the background anchors to each PAGE box rather than the
  // element, repeating at the same page-local position on every page it spans —
  // the print equivalent of a viewport-fixed background
  const fixed       = pick(splitByTopLevelComma(cs.backgroundAttachment || 'scroll'), 'scroll') === 'fixed'
  // an image clipped to glyph outlines can't be reproduced — skipping it beats
  // pasting the full rectangle over the text (captureTextNode keeps the text readable)
  if (clipStr === 'text') return

  // position and size resolve against the background-origin box (default padding-box),
  // painting is confined to the background-clip box (default border-box) — using the
  // border box for both shifts the image by the border width on bordered elements
  const bT = pxToPt(cs.borderTopWidth  || '0px'), bR = pxToPt(cs.borderRightWidth  || '0px')
  const bB = pxToPt(cs.borderBottomWidth || '0px'), bL = pxToPt(cs.borderLeftWidth || '0px')
  const pT = pxToPt(cs.paddingTop  || '0px'), pR = pxToPt(cs.paddingRight  || '0px')
  const pB = pxToPt(cs.paddingBottom || '0px'), pL = pxToPt(cs.paddingLeft || '0px')
  const boxFor = (kind: string) => {
    if (kind === 'border-box')  return { x, y, w, h }
    if (kind === 'content-box') return {
      x: x + bL + pL, y: y + bT + pT,
      w: Math.max(0, w - bL - bR - pL - pR), h: Math.max(0, h - bT - bB - pT - pB),
    }
    return { x: x + bL, y: y + bT, w: Math.max(0, w - bL - bR), h: Math.max(0, h - bT - bB) }
  }
  // fixed: position/size resolve against the page box; tiles land at page-local
  // coordinates directly (identical on every page), so origin.y starts at 0
  const origin = fixed ? { x: 0, y: 0, w: ctx.pageW, h: ctx.pageH } : boxFor(originStr)
  const clip   = boxFor(clipStr)
  if (clip.w <= 0 || clip.h <= 0) return

  const naturalW = (natural?.w ?? 0) / PX_PER_PT
  const naturalH = (natural?.h ?? 0) / PX_PER_PT

  const { ax, ay } = tileAxes(sizeStr, repeatStr, positionStr, origin, naturalW, naturalH)
  const tileW = ax.size, tileH = ay.size

  // repeat coverage: the element's clip box for scroll, the whole page for fixed
  const coverX0 = fixed ? 0 : clip.x, coverX1 = fixed ? ctx.pageW : clip.x + clip.w
  const coverY0 = fixed ? 0 : clip.y, coverY1 = fixed ? ctx.pageH : clip.y + clip.h

  const tileXs = tilePositions(ax, coverX0, coverX1)
  const tileYs = tilePositions(ay, coverY0, coverY1)

  // MAX_BG_TILES bounds each axis independently, but the draw loop below is
  // the full cartesian product of tileXs × tileYs — a background tiny on
  // BOTH axes at once (e.g. background-size:0.3px 0.3px) hits 500 on each
  // axis independently, multiplying to up to 250,000 draws, not 500.
  // Confirmed via a real combined render producing 100,000+ ImageCommands
  // from a single background-image. Scaling both axes down proportionally
  // keeps the tiling itself visually uniform (same aspect ratio of gaps)
  // rather than truncating one axis to 1 while leaving the other at 500.
  const MAX_BG_TILE_PRODUCT = 2000
  if (tileXs.length * tileYs.length > MAX_BG_TILE_PRODUCT) {
    const scale = Math.sqrt(MAX_BG_TILE_PRODUCT / (tileXs.length * tileYs.length))
    tileXs.length = Math.max(1, Math.floor(tileXs.length * scale))
    tileYs.length = Math.max(1, Math.floor(tileYs.length * scale))
  }

  // the element's own border-radius clips its background — reduce the radius by
  // whatever insets separate the border box from the background-clip box
  const clipRadius = insetBorderRadius(
    parseBorderRadius(cs, el),
    clipStr === 'border-box' ? 0 : clipStr === 'content-box' ? bT + pT : bT,
    clipStr === 'border-box' ? 0 : clipStr === 'content-box' ? bR + pR : bR,
    clipStr === 'border-box' ? 0 : clipStr === 'content-box' ? bB + pB : bB,
    clipStr === 'border-box' ? 0 : clipStr === 'content-box' ? bL + pL : bL,
  )

  const opacity = stackOpacity(ctx)
  const blend   = stackBlend(ctx)
  const needsClip = ax.repeat || ay.repeat || tileW !== clip.w || tileH !== clip.h || !!clipRadius

  for (const { page, y: boxLy } of paginateSpan(clip.y, clip.h, ctx.pageH)) {
    if (page !== onlyPage) continue
    // fixed: tileYs were built page-local (against [0, pageH]) — the SAME set
    // draws identically on every page, no per-page offset to reconcile.
    // scroll: tileYs are global, so pageOffset re-bases each tile to this
    // page's own local frame (boxLy is where global clip.y lands here).
    const pageOffset = fixed ? 0 : clip.y - boxLy
    const yLo = fixed ? boxLy : clip.y, yHi = fixed ? boxLy + clip.h : clip.y + clip.h
    if (needsClip) ctx.commands.push({ type: 'clip-push', page, x: clip.x, y: boxLy, w: clip.w, h: clip.h, radius: clipRadius })
    for (const tx of tileXs) {
      if (tx + tileW < clip.x || tx > clip.x + clip.w) continue
      for (const ty of tileYs) {
        if (ty + tileH < yLo || ty > yHi) continue
        ctx.commands.push(img.kind === 'raw'
          ? { type: 'raw-image', page, raw: img.raw, x: tx, y: ty - pageOffset, w: tileW, h: tileH, opacity, blend } as RawImageCommand
          : { type: 'image', page, src: img.src, format: img.format, x: tx, y: ty - pageOffset, w: tileW, h: tileH, opacity, blend } as ImageCommand)
      }
    }
    if (needsClip) ctx.commands.push({ type: 'clip-pop', page })
  }
}
