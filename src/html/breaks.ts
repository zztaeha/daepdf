// Page-break engine. Mutates the attached, styled container with marked spacers
// so the browser itself reflows the real layout, then undoPageBreaks reverts it
// all, since fromDOM may be handed the caller's live element.

const BREAK_ATTR  = 'data-tpdf-break'
const MARGIN_ATTR = 'data-tpdf-break-margin'
const MAX_FIXES   = 300

interface Violation {
  top:  number
  fix:  () => boolean
}

function isOutOfFlow(cs: CSSStyleDeclaration): boolean {
  return cs.position === 'absolute' || cs.position === 'fixed'
}

// the forced page breaks; legacy page-break-*: always already computes to page
const FORCED_BREAKS = new Set(['page', 'left', 'right', 'recto', 'verso'])

function wantsBreakBefore(cs: CSSStyleDeclaration): boolean {
  return FORCED_BREAKS.has((cs as any).breakBefore)
}

function wantsBreakAfter(cs: CSSStyleDeclaration): boolean {
  return FORCED_BREAKS.has((cs as any).breakAfter)
}

function avoidsBreakInside(cs: CSSStyleDeclaration): boolean {
  const v = (cs as any).breakInside
  return v === 'avoid' || v === 'avoid-page'
}

const REPLACED_TAGS = new Set(['IMG', 'CANVAS', 'SVG'])
const ATOMIC_TAGS   = new Set([...REPLACED_TAGS, 'TR'])

function isFlexOrGrid(cs: CSSStyleDeclaration): boolean {
  const d = cs.display
  return d === 'flex' || d === 'grid' || d === 'inline-flex' || d === 'inline-grid'
}

// Pushed whole when crossing a boundary, as browser print does. One too tall to
// move is entered instead; only replaced elements are true leaves.
function isAtomic(el: Element, cs: CSSStyleDeclaration): boolean {
  if (ATOMIC_TAGS.has(el.tagName.toUpperCase())) return true
  return avoidsBreakInside(cs) || isFlexOrGrid(cs)
}

// A sibling spacer between flex/grid children becomes an item of its own and
// moves nothing, except down a flex column.
function siblingSpacerMoves(parent: Element): boolean {
  const cs = getComputedStyle(parent)
  if (!isFlexOrGrid(cs)) return true
  return cs.display.endsWith('flex') && cs.flexDirection.startsWith('column')
}

// distance from `top` down to the next page boundary
function pushHeight(top: number, containerTop: number, pageHPx: number): number {
  const rel = top - containerTop
  const next = (Math.floor(rel / pageHPx) + 1) * pageHPx
  return next - rel
}

function makeSpacer(doc: Document, forTag: string, heightPx: number): Element {
  if (forTag === 'TR') {
    const tr = doc.createElement('tr')
    tr.setAttribute(BREAK_ATTR, '')
    const td = doc.createElement('td')
    td.colSpan = 100
    td.style.cssText = `height:${heightPx}px;padding:0;border:0;background:transparent;`
    tr.appendChild(td)
    return tr
  }
  const div = doc.createElement('div')
  div.setAttribute(BREAK_ATTR, '')
  div.style.cssText = `display:block;height:${heightPx}px;margin:0;padding:0;border:0;`
  return div
}

// Insert a spacer before `node`, then correct its height once by the residual
// between where the target landed and the intended page top, so margin collapse
// and table row sizing are absorbed exactly instead of predicted.
function insertSpacer(node: Node, targetRect: () => DOMRect, containerTop: number, pageHPx: number): boolean {
  const parent = node.parentNode
  if (!parent) return false
  if (node.nodeType === Node.ELEMENT_NODE && parent.nodeType === Node.ELEMENT_NODE
      && isFlexOrGrid(getComputedStyle(parent as Element))) {
    return pushByMargin(node as HTMLElement, targetRect, containerTop, pageHPx)
  }
  const doc = node.ownerDocument ?? document
  const startTop = targetRect().top
  const h = pushHeight(startTop, containerTop, pageHPx)
  if (h <= 0.5 || h >= pageHPx) return false

  const forTag = node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName.toUpperCase() : ''
  const spacer = makeSpacer(doc, forTag, h) as HTMLElement
  parent.insertBefore(spacer, node)

  const intendedRel = (Math.floor((startTop - containerTop) / pageHPx) + 1) * pageHPx
  const actualRel   = targetRect().top - containerTop
  const residual    = intendedRel - actualRel
  if (Math.abs(residual) > 0.5) {
    const inner = forTag === 'TR' ? (spacer.firstElementChild as HTMLElement) : spacer
    const newH  = h + residual
    if (newH <= 0.5 || newH >= pageHPx * 1.5) { parent.removeChild(spacer); return false }
    inner.style.height = `${newH}px`
  }
  // wherever the correction landed is accepted; chasing it further could loop
  return true
}

// Flex/grid items are pushed through their own margin-top, since a sibling
// spacer would become an item; the row or line grows to fit, as in browser
// print. Inline !important beats author !important.
function pushByMargin(el: HTMLElement, targetRect: () => DOMRect, containerTop: number, pageHPx: number): boolean {
  const startTop = targetRect().top
  const h = pushHeight(startTop, containerTop, pageHPx)
  if (h <= 0.5 || h >= pageHPx) return false

  const stashed = el.hasAttribute(MARGIN_ATTR)
  if (!stashed) el.setAttribute(MARGIN_ATTR, el.getAttribute('style') ?? '')
  const base  = parseFloat(getComputedStyle(el).marginTop) || 0
  const apply = (px: number) => el.style.setProperty('margin-top', `${px}px`, 'important')
  apply(base + h)

  // an item that does not move at all would re-trigger until the fix cap
  if (targetRect().top - startTop < 0.5) {
    if (stashed) apply(base)
    else restoreStyle(el)
    return false
  }
  const intendedRel = (Math.floor((startTop - containerTop) / pageHPx) + 1) * pageHPx
  const residual    = intendedRel - (targetRect().top - containerTop)
  if (Math.abs(residual) > 0.5) apply(base + h + residual)
  return true
}

// Put back through the attribute, not cssText, so the caller's own
// serialization survives; an element that had no style attribute gets none.
function restoreStyle(el: Element): void {
  const original = el.getAttribute(MARGIN_ATTR) ?? ''
  el.removeAttribute(MARGIN_ATTR)
  if (original) { el.setAttribute('style', original); return }
  // Chrome serializes the style attribute lazily: removing it while the inline
  // style is still dirty leaves an empty style="" behind, so read it first
  el.getAttribute('style')
  el.removeAttribute('style')
}

// Repeats the table's <thead> rows above a <tr> just pushed to a page top, as
// browsers do in print. Clones are plain <tr> siblings: a real <thead> or
// table-header-group would be hoisted to the table's top (CSS 2.1 §17.5.2).
function repeatThead(tr: Element): void {
  if (tr.closest('thead')) return // a header row must not repeat above itself
  const table = tr.closest('table')
  if (!table) return
  const thead = table.querySelector<HTMLTableSectionElement>(':scope > thead')
  if (!thead || !thead.rows.length) return
  const parent = tr.parentNode
  if (!parent) return
  const frag = tr.ownerDocument.createDocumentFragment()
  for (const row of Array.from(thead.rows)) {
    const clone = row.cloneNode(true) as HTMLElement
    clone.setAttribute(BREAK_ATTR, '')
    frag.appendChild(clone)
  }
  parent.insertBefore(frag, tr)
}

function crossesBoundary(rect: DOMRect, containerTop: number, pageHPx: number): boolean {
  if (rect.height <= 0.5 || rect.height >= pageHPx) return false
  const topRel = rect.top - containerTop
  const botRel = rect.bottom - containerTop
  // 0.5px tolerance: sub-pixel rounding at an exact boundary is not a violation
  return Math.floor((topRel + 0.5) / pageHPx) !== Math.floor((botRel - 0.5) / pageHPx)
}

// symmetric about the boundary: a push can land a hair short of it
function atPageTop(rect: DOMRect, containerTop: number, pageHPx: number): boolean {
  const rel = (rect.top - containerTop) % pageHPx
  return rel < 1 || rel > pageHPx - 1
}

// The topmost violation in the container, or null when clean. Only the first
// one matters per iteration: fixing it reflows everything below it.
function findViolation(
  root: HTMLElement, containerTop: number, pageHPx: number, skip: Set<Node>,
): Violation | null {
  let best: Violation | null = null
  const consider = (top: number, fix: () => boolean, node: Node) => {
    if (skip.has(node)) return
    if (best === null || top < best.top - 0.5) {
      best = { top, fix: () => { const ok = fix(); if (!ok) skip.add(node); return ok } }
    }
  }

  const walkEl = (el: Element): void => {
    const cs = getComputedStyle(el)
    // the root is itself out of flow (createHiddenContainer, previewHTML),
    // so the out-of-flow skip applies to descendants only
    if (el !== root) {
      if (cs.display === 'none' || isOutOfFlow(cs)) return
      if (el.hasAttribute(BREAK_ATTR)) return
    }

    const rect = el.getBoundingClientRect()

    if (wantsBreakBefore(cs) && rect.height > 0 && !atPageTop(rect, containerTop, pageHPx)) {
      consider(rect.top, () => insertSpacer(el, () => el.getBoundingClientRect(), containerTop, pageHPx), el)
    }

    if (wantsBreakAfter(cs)) {
      let sib = el.nextElementSibling
      while (sib && (sib.hasAttribute(BREAK_ATTR) || getComputedStyle(sib).display === 'none')) sib = sib.nextElementSibling
      if (sib) {
        const sr = sib.getBoundingClientRect()
        const target = sib
        if (sr.height > 0 && !atPageTop(sr, containerTop, pageHPx)) {
          consider(sr.top, () => insertSpacer(target, () => target.getBoundingClientRect(), containerTop, pageHPx), target)
        }
      }
    }

    if (isAtomic(el, cs)) {
      if (crossesBoundary(rect, containerTop, pageHPx) && !skip.has(el)) {
        const isRow = el.tagName.toUpperCase() === 'TR'
        const fix = () => {
          const ok = insertSpacer(el, () => el.getBoundingClientRect(), containerTop, pageHPx)
          if (ok && isRow) repeatThead(el)
          return ok
        }
        consider(rect.top, fix, el)
        // pushed whole, so the interior is never split
        return
      }
      // too tall to move whole, or unmovable: the walk continues into it so
      // what is inside is still protected, as browser print does
      if (REPLACED_TAGS.has(el.tagName.toUpperCase())) return
    }

    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        walkEl(child as Element)
      } else if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').trim()) {
        walkText(child as Text)
      }
    }
  }

  const walkText = (textNode: Text): void => {
    const range = textNode.ownerDocument.createRange()
    range.selectNodeContents(textNode)
    const rects = Array.from(range.getClientRects()).filter(r => r.height > 0.5 && r.width > 0.1)
    for (const r of rects) {
      if (!crossesBoundary(r, containerTop, pageHPx)) continue
      const lineTop = r.top
      consider(lineTop, () => fixTextLineWithOrphansWidows(textNode, lineTop, containerTop, pageHPx), textNode)
      break
    }
  }

  walkEl(root)
  return best
}

// Split the text node where the crossing line starts and push that line to the
// next page top; the line already starts at a wrap point, so wrapping survives.
function fixTextLine(textNode: Text, lineTop: number, containerTop: number, pageHPx: number): boolean {
  const doc   = textNode.ownerDocument
  const range = doc.createRange()
  const len   = textNode.length
  let splitAt = -1
  for (let i = 0; i < len; i++) {
    range.setStart(textNode, i)
    range.setEnd(textNode, i + 1)
    const cr = range.getBoundingClientRect()
    if (cr.height <= 0.5 && cr.width <= 0.1) continue
    if (cr.top >= lineTop - 1) { splitAt = i; break }
  }
  if (splitAt < 0) return false

  const parent = textNode.parentNode
  if (!parent) return false
  // text directly inside a grid or flex row is an anonymous item nothing can
  // push; it is left where it is rather than split for no gain
  if (parent.nodeType === Node.ELEMENT_NODE && !siblingSpacerMoves(parent as Element)) return false

  let target: Node = textNode
  if (splitAt > 0) target = textNode.splitText(splitAt)

  // a div is invalid in inline context; a block span behaves identically
  const block = doc.createElement('span')
  block.setAttribute(BREAK_ATTR, '')
  block.style.cssText = 'display:block;height:1px;margin:0;padding:0;border:0;'
  parent.insertBefore(block, target)

  const rectOf = () => {
    const r2 = doc.createRange()
    r2.setStart(target, 0)
    r2.setEnd(target, Math.min(1, (target as Text).length))
    return r2.getBoundingClientRect()
  }
  const startTop = rectOf().top
  const h = pushHeight(startTop, containerTop, pageHPx)
  if (h <= 0.5 || h >= pageHPx) { parent.removeChild(block); return false }
  block.style.height = `${h}px`

  const intendedRel = (Math.floor((startTop - containerTop) / pageHPx) + 1) * pageHPx
  const residual    = intendedRel - (rectOf().top - containerTop)
  if (Math.abs(residual) > 0.5) {
    const newH = h + residual
    if (newH <= 0.5 || newH >= pageHPx * 1.5) { parent.removeChild(block); return false }
    block.style.height = `${newH}px`
  }
  return true
}

// The nearest ancestor whose own rendering produces the line boxes that
// orphans/widows apply to, not merely the nearest block.
function findLineBlock(node: Node): Element | null {
  let el = node.parentElement
  while (el) {
    const d = getComputedStyle(el).display
    if (d === 'block' || d === 'list-item' || d === 'table-cell' || d === 'flow-root') return el
    el = el.parentElement
  }
  return null
}

// fixTextLine's per-character scan across every text node in `block`: the
// orphans/widows-adjusted split line can sit in a different text node than the
// one that reported the crossing (a paragraph split across a <b> boundary).
function fixLineAcrossBlock(block: Element, targetTop: number, containerTop: number, pageHPx: number): boolean {
  const doc     = block.ownerDocument
  const walker  = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT)
  const range   = doc.createRange()
  let node: Node | null
  while ((node = walker.nextNode())) {
    const text = node as Text
    for (let i = 0; i < text.length; i++) {
      range.setStart(text, i)
      range.setEnd(text, i + 1)
      const cr = range.getBoundingClientRect()
      if (cr.height <= 0.5 && cr.width <= 0.1) continue
      if (cr.top >= targetTop - 1) return fixTextLine(text, targetTop, containerTop, pageHPx)
    }
  }
  return false
}

// Enforces the block's orphans/widows around fixTextLine: the split may have to
// move earlier than the first crossing line, or, when orphans can't be
// satisfied at all, the whole block is pushed through the atomic path instead.
function fixTextLineWithOrphansWidows(textNode: Text, lineTop: number, containerTop: number, pageHPx: number): boolean {
  const block = findLineBlock(textNode)
  if (!block) return fixTextLine(textNode, lineTop, containerTop, pageHPx)

  const cs      = getComputedStyle(block)
  const orphans = parseInt((cs as any).orphans, 10) || 2
  const widows  = parseInt((cs as any).widows, 10) || 2
  // CSS defaults both to 2, so the full path is the common case; it runs once
  // per crossing line, not per line
  if (orphans <= 1 && widows <= 1) return fixTextLine(textNode, lineTop, containerTop, pageHPx)

  const doc = textNode.ownerDocument
  const blockRange = doc.createRange()
  blockRange.selectNodeContents(block)
  const lineRects = Array.from(blockRange.getClientRects()).filter(r => r.height > 0.5 && r.width > 0.1)
  if (!lineRects.length) return fixTextLine(textNode, lineTop, containerTop, pageHPx)

  const N = lineRects.length
  const K = lineRects.findIndex(r => Math.abs(r.top - lineTop) < 1)
  if (K < 0) return fixTextLine(textNode, lineTop, containerTop, pageHPx) // defensive

  if (K < orphans) {
    // too few lines would stay behind for orphans; push the whole block instead
    return insertSpacer(block, () => block.getBoundingClientRect(), containerTop, pageHPx)
  }

  const splitIdx = (N - K < widows) ? Math.max(orphans, N - widows) : K
  if (splitIdx === K) return fixTextLine(textNode, lineTop, containerTop, pageHPx)

  return fixLineAcrossBlock(block, lineRects[splitIdx]!.top, containerTop, pageHPx)
}

const BREAK_PROPS = /break-(?:before|after|inside)/

// The app's own stylesheets apply to templates too, so a forced break can come from them.
// An unreadable (cross-origin) sheet might hold one.
function sheetsMightBreak(doc: Document): boolean {
  return Array.from(doc.styleSheets).some(sheet => {
    try { return Array.from(sheet.cssRules).some(rule => BREAK_PROPS.test(rule.cssText)) } catch { return true }
  })
}

export function applyPageBreaks(root: HTMLElement, pageHPx: number): void {
  if (pageHPx <= 0) return
  // single-page content can't overflow a boundary, but break-before/after/inside
  // can force one on short content. A substring check is far cheaper than a
  // getComputedStyle walk, and CSS scoping never rewrites property names.
  const short = root.scrollHeight <= pageHPx + 0.5
  if (short && !BREAK_PROPS.test(root.innerHTML) && !sheetsMightBreak(root.ownerDocument)) return

  const skip = new Set<Node>()
  for (let i = 0; i < MAX_FIXES; i++) {
    const containerTop = root.getBoundingClientRect().top
    const violation = findViolation(root, containerTop, pageHPx, skip)
    if (!violation) return
    violation.fix()
  }
  console.warn('[daepdf] Page-break pass hit the fix cap – layout may still contain cut content.')
}

export function undoPageBreaks(root: HTMLElement): void {
  const spacers = root.querySelectorAll(`[${BREAK_ATTR}]`)
  const parents = new Set<Node>()
  for (const sp of Array.from(spacers)) {
    if (sp.parentNode) parents.add(sp.parentNode)
    sp.remove()
  }
  // re-merge the text nodes fixTextLine split
  for (const p of parents) p.normalize()

  for (const el of Array.from(root.querySelectorAll(`[${MARGIN_ATTR}]`))) restoreStyle(el)
}
