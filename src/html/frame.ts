// Templates lay out inside a same-origin iframe whose viewport is the page, so @media,
// vw/vh and srcset resolve against the PDF page instead of the host window.

type HostSheet =
  | { kind: 'link'; href: string; media: string; crossOrigin: string | null; referrerPolicy: string }
  | { kind: 'style'; css: string; media: string }

export interface HostSnapshot {
  key:         string
  htmlAttrs:   [string, string][]
  bodyAttrs:   [string, string][]
  colorScheme: string | null
  sheets:      HostSheet[]
}

const HOST_MARK = 'data-tpdf-host'
const appliedKey = new WeakMap<Document, string>()

// overflow:hidden keeps a classic scrollbar from shrinking the viewport below the page width
const BASE_CSS = 'html{overflow:hidden!important}html,body{margin:0!important;padding:0!important;background:transparent!important}'

const attrsOf = (el: Element | null): [string, string][] =>
  el ? Array.from(el.attributes).filter(a => !/^on/i.test(a.name)).map(a => [a.name, a.value]) : []

function sheetText(sheet: CSSStyleSheet | null, fallback: string): string {
  try {
    // CSSOM, not textContent: CSS-in-JS libraries insertRule() into an empty <style>
    return sheet ? Array.from(sheet.cssRules, r => r.cssText).join('\n') : fallback
  } catch {
    return fallback
  }
}

// Templates use the host's CSS (framework classes, theme variables), so it is mirrored
// into every frame. Taken once per render and shared by all of that render's frames.
export function snapshotHost(): HostSnapshot {
  const sheets: HostSheet[] = []
  for (const el of Array.from(document.querySelectorAll<HTMLLinkElement | HTMLStyleElement>('link[rel~="stylesheet"][href], style'))) {
    if (el.sheet?.disabled) continue
    if (el instanceof HTMLLinkElement) {
      sheets.push({ kind: 'link', href: el.href, media: el.media, crossOrigin: el.crossOrigin, referrerPolicy: el.referrerPolicy })
    } else {
      sheets.push({ kind: 'style', css: sheetText(el.sheet, el.textContent), media: el.media })
    }
  }
  for (const sheet of document.adoptedStyleSheets ?? []) {
    if (!sheet.disabled) sheets.push({ kind: 'style', css: sheetText(sheet, ''), media: sheet.media.mediaText })
  }
  const colorScheme = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')?.content ?? null
  const htmlAttrs = attrsOf(document.documentElement)
  const bodyAttrs = attrsOf(document.body)
  return { key: JSON.stringify([sheets, colorScheme]), htmlAttrs, bodyAttrs, colorScheme, sheets }
}

function syncAttrs(target: Element, attrs: [string, string][]): void {
  const keep = new Set(attrs.map(([n]) => n))
  for (const { name } of Array.from(target.attributes)) if (!keep.has(name)) target.removeAttribute(name)
  for (const [n, v] of attrs) if (target.getAttribute(n) !== v) target.setAttribute(n, v)
}

// Resolves once every mirrored <link> has loaded or failed; stylesheets are only
// rebuilt when the host's set changed since the last sync of this document.
export function applyHost(doc: Document, host: HostSnapshot): Promise<void> {
  syncAttrs(doc.documentElement, host.htmlAttrs)
  syncAttrs(doc.body, host.bodyAttrs)
  if (appliedKey.get(doc) === host.key) return Promise.resolve()
  appliedKey.set(doc, host.key)

  for (const old of Array.from(doc.head.querySelectorAll(`[${HOST_MARK}]`))) old.remove()
  const anchor = doc.head.querySelector('[data-tpdf-base]')
  const loads: Promise<void>[] = []
  const add = (node: HTMLElement) => { node.setAttribute(HOST_MARK, ''); doc.head.insertBefore(node, anchor) }

  if (host.colorScheme !== null) {
    const meta = doc.createElement('meta')
    meta.name = 'color-scheme'
    meta.content = host.colorScheme
    add(meta)
  }
  for (const s of host.sheets) {
    if (s.kind === 'style') {
      const style = doc.createElement('style')
      if (s.media) style.media = s.media
      style.textContent = s.css
      add(style)
      continue
    }
    const link = doc.createElement('link')
    link.rel = 'stylesheet'
    // the host's live media, not its markup: the media="print" onload="this.media='all'"
    // async-CSS pattern has already flipped it, and on* attributes are never copied
    if (s.media) link.media = s.media
    if (s.crossOrigin !== null) link.crossOrigin = s.crossOrigin
    if (s.referrerPolicy) link.referrerPolicy = s.referrerPolicy
    loads.push(new Promise<void>(resolve => { link.onload = link.onerror = () => resolve() }))
    link.href = s.href
    add(link)
  }
  return Promise.all(loads).then(() => undefined)
}

// WebKit shrinks a frame's viewport along with any ancestor zoom (the README scales the
// preview that way), so the frame cancels the inherited zoom and is scaled down visually.
function cancelAncestorZoom(frame: HTMLIFrameElement): void {
  let zoom = 1
  for (let el = frame.parentElement; el; el = el.parentElement) zoom *= parseFloat(getComputedStyle(el).zoom) || 1
  frame.style.zoom      = zoom === 1 ? '' : String(1 / zoom)
  frame.style.transform = zoom === 1 ? '' : `scale(${zoom})`
}

export interface PageFrame {
  frame: HTMLIFrameElement
  doc:   Document
}

// srcdoc with a doctype: a bare about:blank frame is in quirks mode. No sandbox: WebKit
// drops the host's load listeners inside one, and templates are already script-free.
export async function createPageFrame(
  parent:   HTMLElement,
  widthPx:  number,
  heightPx: number,
  host:     HostSnapshot,
  preview = false,
): Promise<PageFrame> {
  if (!parent.isConnected) throw new Error('[daepdf] The preview container must be attached to the document.')
  const frame = document.createElement('iframe')
  frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'
  frame.style.cssText = preview
    ? `display:block;width:${widthPx}px;height:${heightPx}px;border:0;transform-origin:0 0;`
    : `position:fixed;top:-99999px;left:-99999px;width:${widthPx}px;height:${heightPx}px;border:0;visibility:hidden;pointer-events:none;`
  await new Promise<void>(resolve => { frame.addEventListener('load', () => resolve(), { once: true }); parent.appendChild(frame) })

  cancelAncestorZoom(frame)
  // the frame's own resize event is what fires when an ancestor's zoom changes later
  frame.contentWindow!.addEventListener('resize', () => cancelAncestorZoom(frame))

  const doc  = frame.contentDocument!
  const base = doc.createElement('base')
  base.href   = document.baseURI
  base.target = '_parent'
  doc.head.appendChild(base)
  const baseStyle = doc.createElement('style')
  baseStyle.dataset['tpdfBase'] = ''
  baseStyle.textContent = BASE_CSS
  doc.head.appendChild(baseStyle)

  await applyHost(doc, host)
  return { frame, doc }
}

// an image that never settles must not hold the export forever
const IMAGE_WAIT_MS = 10000

// Chrome keeps a <select>'s baseline from a layout made before its web font arrived, so the
// content is laid out again from scratch; the style attribute goes back exactly as it was
function relayout(root: Element): void {
  const el = root as HTMLElement
  const attr = el.getAttribute('style')
  el.style.setProperty('display', 'none', 'important')
  void el.offsetHeight
  if (attr !== null) { el.setAttribute('style', attr); return }
  // read first: Chrome serializes a dirty inline style lazily and would leave style="" behind
  el.getAttribute('style')
  el.removeAttribute('style')
}

// Images first: an unloaded <img> lays out at zero width (and a srcset-only one has no
// currentSrc yet), so capturing before it settles drops it and misplaces what follows.
export async function waitForLayout(root: Element): Promise<void> {
  const pending: Promise<unknown>[] = []
  for (const img of Array.from(root.querySelectorAll('img'))) {
    if (img.loading === 'lazy') img.loading = 'eager'
    if (img.complete) continue
    pending.push(new Promise(resolve => {
      img.addEventListener('load', resolve, { once: true })
      img.addEventListener('error', resolve, { once: true })
    }))
  }
  if (pending.length) await Promise.race([Promise.all(pending), new Promise(resolve => setTimeout(resolve, IMAGE_WAIT_MS))])
  await root.ownerDocument.fonts.ready
  relayout(root)
  await nextFrames()
}

// A hidden page (a background tab, a hidden webview) runs no frames until it is shown, though
// layout still works, so the wait is skipped there and ends if the page is hidden midway.
function nextFrames(): Promise<void> {
  if (document.hidden) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => { document.removeEventListener('visibilitychange', done); resolve() }
    document.addEventListener('visibilitychange', done)
    requestAnimationFrame(() => requestAnimationFrame(done))
  })
}
