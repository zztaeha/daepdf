import { PX_PER_PT, domRectToPt, paginateSpan, stackOpacity, stackBlend, type WalkerCtx } from './types.js'
import { paintNode, canvasToPngBytes, fillGradient, fillConic, loadImage } from './canvaspaint.js'
import { parseCSSGradient, parseCSSConicGradient, resolveGradientBox } from './css.js'
import { tileAxes, tilePositions } from './images.js'
import type { ImageCommand } from '../types/index.js'

export function hasMask(s: CSSStyleDeclaration): boolean {
  const v = (s as any).maskImage as string | undefined
  return !!v && v !== 'none'
}

// The mask-image source at the element's pixel size: a gradient as backgrounds paint it, or a
// url() image (same-origin, data or CORS) sized and tiled like a background over the border box
async function paintMaskSource(spec: string, s: CSSStyleDeclaration, wPt: number, hPt: number, cw: number, ch: number): Promise<HTMLCanvasElement | null> {
  const canvas = document.createElement('canvas')
  canvas.width  = cw
  canvas.height = ch
  const c = canvas.getContext('2d')!

  const lin = parseCSSGradient(spec)
  if (lin) {
    fillGradient(c, resolveGradientBox(lin, wPt, hPt), cw, ch)
    return canvas
  }

  const conic = parseCSSConicGradient(spec)
  if (conic) {
    fillConic(c, conic, cw, ch, wPt, hPt)
    return canvas
  }

  const urlM = spec.match(/^url\((['"]?)(.*?)\1\)$/)
  if (urlM) {
    const img = await loadImage(urlM[2]!)
    if (!img) return null
    const prop = (name: string) => String((s as any)[name] || (s as any)[`webkit${name[0]!.toUpperCase()}${name.slice(1)}`] || '')
    const { ax, ay } = tileAxes(prop('maskSize') || 'auto', prop('maskRepeat') || 'repeat', prop('maskPosition') || '0% 0%',
      { x: 0, y: 0, w: wPt, h: hPt }, img.naturalWidth / PX_PER_PT, img.naturalHeight / PX_PER_PT)
    const kx = cw / wPt, ky = ch / hPt
    for (const tx of tilePositions(ax, 0, wPt)) {
      for (const ty of tilePositions(ay, 0, hPt)) c.drawImage(img, tx * kx, ty * ky, ax.size * kx, ay.size * ky)
    }
    return canvas
  }

  return null
}

// mask-image has no PDF operator equivalent — the element is rasterized (see
// canvaspaint.ts, shared with CSS filter), then composited against the mask
// source's ALPHA channel via destination-in. Alpha, not luminance: confirmed
// against the browser's own rendering that the common `linear-gradient(black,
// transparent)` fade-out mask works via alpha — a luminance read would make
// the "black" end fully OPAQUE-but-black instead of fully visible, which is
// not what mask-image does.
export async function emitMaskedElement(el: Element, s: CSSStyleDeclaration, ctx: WalkerCtx): Promise<void> {
  const domRect = el.getBoundingClientRect()
  if (domRect.width < 1 || domRect.height < 1) return
  const { x, y, w, h } = domRectToPt(domRect, ctx.containerRect)

  const dpr = 3
  const cw = Math.max(1, Math.round(domRect.width * dpr))
  const ch = Math.max(1, Math.round(domRect.height * dpr))

  const maskSpec   = (s as any).maskImage as string
  const maskCanvas = await paintMaskSource(maskSpec, s, w, h, cw, ch)
  // an unresolvable source (e.g. a url() that fails to load) leaves the
  // element unrendered rather than guessing — matching how a failed
  // background-image degrades, not a hard error
  if (!maskCanvas) return

  // from the element's own document: paintNode's ctx.font only sees fonts loaded there
  const content = el.ownerDocument.createElement('canvas')
  content.width  = cw
  content.height = ch
  paintNode(el, content.getContext('2d')!, domRect, dpr)

  const finalCanvas  = document.createElement('canvas')
  finalCanvas.width  = cw
  finalCanvas.height = ch
  const fc = finalCanvas.getContext('2d')!
  fc.drawImage(content, 0, 0)
  fc.globalCompositeOperation = 'destination-in'
  fc.drawImage(maskCanvas, 0, 0)

  const src = canvasToPngBytes(finalCanvas)
  if (!src) return

  const opacity = stackOpacity(ctx)
  for (const { page, y: ly } of paginateSpan(y, h, ctx.pageH)) {
    ctx.commands.push({ type: 'image', page, src, format: 'png', x, y: ly, w, h, opacity, blend: stackBlend(ctx) } as ImageCommand)
  }
}
