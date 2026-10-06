import { applyToPDF, rasterizeSVGs, PDFA_SECURITY_ERROR, PDFUA_TITLE_ERROR } from '../pdf/index.js'
import initEngine from '../daegun/wasm/daegun.js'
import { resolvePageSize, isStructNode } from '../types/index.js'
import type { PageConfig, DocDefinition, DrawCommand, TransformCommand, ClipCommand, ArtifactCommand, AnchorEntry, StructNode } from '../types/index.js'
import { PX_PER_PT, pruneStructTreePages, type FontBridgeMap, type HTMLCapture, type HTMLToPDFOptions, type WalkerCtx } from './types.js'
import { buildRegisteredFontMap } from './fonts.js'
import { paintStackingContext, walkChildren } from './walk.js'
import { emitBox } from './emit.js'
import { resolveBgImages } from './images.js'
import { parseSafeHTML, safeInjectParsed, createHiddenContainer, autoRegisterFonts, injectWordBreaks, nextScopeId, extractFontFaceBlocks } from './prep.js'
import { snapshotHost, applyHost, createPageFrame, waitForLayout, type HostSnapshot } from './frame.js'
import { applyCounters } from './counters.js'
import { applyPageBreaks, undoPageBreaks } from './breaks.js'
import { measureChromeHeight, captureChrome, type PageChromeFn } from './chrome.js'

export type { FontBridgeMap, HTMLToPDFOptions }

export async function fromDOM(
  el:        HTMLElement,
  config:    PageConfig,
  fonts:     FontBridgeMap = {},
  taggedPdf: boolean = false,
): Promise<HTMLCapture> {
  const size = resolvePageSize(config.size, config.orientation)
  await waitForLayout(el)

  // page-break pass mutates the DOM with marked spacers (browser print behavior:
  // no cut lines/rows) — always undone, since el may be the caller's live element
  applyPageBreaks(el, size.height * PX_PER_PT)
  try {
    // D3: the root itself is never a real StructElem (its kids ARE
    // /StructTreeRoot's own /K array) — tag 'Root' is a sentinel only
    // enterStruct/tagStructContent ever look at (via the stack), never
    // written to the PDF
    const structRoot = { tag: 'Root', kids: [] }
    const ctx: WalkerCtx = {
      containerRect:   el.getBoundingClientRect(),
      pageH:           size.height,
      pageW:           size.width,
      commands:        [],
      anchors:         new Map(),
      fontMap:         fonts,
      registeredFonts: buildRegisteredFontMap(),
      opacityStack:    [],
      blendStack:      [],
      counters:        new Map(),
      struct: taggedPdf
        ? { root: structRoot, stack: [structRoot], mcidCounters: new Map(), artifactDepth: 0, annotCount: 0 }
        : undefined,
      fieldCounter:    { n: 0 },
      baselineOffsets: new Map(),
      clampBoxes:      new Map(),
      fixedElements:   [],
    }

    // the root's own background/border — walkChildren only visits children, and the
    // template's body/:root styles land on this very element after CSS scoping
    // (same for a body-level counter-reset; nothing outlives the walk, no pop needed)
    const rootStyle = getComputedStyle(el)
    applyCounters(ctx.counters, rootStyle)
    emitBox(el, rootStyle, ctx, await resolveBgImages(rootStyle))
    await paintStackingContext(ctx, () => walkChildren(el, rootStyle, ctx))

    const totalHPx  = el.scrollHeight
    const rawPages  = totalHPx / (size.height * PX_PER_PT)
    const frac      = rawPages - Math.floor(rawPages)
    const pageCount = Math.max(1, frac < 0.01 ? Math.floor(rawPages) : Math.ceil(rawPages))

    // the same sub-pixel overshoot the pageCount forgiveness above just dismissed can
    // still have produced page-N+1 slices via paginateSpan — drop them, or set_page()
    // would materialize a stray near-blank trailing page (clip push/pop pairs share a
    // page number, so they are always dropped or kept together)
    const commands = ctx.commands.filter(c => c.page <= pageCount)

    // position:fixed content, captured once (see walk.ts's captureFixedElement)
    // at whichever page it naturally fell on — replicated onto every OTHER real
    // page now that pageCount is known, matching CSS Paged Media's repeat-per-
    // page-box semantics. Scope limit, documented rather than silently wrong:
    // mcid/structTag/structAnnot (D3 tagged PDF) is kept only on the natural-page
    // instance – reusing the same mcid on a different page would collide with that
    // page's own independent mcid counter, so replicated copies are struct-untagged.
    for (const group of ctx.fixedElements ?? []) {
      if (!group.length) continue
      const naturalPage = Math.min(...group.map(c => c.page))
      if (naturalPage > pageCount) continue
      for (let page = 1; page <= pageCount; page++) {
        for (const cmd of group) {
          if (page === naturalPage) { commands.push(cmd); continue }
          const clone = { ...cmd, page } as typeof cmd & { mcid?: number; structTag?: string; structAnnot?: number }
          delete clone.mcid
          delete clone.structTag
          delete clone.structAnnot
          commands.push(clone)
        }
      }
    }

    if (taggedPdf) pruneStructTreePages(structRoot, pageCount)

    return { commands, pageCount, anchors: ctx.anchors, structRoot: taggedPdf ? structRoot : undefined }
  } finally {
    undoPageBreaks(el)
  }
}

export async function fromHTML(
  html:      string,
  config:    PageConfig,
  fonts:     FontBridgeMap = {},
  chrome:    { header?: PageChromeFn | undefined; footer?: PageChromeFn | undefined } = {},
  taggedPdf: boolean = false,
): Promise<HTMLCapture> {
  const scopeId   = nextScopeId()
  const parsed    = parseSafeHTML(html, scopeId)
  const styleText = Array.from(parsed.querySelectorAll('style'))
    .map(s => s.textContent).join('\n')
  await autoRegisterFonts(styleText)
  const trueSize  = resolvePageSize(config.size, config.orientation)
  const host      = snapshotHost()

  // one frame serves every page's header and footer, not one per capture
  const chromeFrame = chrome.header || chrome.footer
    ? await createPageFrame(document.body, trueSize.width * PX_PER_PT, trueSize.height * PX_PER_PT, host)
    : null
  try {
    // header and footer bands are measured once, up front: the content is laid out
    // against the page height they leave
    const headerH = chrome.header ? await measureChromeHeight(chrome.header, trueSize.width, chromeFrame!.doc) : 0
    const footerH = chrome.footer ? await measureChromeHeight(chrome.footer, trueSize.width, chromeFrame!.doc) : 0
    const contentConfig: PageConfig = (headerH || footerH)
      ? { size: { width: trueSize.width, height: trueSize.height - headerH - footerH } }
      : config
    const contentHeight = resolvePageSize(contentConfig.size, contentConfig.orientation).height

    const frame = await createPageFrame(document.body, trueSize.width * PX_PER_PT, contentHeight * PX_PER_PT, host)
    let capture: HTMLCapture
    try {
      const container = createHiddenContainer(frame.doc, trueSize.width, contentHeight)
      safeInjectParsed(parsed, container, scopeId)
      // after attaching: white-space set by stylesheets only resolves on an attached node
      injectWordBreaks(container)
      const opszStyle = frame.doc.createElement('style')
      opszStyle.textContent = `[data-tpdf-scope="${scopeId}"] *{font-optical-sizing:none}`
      container.appendChild(opszStyle)
      capture = await fromDOM(container, contentConfig, fonts, taggedPdf)
    } finally {
      frame.frame.remove()
    }

    if (!headerH && !footerH) return capture
    return await applyChrome(capture, chrome, trueSize, headerH, footerH, fonts, chromeFrame!.doc)
  } finally {
    chromeFrame?.frame.remove()
  }
}

// The next free AnnotRef key: header/footer annotations are numbered after the content's
function nextAnnotKey(root: StructNode): number {
  let max = -1
  const walk = (node: StructNode): void => {
    for (const kid of node.kids) {
      if (isStructNode(kid)) walk(kid)
      else if ('annot' in kid) max = Math.max(max, kid.annot)
    }
  }
  walk(root)
  return max + 1
}

// Links and form fields are annotations outside the content stream, where the translate that
// moves content into place under a header or into the footer band never reaches; they move by y.
function shiftAnnotation(cmd: DrawCommand, dy: number): DrawCommand {
  return dy && (cmd.type === 'link' || cmd.type === 'field') ? { ...cmd, y: cmd.y + dy } : cmd
}

async function applyChrome(
  capture:  HTMLCapture,
  chrome:   { header?: PageChromeFn | undefined; footer?: PageChromeFn | undefined },
  trueSize: { width: number; height: number },
  headerH:  number,
  footerH:  number,
  fonts:    FontBridgeMap,
  doc:      Document,
): Promise<HTMLCapture> {
  const pages = Array.from(new Set(capture.commands.map(c => c.page))).sort((a, b) => a - b)
  const out: DrawCommand[] = []
  const contentH = trueSize.height - headerH - footerH

  // Tagged output: a header or footer is a pagination artifact, but its links and fields are
  // annotations, which must sit in the structure tree, each in a Link or Form element of its own
  const root = capture.structRoot
  let annotKey = root ? nextAnnotKey(root) : 0
  const tagAnnotation = (cmd: DrawCommand): DrawCommand => {
    if (!root || (cmd.type !== 'link' && cmd.type !== 'field')) return cmd
    root.kids.push({ tag: cmd.type === 'link' ? 'Link' : 'Form', kids: [{ annot: annotKey, page: cmd.page }] })
    return { ...cmd, structAnnot: annotKey++ }
  }

  for (const page of pages) {
    if (headerH) out.push({ type: 'transform-push', page, matrix: [1, 0, 0, 1, 0, -headerH] } satisfies TransformCommand)
    // Several existing draw paths (emit.ts's paginateSpan callers: box borders,
    // rules, etc.) draw an element's FULL, unsliced shape on every page it
    // spans and rely on the page's own MediaBox to crop the off-page portion —
    // true only when the content area's own height equals the true physical
    // page height. Once a header/footer shrinks it, that assumption breaks:
    // a border/rule extending past the shrunk content height is no longer cut
    // off by the (larger, unshrunk) physical MediaBox, and bleeds into the
    // header/footer band below. An explicit clip restores the boundary this
    // relied on implicitly. Caught via direct visual inspection of a real
    // multi-page invoice render — a table's column border lines bled through
    // the footer — not by any operator-level test.
    out.push({ type: 'clip-push', page, x: 0, y: 0, w: trueSize.width, h: contentH } satisfies ClipCommand)
    for (const cmd of capture.commands) if (cmd.page === page) out.push(shiftAnnotation(cmd, headerH))
    out.push({ type: 'clip-pop', page } satisfies ClipCommand)
    if (headerH) out.push({ type: 'transform-pop', page } satisfies TransformCommand)
  }

  for (let page = 1; page <= capture.pageCount; page++) {
    // a template that measures to 0 height (e.g. an empty string) contributes no
    // reserved band at all — skip its own capture too, since ctx.pageH=0 would
    // divide-by-zero inside the walker's own pagination math
    if (chrome.header && headerH > 0) {
      const cmds = await captureChrome(chrome.header, page, capture.pageCount, trueSize.width, headerH, fonts, doc)
      // clips to the reserved band — the header's own natural height was measured
      // from a single representative render (page=1, totalPages=1); a real page's
      // digit count ("Page 10 of 250" vs "Page 1 of 1") can wrap a shade taller, and
      // this keeps that from bleeding into the content directly below it
      out.push({ type: 'clip-push', page, x: 0, y: 0, w: trueSize.width, h: headerH } satisfies ClipCommand)
      out.push({ type: 'artifact-push', page, subtype: 'Header' } satisfies ArtifactCommand)
      for (const c of cmds) { c.page = page; out.push(tagAnnotation(c)) }
      out.push({ type: 'artifact-pop', page } satisfies ArtifactCommand)
      out.push({ type: 'clip-pop', page } satisfies ClipCommand)
    }
    if (chrome.footer && footerH > 0) {
      const cmds = await captureChrome(chrome.footer, page, capture.pageCount, trueSize.width, footerH, fonts, doc)
      out.push({ type: 'transform-push', page, matrix: [1, 0, 0, 1, 0, -(trueSize.height - footerH)] } satisfies TransformCommand)
      out.push({ type: 'clip-push', page, x: 0, y: 0, w: trueSize.width, h: footerH } satisfies ClipCommand)
      out.push({ type: 'artifact-push', page, subtype: 'Footer' } satisfies ArtifactCommand)
      for (const c of cmds) { c.page = page; out.push(tagAnnotation(shiftAnnotation(c, trueSize.height - footerH))) }
      out.push({ type: 'artifact-pop', page } satisfies ArtifactCommand)
      out.push({ type: 'clip-pop', page } satisfies ClipCommand)
      out.push({ type: 'transform-pop', page } satisfies TransformCommand)
    }
  }

  // anchors were captured against the content's own local coordinates (0 at
  // content top) — shift by headerH so a named dest / #fragment link still
  // points at the right spot once content moved down
  const anchors = new Map<string, AnchorEntry>()
  for (const [id, entry] of capture.anchors) {
    anchors.set(id, headerH ? { page: entry.page, y: entry.y + headerH } : entry)
  }

  return { commands: out, pageCount: capture.pageCount, anchors, structRoot: capture.structRoot }
}

const PAGE_GAP_PX = 24
// matches the export's own opsz rule; kept with the fonts so it survives re-renders
const PREVIEW_FRAME_CSS = '[data-tpdf-scope] *{font-optical-sizing:none}\n'

interface PreviewQueue { latest: number; chain: Promise<void> }
const previewQueues = new WeakMap<HTMLElement, PreviewQueue>()

// One render at a time per container, and only the newest waiting call runs. Resolves when
// this call's pages are on screen, or as soon as a newer call has replaced it.
export function previewHTML(
  html:      string,
  container: HTMLElement,
  config:    PageConfig,
): Promise<void> {
  const queue = previewQueues.get(container) ?? { latest: 0, chain: Promise.resolve() }
  previewQueues.set(container, queue)
  const token = ++queue.latest
  const run = queue.chain.then(() => token === queue.latest ? renderPreview(html, container, config) : undefined)
  queue.chain = run.catch(() => undefined)
  return run
}

// a frame reloads (and loses its setup) whenever it is moved in the DOM; mid-reload its
// document can be half parsed, with no head yet
function frameDoc(frame: HTMLIFrameElement | null | undefined): Document | null {
  const doc = frame?.contentDocument
  return doc?.head?.querySelector('[data-tpdf-base]') ? doc : null
}

function addPreviewStyle(doc: Document): void {
  const style = doc.createElement('style')
  style.dataset['tpdfFonts'] = ''
  style.textContent = PREVIEW_FRAME_CSS
  doc.head.appendChild(style)
}

// Brings a frame up to date: page size, host CSS, and any @font-face it lacks. Fonts
// live in the frame head, once each, so re-renders never refetch them.
async function prepareFrame(frame: HTMLIFrameElement, wPx: number, hPx: number, host: HostSnapshot, fontBlocks: string[]): Promise<void> {
  const doc = frame.contentDocument!
  frame.style.width  = `${wPx}px`
  frame.style.height = `${hPx}px`
  await applyHost(doc, host)
  const fontsEl = doc.head.querySelector('[data-tpdf-fonts]')!
  for (const block of fontBlocks) {
    if (!fontsEl.textContent.includes(block)) fontsEl.appendChild(doc.createTextNode(block + '\n'))
  }
}

// Measuring uses a hidden frame in the host body, not a page card: WebKit scales layout
// inside a frame under a zoomed ancestor, and the README recommends zooming the preview.
const measureFrames = new Map<HTMLElement, HTMLIFrameElement>()

async function measureFrameFor(container: HTMLElement, wPx: number, hPx: number, host: HostSnapshot): Promise<HTMLIFrameElement> {
  for (const [owner, frame] of measureFrames) {
    if (!owner.isConnected) { frame.remove(); measureFrames.delete(owner) }
  }
  const existing = measureFrames.get(container)
  if (frameDoc(existing)) return existing!
  existing?.remove()
  const { frame, doc } = await createPageFrame(document.body, wPx, hPx, host)
  addPreviewStyle(doc)
  measureFrames.set(container, frame)
  return frame
}

// created hidden; the swap reveals it once it has content
async function addPageCard(container: HTMLElement, wPx: number, hPx: number, host: HostSnapshot): Promise<HTMLDivElement> {
  const card = document.createElement('div')
  card.dataset['tpdfPage'] = ''
  card.style.cssText = `position:relative;width:${wPx}px;height:${hPx}px;overflow:hidden;flex-shrink:0;background:white;box-shadow:0 2px 8px rgba(0,0,0,0.15);display:none;`
  container.appendChild(card)
  addPreviewStyle((await createPageFrame(card, wPx, hPx, host, true)).doc)
  return card
}

async function renderPreview(html: string, container: HTMLElement, config: PageConfig): Promise<void> {
  container.dataset['tpdfPreview'] = ''

  const size    = resolvePageSize(config.size, config.orientation)
  const pageWPx = size.width  * PX_PER_PT
  const pageHPx = size.height * PX_PER_PT
  const host    = snapshotHost()

  const scopeId = nextScopeId()
  const parsed  = parseSafeHTML(html, scopeId)

  const fontBlocks: string[] = []
  for (const el of Array.from(parsed.querySelectorAll('style'))) {
    let css = el.textContent
    for (const block of extractFontFaceBlocks(css)) {
      fontBlocks.push(block)
      css = css.replace(block, '')
    }
    el.textContent = css
  }

  // Measured with word breaks and page-break spacers applied, then cloned into each page,
  // so the preview carries the same spacers as the PDF and matches it page for page
  const measureFrame = await measureFrameFor(container, pageWPx, pageHPx, host)
  await prepareFrame(measureFrame, pageWPx, pageHPx, host, fontBlocks)
  const doc     = frameDoc(measureFrame)!
  const measure = doc.createElement('div')
  measure.style.cssText = `position:absolute;top:0;left:0;width:${pageWPx}px;height:auto;transform:translateZ(0);`
  safeInjectParsed(parsed, measure, scopeId)
  doc.body.appendChild(measure)
  let totalHPx: number
  let measured: Node[]
  try {
    await waitForLayout(measure)
    injectWordBreaks(measure)
    applyPageBreaks(measure, pageHPx)
    totalHPx = measure.scrollHeight
    measured = Array.from(measure.childNodes).map(n => n.cloneNode(true))
  } finally {
    measure.remove()
  }

  // fractional overshoot < 1% of page height is sub-pixel rounding, not real overflow
  const rawPages  = totalHPx / pageHPx
  const frac      = rawPages - Math.floor(rawPages)
  const pageCount = Math.max(1, frac < 0.01 ? Math.floor(rawPages) : Math.ceil(rawPages))

  const cards: HTMLDivElement[] = []
  for (const card of Array.from(container.querySelectorAll<HTMLDivElement>(':scope > [data-tpdf-page]'))) {
    if (frameDoc(card.querySelector('iframe'))) cards.push(card)
    else card.remove()
  }
  while (cards.length < pageCount) cards.push(await addPageCard(container, pageWPx, pageHPx, host))
  for (const card of cards.slice(0, pageCount)) {
    card.style.width  = `${pageWPx}px`
    card.style.height = `${pageHPx}px`
    await prepareFrame(card.querySelector('iframe')!, pageWPx, pageHPx, host, fontBlocks)
  }

  // Atomic swap: every page fills in the same task, so nothing flashes between renders
  const active = new Set<Element>(cards.slice(0, pageCount))
  cards.slice(0, pageCount).forEach((card, p) => {
    const pageDocument = frameDoc(card.querySelector('iframe'))!
    const inner = pageDocument.createElement('div')
    // scope root for the @scope CSS wrapper (normally set by safeInjectParsed) — must
    // be the SAME scopeId the measured content's <style> tags were scoped with
    inner.dataset['tpdfScope'] = scopeId
    // margin:0 pins the clone to the page top — a template body margin becomes
    // ":scope { margin }" after scoping, which would displace this absolutely-
    // positioned div and shift every preview boundary by that amount (the PDF
    // capture container's own margin never moves content within containerRect)
    inner.style.cssText = `position:absolute;top:${-(p * pageHPx)}px;left:0;width:100%;margin:0;`
    for (const node of measured) inner.appendChild(pageDocument.importNode(node, true))
    pageDocument.body.replaceChildren(inner)
    card.style.display = ''
    card.style.marginBottom = p < pageCount - 1 ? `${PAGE_GAP_PX}px` : ''
  })
  for (const child of Array.from(container.children)) {
    if (!active.has(child) && child.tagName !== 'STYLE') child.remove()
  }
}

// PDF/UA wants alternative text on every figure; that is the template's markup to fix
function warnFiguresWithoutAlt(root: StructNode): void {
  let missing = 0
  const walk = (node: StructNode): void => {
    if (node.tag === 'Figure' && !node.alt) missing++
    for (const kid of node.kids) if (isStructNode(kid)) walk(kid)
  }
  walk(root)
  if (missing) console.warn(`[daepdf] PDF/UA: ${missing} image(s) have no alternative text – add alt (or alt="" for decoration), aria-label, or an SVG <title>.`)
}

export async function renderHTMLtoPDF(
  html:    string,
  config:  PageConfig,
  options: HTMLToPDFOptions = {},
  fonts:   FontBridgeMap   = {},
): Promise<Uint8Array> {
  // PDF/A disallows encryption outright — a caller finds out immediately
  // rather than silently getting a non-conformant (or unencrypted) file
  if (options.pdfA && options.security) {
    throw new Error(PDFA_SECURITY_ERROR)
  }
  if (options.pdfUA && !options.metadata?.title) throw new Error(PDFUA_TITLE_ERROR)
  await initEngine()
  const taggedPdf = !!(options.taggedPdf || options.pdfA || options.pdfUA)
  const { commands, anchors, structRoot, pageCount } = await fromHTML(
    html, config, fonts, { header: options.header, footer: options.footer }, taggedPdf,
  )
  await rasterizeSVGs(commands)
  if (options.pdfUA && structRoot) warnFiguresWithoutAlt(structRoot)

  const shim: DocDefinition = {
    config,
    metadata:  options.metadata,
    security:  options.security,
    bookmarks: options.bookmarks,
    pdfA:      !!options.pdfA,
    pdfUA:     !!options.pdfUA,
  }

  return applyToPDF(commands, shim, anchors, structRoot, pageCount)
}
