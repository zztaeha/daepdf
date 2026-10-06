import type { DrawCommand, AnchorEntry, PDFMetadata, PDFSecurity, BookmarkEntry, StructNode } from '../types/index.js'
import { isStructNode } from '../types/index.js'
import type { CounterMap } from './counters.js'

export const PX_PER_PT = 96 / 72

export interface FontBridgeMap {
  [cssFontFamily: string]: {
    name:   string
    style:  string
    weight: number
  }
}

export interface HTMLCapture {
  commands:   DrawCommand[]
  pageCount:  number
  anchors:    Map<string, AnchorEntry>
  // present only when the caller asked for tagged output (fromHTML's
  // taggedPdf/pdfA options) — its top-level kids are /StructTreeRoot's /K
  structRoot?: StructNode | undefined
}

export interface HTMLToPDFOptions {
  metadata?:  PDFMetadata | undefined
  security?:  PDFSecurity | null | undefined
  bookmarks?: BookmarkEntry[] | undefined
  header?:    ((page: number, totalPages: number) => string) | undefined
  footer?:    ((page: number, totalPages: number) => string) | undefined
  // D3/D4: builds a real structure tree (role/reading-order/alt text) and
  // marks the document accordingly. pdfA implies taggedPdf (PDF/A-2a needs
  // the tag tree) — see src/pdf/finalize.ts's applyPdfA
  taggedPdf?: boolean | undefined
  pdfA?:      boolean | undefined
  // PDF/UA-1 on top of taggedPdf (implied); requires metadata.title
  pdfUA?:     boolean | undefined
}

export interface StackLayer { z: number; commands: DrawCommand[] }

export interface WalkerCtx {
  containerRect:   DOMRect
  pageH:           number
  pageW:           number
  commands:        DrawCommand[]
  anchors:         Map<string, AnchorEntry>
  fontMap:         FontBridgeMap
  registeredFonts: Map<string, string[]>
  opacityStack:    number[]
  blendStack:      string[]
  // shared by reference on purpose: counters advance in DOM order even where
  // stacking reorders the painted output
  counters:        CounterMap
  // D3: undefined entirely when tagging is off, so every existing render
  // path (taggedPdf/pdfA unset) pays zero cost and produces byte-identical
  // output to before this feature existed
  struct?: undefined | {
    root:          StructNode
    stack:         StructNode[]
    mcidCounters:  Map<number, number>
    artifactDepth: number
    annotCount:    number
  }
  // D1 (AcroForm): a stable, auto-incrementing suffix for form controls
  // with no `name` attribute — field names must be unique per document.
  // Boxed in an object (not a plain number) so it stays the SAME shared
  // counter across a z-sort/transform fork's `{...ctx, commands: []}`
  // shallow copy — a bare number would get copied BY VALUE into the fork,
  // letting two unnamed fields in different forked subtrees both land on
  // the same auto-generated name, the exact hazard `counters` (a Map,
  // reference-shared for the same reason) already documents above.
  fieldCounter: { n: number }
  // glyph-box top to baseline, per font: measured once with a probe, since a probe per text
  // node forces a relayout each time (quadratic in text nodes). Shared across forks.
  baselineOffsets: Map<string, number>
  // each element's -webkit-line-clamp box, asked by every text node below it; per capture,
  // since fromDOM may walk a live element whose styles change between exports
  clampBoxes: Map<Element, Element | null>
  // positioned and z-indexed descendants of the stacking context being painted, collected
  // here so they paint above (or, at negative z, below) its normal flow; see walk.ts
  stacking?:       StackLayer[] | undefined
  // counter names the element being walked's earlier siblings instantiated (walkChildren)
  siblingCounters?: readonly string[] | undefined
  // position:fixed content: matches CSS Paged Media semantics (repeats on
  // every page box) rather than normal continuous-scroll "pinned to
  // viewport" semantics — see walk.ts's captureFixedElement and index.ts's
  // fromDOM for capture/replication. Undefined for chrome.ts's own header/
  // footer captures (already inherently single-instance-per-page, so a
  // nested position:fixed there just falls through to normal handling) —
  // shared by reference across z-sort/transform forks, same reasoning as
  // `counters` above.
  fixedElements?: DrawCommand[][]
}

export function domRectToPt(r: DOMRect, cRect: DOMRect) {
  return {
    x: (r.left - cRect.left) / PX_PER_PT,
    y: (r.top  - cRect.top)  / PX_PER_PT,
    w: r.width  / PX_PER_PT,
    h: r.height / PX_PER_PT,
  }
}

export function paginate(yPt: number, pageH: number): { page: number; y: number } {
  const page = Math.max(1, Math.floor(yPt / pageH) + 1)
  return { page, y: yPt - (page - 1) * pageH }
}

// Every page/y slice a vertical span [yPt, yPt+h) touches, not just the first.
// Each entry's y is that page's own local coordinate (can be negative or exceed
// pageH — callers draw the full, unmodified shape at each; the page's own MediaBox
// naturally clips it to the correct visible slice, giving a seamless continuation
// across the break with no extra geometry needed).
export function paginateSpan(yPt: number, h: number, pageH: number): Array<{ page: number; y: number }> {
  const startPage = Math.max(1, Math.floor(yPt / pageH) + 1)
  const endYPt     = yPt + h
  const epsilon    = 1e-6
  const endPage    = Math.max(startPage, Math.floor((endYPt - epsilon) / pageH) + 1)

  const spans: Array<{ page: number; y: number }> = []
  for (let p = startPage; p <= endPage; p++) {
    spans.push({ page: p, y: yPt - (p - 1) * pageH })
  }
  return spans
}

export function stackOpacity(ctx: WalkerCtx): number | undefined {
  if (!ctx.opacityStack.length) return undefined
  const o = ctx.opacityStack.reduce((a, b) => a * b, 1)
  return o < 1 ? o : undefined
}

// PDF's /BM applies per painting op, not per group — the nearest ancestor's
// mode wins, which matches the common single-level usage of mix-blend-mode
const CSS_TO_PDF_BLEND: Record<string, string> = {
  'multiply': 'Multiply', 'screen': 'Screen', 'overlay': 'Overlay',
  'darken': 'Darken', 'lighten': 'Lighten',
  'color-dodge': 'ColorDodge', 'color-burn': 'ColorBurn',
  'hard-light': 'HardLight', 'soft-light': 'SoftLight',
  'difference': 'Difference', 'exclusion': 'Exclusion',
  'hue': 'Hue', 'saturation': 'Saturation', 'color': 'Color', 'luminosity': 'Luminosity',
}

export function cssBlendToPdf(v: string | undefined): string | undefined {
  return v ? CSS_TO_PDF_BLEND[v] : undefined
}

export function stackBlend(ctx: WalkerCtx): string | undefined {
  return ctx.blendStack.length ? ctx.blendStack[ctx.blendStack.length - 1] : undefined
}

// D3 (tagged PDF): HTML tag → PDF structure type. role="presentation"/"none"
// or aria-hidden="true" mark the whole subtree as non-content (excluded
// from the reading order entirely — no StructNode, no mcid for anything
// inside), the standard HTML→tagged-PDF convention for decorative markup.
function structTagFor(el: Element, tag: string): string {
  const role = el.getAttribute('role')
  if (role === 'presentation' || role === 'none') return 'Artifact'
  if (el.getAttribute('aria-hidden') === 'true') return 'Artifact'
  // an empty alt marks a decorative image, as in HTML
  if (tag === 'IMG' && el.getAttribute('alt') === '') return 'Artifact'
  switch (tag) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return tag
    case 'P':     return 'P'
    case 'UL': case 'OL': return 'L'
    case 'LI':    return 'LI'
    case 'TABLE': return 'Table'
    case 'THEAD': return 'THead'
    case 'TBODY': return 'TBody'
    case 'TFOOT': return 'TFoot'
    case 'TR':    return 'TR'
    case 'TD':    return 'TD'
    case 'TH':    return 'TH'
    case 'IMG': case 'SVG': return 'Figure'
    case 'A':     return 'Link'
    case 'INPUT': case 'SELECT': case 'TEXTAREA': return 'Form'
    case 'SPAN':  return 'Span'
    default:      return 'Div'
  }
}

// The cells a TH heads: its own scope attribute, else its columns in a table head, else its
// row when the row also holds data cells
function headerScope(el: Element): 'Row' | 'Column' {
  const attr = el.getAttribute('scope')?.toLowerCase()
  if (attr === 'row' || attr === 'rowgroup') return 'Row'
  if (attr === 'col' || attr === 'colgroup') return 'Column'
  if (el.closest('thead')) return 'Column'
  return el.parentElement && Array.from(el.parentElement.children).some(c => c.tagName === 'TD') ? 'Row' : 'Column'
}

// Pushes a new structure node for `el` as a child of whatever is currently
// innermost, and returns it so the caller can pop it later — or returns
// 'artifact' for a marked-non-content subtree (tracked via a depth counter,
// not a StructNode, since artifacts sit outside the tree entirely), or
// undefined when tagging is off (ctx.struct absent), so untagged renders
// pay zero cost here.
export function enterStruct(el: Element, tag: string, ctx: WalkerCtx): StructNode | 'artifact' | undefined {
  if (!ctx.struct) return undefined
  const structTag = structTagFor(el, tag)
  if (structTag === 'Artifact') {
    ctx.struct.artifactDepth++
    return 'artifact'
  }
  const node: StructNode = { tag: structTag, kids: [] }
  if (structTag === 'Figure') {
    const alt = el.getAttribute('alt') || el.getAttribute('aria-label') ||
      (tag === 'SVG' ? el.querySelector(':scope > title')?.textContent.trim() : undefined)
    if (alt) node.alt = alt
  }
  if (structTag === 'TH') node.scope = headerScope(el)
  const lang = (el as HTMLElement).lang
  if (lang) node.lang = lang
  ctx.struct.stack.at(-1)?.kids.push(node)
  ctx.struct.stack.push(node)
  return node
}

// A structure node with no element of its own (a list item's Lbl and LBody), under the
// innermost one; undefined when tagging is off or inside an artifact
export function enterStructTag(ctx: WalkerCtx, tag: string): StructNode | undefined {
  if (!ctx.struct || ctx.struct.artifactDepth > 0) return undefined
  const node: StructNode = { tag, kids: [] }
  ctx.struct.stack.at(-1)?.kids.push(node)
  ctx.struct.stack.push(node)
  return node
}

export function exitStruct(ctx: WalkerCtx, entry: StructNode | 'artifact' | undefined): void {
  if (!ctx.struct || entry === undefined) return
  if (entry === 'artifact') { ctx.struct.artifactDepth--; return }
  ctx.struct.stack.pop()
  // an element that produced no real tagged content anywhere in its own
  // subtree is dead weight in the tree — prune it rather than emit an
  // empty, meaningless StructElem
  if (entry.kids.length === 0) {
    const parent = ctx.struct.stack.at(-1)
    const idx = parent?.kids.indexOf(entry) ?? -1
    if (parent && idx >= 0) parent.kids.splice(idx, 1)
  }
}

// Tags one page-slice of freshly-emitted content (one text run, one image)
// to whatever structure element is currently innermost, returning the mcid
// (to stamp onto the DrawCommand) and that element's own tag (the content
// stream wraps the operators in `/<tag> << /MCID n >> BDC ... EMC`, the
// conventional way to make the tag human-legible even though the REAL link
// to the struct tree is the mcid/ParentTree, not this name). Undefined when
// tagging is off, or the content sits inside an aria-hidden/
// role=presentation subtree — callers leave the command's own mcid field
// unset in that case, matching how a completely untagged render behaves.
export function tagStructContent(ctx: WalkerCtx, page: number): { mcid: number; tag: string } | undefined {
  if (!ctx.struct || ctx.struct.artifactDepth > 0) return undefined
  const parent = ctx.struct.stack.at(-1)
  if (!parent) return undefined
  const mcid = ctx.struct.mcidCounters.get(page) ?? 0
  ctx.struct.mcidCounters.set(page, mcid + 1)
  parent.kids.push({ mcid, page })
  return { mcid, tag: parent.tag }
}

// Tagged PDF puts each link or form-field annotation in its structure element (an OBJR
// there, a /StructParent on the annotation); returns the key that pairs the two
export function tagStructAnnot(ctx: WalkerCtx, page: number): number | undefined {
  if (!ctx.struct || ctx.struct.artifactDepth > 0) return undefined
  const parent = ctx.struct.stack.at(-1)
  if (!parent || parent.tag === 'Root') return undefined
  const annot = ctx.struct.annotCount++
  parent.kids.push({ annot, page })
  return annot
}

// fromDOM's own pageCount forgiveness can drop a sub-pixel-overshoot
// trailing page's worth of DrawCommands AFTER the walk already tagged some
// of them — this mirrors that same filter on the struct tree, so it never
// ends up referencing a (page, mcid) pair that doesn't actually exist in
// the final command list. Recursively removes now-empty nodes the same
// way exitStruct does.
export function pruneStructTreePages(node: StructNode, pageCount: number): void {
  node.kids = node.kids.filter(kid => isStructNode(kid) || kid.page <= pageCount)
  for (const kid of node.kids) {
    if (isStructNode(kid)) pruneStructTreePages(kid, pageCount)
  }
  node.kids = node.kids.filter(kid => !isStructNode(kid) || kid.kids.length > 0)
}
