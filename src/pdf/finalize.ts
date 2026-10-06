import type { PDFMetadata, PDFSecurity, BookmarkEntry, StructNode } from '../types/index.js'
import type { PdfDoc } from '../pdf_doc/index.js'

export function applyMetadata(doc: PdfDoc, m: PDFMetadata): void {
  if (m.title)    doc.set_metadata('Title',    m.title)
  if (m.author)   doc.set_metadata('Author',   m.author)
  if (m.subject)  doc.set_metadata('Subject',  m.subject)
  if (m.keywords) doc.set_metadata('Keywords', m.keywords.join(', '))
  if (m.creator)  doc.set_metadata('Creator',  m.creator)
  if (m.language) doc.set_metadata('Lang',     m.language)
}

export function applyBookmarks(doc: PdfDoc, bookmarks: BookmarkEntry[]): void {
  // build_catalog.ts's putOutline uses level directly as an array index
  // (ancestry[level]) — a negative, fractional, or non-finite value (a
  // plausible caller mistake, e.g. computing depth from a header level minus
  // an offset that goes negative) produces `undefined` mid-computation there,
  // which reaches the actual PDF output as a literal malformed
  // "/Parent undefined 0 R". Clamped to a non-negative integer here, once,
  // before it ever reaches that indexing logic.
  const safeLevel = (raw: number | undefined): number =>
    Number.isFinite(raw) ? Math.max(0, Math.floor(raw as number)) : 0
  for (const bm of bookmarks) doc.add_bookmark(bm.title, bm.page, bm.y ?? 0, safeLevel(bm.level))
}

const randomPassword = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('')

export function applySecurity(doc: PdfDoc, sec: PDFSecurity): void {
  const p = sec.permissions
  // all bits 1 except bits 1-2 (always reserved/0) — the P field's bit
  // layout is unchanged across every standard security handler revision
  // (R2 through R6), so this holds as-is after D2 replaced R3 with R6
  let perm = 0xFFFFFFFC
  if (p?.print     === false) perm &= ~0x4
  if (p?.modify    === false) perm &= ~0x8
  if (p?.copy      === false) perm &= ~0x10
  if (p?.annotate  === false) perm &= ~0x20
  if (p?.fillForms === false) perm &= ~0x100
  // an empty owner password opens the file with full rights, which undoes every restriction
  doc.set_security(sec.userPassword ?? '', sec.ownerPassword ?? randomPassword(), perm >>> 0)
}

export function applyStructTree(doc: PdfDoc, structRoot: StructNode): void {
  doc.set_struct_tree(structRoot)
}

// PDF/A-2a: builds on the tag tree (already applied above when `taggedPdf`
// is set — renderHTMLtoPDF always turns it on when `pdfA` is requested).
// Passes through the document language (XMP wants it too) — everything
// else PDF/A needs (XMP packet, sRGB OutputIntent, the ISO 32000-2 flags)
// is self-contained in pdf_doc, since none of it depends on caller input.
export function applyPdfA(doc: PdfDoc, metadata: PDFMetadata | undefined): void {
  doc.set_pdfa(metadata?.language)
}

// PDF/UA-1: identification and DisplayDocTitle; the structure itself is taggedPdf's
export function applyPdfUA(doc: PdfDoc, metadata: PDFMetadata | undefined): void {
  doc.set_pdfua(metadata?.language)
}

export function resolveSecurityConfig(security: PDFSecurity | null | undefined): PDFSecurity | null {
  if (security === undefined) {
    return {
      userPassword:  '',
      ownerPassword: randomPassword(),
      permissions: { print: true, copy: true, modify: false, annotate: false, fillForms: false },
    }
  }
  return security
}
