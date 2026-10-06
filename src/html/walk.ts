import type { DrawCommand, BorderRadius } from '../types/index.js'
import {
  domRectToPt, paginateSpan, cssBlendToPdf, PX_PER_PT, type WalkerCtx, type StackLayer,
  enterStruct, enterStructTag, exitStruct, tagStructContent,
} from './types.js'
import { parseBorderRadius, insetBorderRadius, pxToPt } from './css.js'
import { parseClipPath } from './clippath.js'
import { applyCounters, applyListItemCounter, popCounters, resolveContentList } from './counters.js'
import { hasBorderImage, emitBorderImage } from './borderimage.js'
import { parseCSSMatrix } from './transform.js'
import { hasFilter, emitFilteredElement } from './filters.js'
import { hasMask, emitMaskedElement } from './mask.js'
import { emitBox, emitListMarker, captureTextNode, captureVerticalTextNode, emitLinks, emitFormField, captureAnchor, listIndex } from './emit.js'
import { emitImage, emitInlineSVG, emitCanvas, resolveBgImages } from './images.js'

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'HEAD', 'TITLE', 'TEMPLATE'])

// A4: dispatches to the vertical-writing-mode text capture instead of the
// normal horizontal one when the parent block is actually set vertically
function captureAnyTextNode(node: Text, parent: Element, parentStyle: CSSStyleDeclaration, ctx: WalkerCtx): void {
  if (parentStyle.writingMode === 'vertical-rl' || parentStyle.writingMode === 'vertical-lr') {
    captureVerticalTextNode(node, parentStyle, ctx)
  } else {
    captureTextNode(node, parent, parentStyle, ctx)
  }
}

// D3: tags freshly emitted content (one command per page a run spans, or one per word on a
// bidi/justify path) to the innermost structure element; the rest is marked as artifacts
const TEXT_CONTENT:   ReadonlySet<DrawCommand['type']> = new Set(['text'])
const FIGURE_CONTENT: ReadonlySet<DrawCommand['type']> = new Set(['image', 'raw-image', 'path'])
const MARKER_CONTENT: ReadonlySet<DrawCommand['type']> = new Set(['text', 'path'])

function tagContent(ctx: WalkerCtx, cmds: DrawCommand[], types: ReadonlySet<DrawCommand['type']>): void {
  if (!ctx.struct) return
  for (const cmd of cmds) {
    if (!types.has(cmd.type)) continue
    const tagged = tagStructContent(ctx, cmd.page)
    if (tagged) Object.assign(cmd, { mcid: tagged.mcid, structTag: tagged.tag })
  }
}

// A child is only naturally inset from its parent's border by the border's width, not
// its curvature — a plain square-cornered child clipped to the parent's outer (border-box)
// curve still reaches into the ring the border itself occupies near the corner, painting
// over part of it (children paint after their parent, correct order everywhere except this
// gap). Real browsers clip descendant content to the padding-box: the border-box rect
// inset by the border width on every side, AND its radius reduced by that same amount —
// not just a smaller radius on the original rect, which is a different curve entirely
// (confirmed by the first attempt at this fix: matching the radius alone didn't fix it,
// because the curve's underlying rect was still the outer one).
function paddingBoxClip(
  x: number, y: number, w: number, h: number,
  radius: BorderRadius | undefined, s: CSSStyleDeclaration,
): { x: number; y: number; w: number; h: number; radius: BorderRadius | undefined } {
  const top    = pxToPt(s.borderTopWidth    || '0px')
  const right  = pxToPt(s.borderRightWidth  || '0px')
  const bottom = pxToPt(s.borderBottomWidth || '0px')
  const left   = pxToPt(s.borderLeftWidth   || '0px')
  if (!top && !right && !bottom && !left) return { x, y, w, h, radius }

  return {
    x: x + left, y: y + top,
    w: Math.max(0, w - left - right), h: Math.max(0, h - top - bottom),
    radius: insetBorderRadius(radius, top, right, bottom, left),
  }
}

export async function walkChildren(
  parent:      Element,
  parentStyle: CSSStyleDeclaration,
  ctx:         WalkerCtx,
): Promise<void> {
  // counters a child resets stay in scope for its FOLLOWING SIBLINGS — they
  // pop when this parent finishes its children, not when the child exits
  const childCounters: string[] = []
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const startIdx = ctx.commands.length
      captureAnyTextNode(child as Text, parent, parentStyle, ctx)
      tagContent(ctx, ctx.commands.slice(startIdx), TEXT_CONTENT)
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      ctx.siblingCounters = childCounters
      childCounters.push(...await walkChild(child as Element, parentStyle, ctx))
    }
  }
  popCounters(ctx.counters, childCounters)
}

// Positioned elements, and flex or grid items with a z-index, paint in a layer of the
// enclosing stacking context rather than in place; null means normal flow
function paintLayerZ(el: Element, parentStyle: CSSStyleDeclaration): number | null {
  const s = getComputedStyle(el)
  const z = parseInt(s.zIndex, 10)
  if (!isNaN(z) && (s.position !== 'static' || /flex|grid/.test(parentStyle.display))) return z
  return s.position !== 'static' ? 0 : null
}

// The layer is registered before the walk, so layers keep tree order within a z
async function walkChild(el: Element, parentStyle: CSSStyleDeclaration, ctx: WalkerCtx): Promise<string[]> {
  const z = ctx.stacking ? paintLayerZ(el, parentStyle) : null
  if (z === null) return walkElement(el, ctx)
  const layer: StackLayer = { z, commands: [] }
  ctx.stacking!.push(layer)
  return walkElement(el, { ...ctx, commands: layer.commands, opacityStack: [...ctx.opacityStack], blendStack: [...ctx.blendStack] })
}

function isStackingContext(el: Element, s: CSSStyleDeclaration): boolean {
  if (s.zIndex !== 'auto' && (s.position !== 'static' || /flex|grid/.test(getComputedStyle(el.parentElement ?? el).display))) return true
  const any = s as any
  return s.position === 'fixed' || s.position === 'sticky' || parseFloat(s.opacity) < 1 || s.transform !== 'none' ||
    s.mixBlendMode !== 'normal' || s.isolation === 'isolate' || (any.clipPath ?? 'none') !== 'none' ||
    s.perspective !== 'none' || (any.backdropFilter ?? 'none') !== 'none' || /layout|paint|strict|content/.test(s.contain) ||
    /transform|opacity|perspective|isolation|mix-blend-mode|clip-path|mask|filter/.test(s.willChange)
}

// CSS painting order (simplified Appendix E): negative z layers, then the normal flow, then
// positioned layers by z, ties in tree order. Layers come from any depth below the context.
export async function paintStackingContext(ctx: WalkerCtx, paint: () => Promise<void>): Promise<void> {
  const outer = ctx.stacking
  const layers: StackLayer[] = []
  ctx.stacking = layers
  const at = ctx.commands.length
  try {
    await paint()
  } finally {
    ctx.stacking = outer
  }
  if (!layers.length) return
  layers.sort((a, b) => a.z - b.z)
  const flow = ctx.commands.splice(at)
  for (const layer of layers) if (layer.z < 0) for (const c of layer.commands) ctx.commands.push(c)
  for (const c of flow) ctx.commands.push(c)
  for (const layer of layers) if (layer.z >= 0) for (const c of layer.commands) ctx.commands.push(c)
}

// returns the counter names this element's own reset/set/increment pushed —
// they stay alive for following siblings, so the parent pops them, not us
async function walkElement(el: Element, ctx: WalkerCtx): Promise<string[]> {
  const tag = el.tagName.toUpperCase()
  if (SKIP_TAGS.has(tag)) return []

  const s = getComputedStyle(el)
  // display:none elements neither render nor affect counters, per spec
  if (s.display === 'none') return []

  // D3: pushed/popped around the WHOLE dispatch below (not threaded through
  // each individual branch's own early returns) so every exit path — filter,
  // mask, SVG, IMG, CANVAS, the normal body — stays balanced automatically
  const structEntry = enterStruct(el, tag, ctx)
  try {
    // Paged-media semantics (repeats per page box), not continuous-scroll
    // "pinned to viewport" semantics — see captureFixedElement below. Only
    // when ctx.fixedElements is opted in (chrome.ts's own header/footer
    // captures don't set it, so a nested position:fixed there just falls
    // through to normal handling — already inherently single-instance).
    if (s.position === 'fixed' && ctx.fixedElements) {
      return await captureFixedElement(el, tag, s, ctx)
    }

    // CSS transforms: capture this element's entire subtree (box + children) in
    // UNTRANSFORMED layout space into an isolated command list, then wrap the
    // whole thing with a PDF `cm` matrix — see captureTransformedElement for why.
    if (s.transform && s.transform !== 'none') {
      return await captureTransformedElement(el, tag, s, ctx)
    }

    return await walkElementBody(el, tag, s, ctx)
  } finally {
    exitStruct(ctx, structEntry)
  }
}

// Captured once here, in its real DOM position (so inherited styles/cascading
// stay exactly correct — no re-parsing or cloning into an isolated fragment
// needed), same isolated-subCtx pattern as captureTransformedElement. index.ts's
// fromDOM replicates these commands across every real page once pageCount is
// known — this function only captures the ONE natural instance and defers.
async function captureFixedElement(el: Element, tag: string, s: CSSStyleDeclaration, ctx: WalkerCtx): Promise<string[]> {
  const subCtx: WalkerCtx = { ...ctx, commands: [], opacityStack: [...ctx.opacityStack], blendStack: [...ctx.blendStack] }
  const counters = (s.transform && s.transform !== 'none')
    ? await captureTransformedElement(el, tag, s, subCtx)
    : await walkElementBody(el, tag, s, subCtx)
  ctx.fixedElements!.push(subCtx.commands)
  return counters
}

// Neutralizes the element's transform, measures its TRUE (untransformed) box
// position — CSS transforms never affect layout, only paint, so nothing else
// on the page shifts as a result — captures the subtree exactly as
// walkElementBody normally would (into an isolated subCtx, mirroring the
// z-sort layering pattern in walkChildren), restores the transform, then
// wraps the captured commands with a `cm` matrix equivalent to the CSS one.
async function captureTransformedElement(
  el: Element, tag: string, s: CSSStyleDeclaration, ctx: WalkerCtx,
): Promise<string[]> {
  const rawMatrix = parseCSSMatrix(s.transform)
  // matrix3d (3D transforms) has no 2D equivalent to fall back to safely —
  // render untransformed rather than risk a wrong projection
  if (!rawMatrix) {
    console.warn('[daepdf] 3D transforms (matrix3d/perspective) are not supported – element rendered untransformed.')
    return walkElementBody(el, tag, s, ctx)
  }
  // a,b,c,d are unitless ratios (unaffected by the px/pt scale), but e,f are the
  // matrix's translation and come out of getComputedStyle in CSS px like every
  // other length here — only these two need the pt conversion
  const cssMatrix: typeof rawMatrix = [
    rawMatrix[0], rawMatrix[1], rawMatrix[2], rawMatrix[3],
    rawMatrix[4] / PX_PER_PT, rawMatrix[5] / PX_PER_PT,
  ]

  // transform-origin always resolves to absolute "Npx Mpx" (a possible 3rd
  // z-value is irrelevant for a 2D matrix); read before the override below
  const [oxStr, oyStr] = s.transformOrigin.split(/\s+/)
  const htmlEl = el as HTMLElement
  const savedInline = htmlEl.style.transform
  htmlEl.style.transform = 'none'
  const subCtx: WalkerCtx = { ...ctx, commands: [], opacityStack: [...ctx.opacityStack], blendStack: [...ctx.blendStack] }
  let originX: number, originY: number, counters: string[]
  try {
    const { x: boxX, y: boxY } = domRectToPt(el.getBoundingClientRect(), ctx.containerRect)
    originX = boxX + (parseFloat(oxStr ?? '') || 0) / PX_PER_PT
    originY = boxY + (parseFloat(oyStr ?? '') || 0) / PX_PER_PT
    counters = await walkElementBody(el, tag, s, subCtx, true)
  } finally {
    // fromDOM may be walking the caller's live element
    htmlEl.style.transform = savedInline
  }

  // annotations sit outside the content stream, where the cm below never reaches them,
  // so their boxes go through the CSS matrix here (as the bounding box of the result)
  const [ma, mb, mc, md, me, mf] = cssMatrix
  for (const cmd of subCtx.commands) {
    if (cmd.type !== 'link' && cmd.type !== 'field') continue
    const off = (cmd.page - 1) * ctx.pageH
    const xs: number[] = [], ys: number[] = []
    for (const [px, py] of [[cmd.x, cmd.y], [cmd.x + cmd.w, cmd.y], [cmd.x, cmd.y + cmd.h], [cmd.x + cmd.w, cmd.y + cmd.h]] as const) {
      const dx = px - originX, dy = py + off - originY
      xs.push(originX + ma * dx + mc * dy + me)
      ys.push(originY + mb * dx + md * dy + mf - off)
    }
    cmd.x = Math.min(...xs); cmd.w = Math.max(...xs) - cmd.x
    cmd.y = Math.min(...ys); cmd.h = Math.max(...ys) - cmd.y
  }

  // mirrors clip-push/pop's own multi-page pattern: each page this subtree's
  // commands touch gets its own push/pop pair, routed into that page's own
  // buffer independently of where they fall in the flat command array. Each
  // page's content is in that page's coordinates, so the pivot is too.
  const pages = [...new Set(subCtx.commands.map(c => c.page))].sort((a, b) => a - b)
  for (const page of pages) {
    ctx.commands.push({ type: 'transform-push', page, css: cssMatrix, origin: [originX, originY - (page - 1) * ctx.pageH] })
  }
  for (const cmd of subCtx.commands) ctx.commands.push(cmd)
  for (const page of pages) ctx.commands.push({ type: 'transform-pop', page })

  return counters
}

// ownContext: the caller knows el is a stacking context even if s no longer shows it
async function walkElementBody(el: Element, tag: string, s: CSSStyleDeclaration, ctx: WalkerCtx, ownContext = false): Promise<string[]> {
  // visibility:hidden suppresses only this element's own painting — a descendant with
  // visibility:visible still renders, so the subtree must still be walked
  const hiddenSelf = s.visibility === 'hidden' || s.visibility === 'collapse'

  const siblings = ctx.siblingCounters ?? []
  const ownCounters = applyCounters(ctx.counters, s, siblings)
  ownCounters.push(...applyListItemCounter(ctx.counters, el, s, () => listIndex(el), siblings))

  captureAnchor(el, ctx)

  const elOpacity    = parseFloat(s.opacity)
  const hasOwnOpacity = !isNaN(elOpacity) && elOpacity < 1
  if (hasOwnOpacity) ctx.opacityStack.push(elOpacity)
  const ownBlend = cssBlendToPdf(s.mixBlendMode)
  if (ownBlend) ctx.blendStack.push(ownBlend)
  const popStacks = () => {
    if (hasOwnOpacity) ctx.opacityStack.pop()
    if (ownBlend) ctx.blendStack.pop()
  }

  // CSS filter rasterizes the element's ENTIRE subtree (box + descendants) as
  // one flat image — clip-path/border-radius/children are already baked into
  // that raster by construction, so none of the per-feature logic below runs
  // at all. Checked before clip-path/SVG/box-emission for exactly that reason.
  if (hasFilter(s)) {
    if (!hiddenSelf) emitFilteredElement(el, s, ctx)
    popStacks()
    return ownCounters
  }

  // mask-image: same whole-subtree rasterization reasoning as filter above —
  // checked second so an element with BOTH just gets the filter (mask is
  // ignored in that rare combined case, a documented scope limitation)
  if (hasMask(s)) {
    if (!hiddenSelf) await emitMaskedElement(el, s, ctx)
    popStacks()
    return ownCounters
  }

  // clip-path clips the ELEMENT'S OWN box (background/border) too, unlike
  // overflow — pushed before emitBox so it's already active when the box paints.
  // An independent clip layer that composes with overflow (both apply at once
  // when both are set), so it gets its own push/pop pair, pushed outermost.
  let clipPathSpans: Array<{ page: number }> = []
  const clipPathVal = (s as any).clipPath as string | undefined
  if (clipPathVal && clipPathVal !== 'none') {
    const box = domRectToPt(el.getBoundingClientRect(), ctx.containerRect)
    const shape = parseClipPath(clipPathVal, box, s)
    if (shape?.kind === 'rect') {
      const spans = paginateSpan(shape.y, Math.max(shape.h, 1e-3), ctx.pageH)
      for (const { page, y: ly } of spans) {
        ctx.commands.push({ type: 'clip-push', page, x: shape.x, y: ly, w: shape.w, h: shape.h, radius: shape.radius })
      }
      clipPathSpans = spans
    } else if (shape?.kind === 'path') {
      const ys = shape.ops.flatMap(seg => seg.args.filter((_, i) => i % 2 === 1))
      const minY = Math.min(...ys), maxY = Math.max(...ys)
      const spans = paginateSpan(minY, Math.max(maxY - minY, 1e-3), ctx.pageH)
      for (const { page, y: ly } of spans) {
        const dy  = ly - minY
        const ops = shape.ops.map(seg => ({ op: seg.op, args: seg.args.map((v, i) => i % 2 === 1 ? v + dy : v) }))
        ctx.commands.push({ type: 'clip-push', page, path: ops, evenOdd: shape.evenOdd })
      }
      clipPathSpans = spans
    }
  }
  const popClipPath = () => {
    for (const { page } of clipPathSpans) ctx.commands.push({ type: 'clip-pop', page })
  }

  if (tag === 'SVG') {
    if (!hiddenSelf) {
      const startIdx = ctx.commands.length
      await emitInlineSVG(el as SVGSVGElement, ctx)
      tagContent(ctx, ctx.commands.slice(startIdx), FIGURE_CONTENT)
    }
    popClipPath()
    popStacks()
    return ownCounters
  }

  // a list item's marker goes in an Lbl, its content in an LBody
  const listItem = ctx.struct?.stack.at(-1)?.tag === 'LI'
  if (!hiddenSelf) {
    emitBox(el, s, ctx, await resolveBgImages(s))
    const lbl = listItem ? enterStructTag(ctx, 'Lbl') : undefined
    const markerAt = ctx.commands.length
    emitListMarker(el, s, ctx)
    if (lbl) { tagContent(ctx, ctx.commands.slice(markerAt), MARKER_CONTENT); exitStruct(ctx, lbl) }
    // border-image paints over the CSS border emitBox already suppressed for
    // this element — same "part of the element's own decoration" treatment,
    // so it also happens before the overflow clip-push below
    if (hasBorderImage(s)) await emitBorderImage(el, s, ctx)
  }

  // auto and scroll clip just like hidden (the PDF has no scrollbars to reveal the
  // rest); mixed per-axis values (e.g. "hidden auto") must clip too, so check the
  // longhands rather than comparing the shorthand string
  const clips = (v: string) => v === 'hidden' || v === 'clip' || v === 'auto' || v === 'scroll'
  const needsClip = clips(s.overflowX) || clips(s.overflowY)
  // Each page is its own content stream, so a clip region spanning pages needs its
  // own push/pop pair on EVERY page it touches (each at that page's local y).
  // Command array order guarantees each page's stream sees push → children → pop;
  // popping per page keeps every stream's q/Q stack LIFO-balanced.
  let clipSpans: Array<{ page: number; y: number }> = []
  if (needsClip) {
    const r = el.getBoundingClientRect()
    const { x, y, w, h } = domRectToPt(r, ctx.containerRect)
    const clipRegion = paddingBoxClip(x, y, w, h, parseBorderRadius(s, el), s)
    clipSpans = paginateSpan(clipRegion.y, Math.max(clipRegion.h, 1e-3), ctx.pageH)
    for (const { page, y: ly } of clipSpans) {
      ctx.commands.push({
        type: 'clip-push', page, x: clipRegion.x, y: ly, w: clipRegion.w, h: clipRegion.h,
        radius: clipRegion.radius,
      })
    }
  }
  const popClips = () => {
    for (const { page } of clipSpans) {
      ctx.commands.push({ type: 'clip-pop', page })
    }
    popClipPath()
  }

  if (tag === 'IMG') {
    if (!hiddenSelf) {
      const startIdx = ctx.commands.length
      await emitImage(el as HTMLImageElement, ctx)
      tagContent(ctx, ctx.commands.slice(startIdx), FIGURE_CONTENT)
    }
    popClips()
    popStacks()
    return ownCounters
  }

  if (tag === 'CANVAS') {
    if (!hiddenSelf) emitCanvas(el as HTMLCanvasElement, ctx)
    popClips()
    popStacks()
    return ownCounters
  }

  // D1 (AcroForm): INPUT/TEXTAREA/SELECT become a real form field (emitFormField says which
  // input types qualify); tagged output places each in a Form structure element
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (!hiddenSelf) emitFormField(el, s, ctx)
    popClips()
    popStacks()
    return ownCounters
  }

  if (tag === 'A' && !hiddenSelf) emitLinks(el as HTMLAnchorElement, ctx)

  const paintContent = async () => {
    await capturePseudo(el, '::before', s, ctx)
    await walkChildren(el, s, ctx)
    await capturePseudo(el, '::after', s, ctx)
  }
  const lbody = listItem ? enterStructTag(ctx, 'LBody') : undefined
  // a clip keeps its positioned descendants, so they can't escape the clip-pop
  if (ownContext || needsClip || isStackingContext(el, s)) await paintStackingContext(ctx, paintContent)
  else await paintContent()
  exitStruct(ctx, lbody)

  popClips()
  popStacks()
  return ownCounters
}

const PSEUDO_ATTR = 'data-tpdf-pseudo'
// counters are applied by capturePseudo itself, content means nothing on a real element, and
// animations or transitions would restart on the copy instead of keeping the computed frame
const NOT_COPIED = new Set(['content', 'counter-reset', 'counter-increment', 'counter-set'])
const notCopied = (prop: string) => NOT_COPIED.has(prop) || prop.startsWith('animation') || prop.startsWith('transition')

function ensurePseudoOffRule(doc: Document): void {
  if (doc.head.querySelector('style[data-tpdf-pseudo-off]')) return
  const style = doc.createElement('style')
  style.dataset['tpdfPseudoOff'] = ''
  style.textContent = `[${PSEUDO_ATTR}~="before"]::before,[${PSEUDO_ATTR}~="after"]::after{content:none!important}`
  doc.head.appendChild(style)
}

// A pseudo-element has no node to measure, so it is captured as a real one: a span carrying
// its computed style and resolved content, in its place while the pseudo itself is switched off.
async function capturePseudo(el: Element, which: '::before' | '::after', s: CSSStyleDeclaration, ctx: WalkerCtx): Promise<void> {
  const ps = getComputedStyle(el, which)
  if (ps.display === 'none' || !ps.content || ps.content === 'none' || ps.content === 'normal') return

  // the pseudo's own counter-increment persists for later content; a reset it declares is
  // scoped to the pseudo alone
  const pushed = applyCounters(ctx.counters, ps)
  try {
    // strings, counter() and counters() resolve; attr(), quotes and url() bail entirely
    // rather than leak raw CSS text into the output
    const text = resolveContentList(ps.content, ctx.counters)
    if (text === null) return

    const doc = el.ownerDocument
    ensurePseudoOffRule(doc)
    const stand = doc.createElement('span')
    for (let i = 0; i < ps.length; i++) {
      const prop = ps[i]!
      if (!notCopied(prop)) stand.style.setProperty(prop, ps.getPropertyValue(prop))
    }
    stand.textContent = text

    const side = which === '::before' ? 'before' : 'after'
    const prev = el.getAttribute(PSEUDO_ATTR)
    el.setAttribute(PSEUDO_ATTR, prev ? `${prev} ${side}` : side)
    if (which === '::before') el.insertBefore(stand, el.firstChild)
    else el.appendChild(stand)
    try {
      ctx.siblingCounters = []
      await walkChild(stand, s, ctx)
    } finally {
      stand.remove()
      if (prev === null) el.removeAttribute(PSEUDO_ATTR)
      else el.setAttribute(PSEUDO_ATTR, prev)
    }
  } finally {
    popCounters(ctx.counters, pushed)
  }
}
