import { initEngine, triggerDownload, safeName } from './engine.js'
import { renderHTMLtoPDF } from './src/index.js'
import type { PageSize, PDFSecurity, PDFMetadata, BookmarkEntry } from './src/types/index.js'

export type SecurityPreset = 'read-only' | 'printable' | 'fillable' | 'locked' | 'open'
export type SecurityOption = SecurityPreset | PDFSecurity | null

export interface RenderExtras {
  metadata?:    PDFMetadata
  bookmarks?:   BookmarkEntry[]
  orientation?: 'portrait' | 'landscape' | undefined
  header?:      (page: number, totalPages: number) => string
  footer?:      (page: number, totalPages: number) => string
  taggedPdf?:   boolean | undefined
  pdfA?:        boolean | undefined
  pdfUA?:       boolean | undefined
}

// Escapes a string for safe interpolation into HTML text content or a
// quoted attribute value. & must go first, or the literal & introduced by
// escaping <, >, ", ' below would itself get re-escaped.
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function randomOwnerPassword(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
}

function resolveSecurityOption(opt: SecurityOption | undefined): PDFSecurity | null | undefined {
  if (opt === undefined || opt === null || typeof opt === 'object') return opt
  if (opt === 'open') return null
  const base: PDFSecurity = {
    userPassword:  '',
    ownerPassword: randomOwnerPassword(),
    permissions:   { print: true, copy: true, modify: false, annotate: false, fillForms: false },
  }
  if (opt === 'fillable') return { ...base, permissions: { ...base.permissions, fillForms: true } }
  if (opt === 'locked')   return { ...base, permissions: { print: false, copy: false, modify: false, annotate: false, fillForms: false } }
  return base // 'read-only' | 'printable'
}

const pdf = {
  warmup(): Promise<void> {
    return initEngine()
  },

  async render(html: string, size: PageSize = 'A4', security?: SecurityOption, extras: RenderExtras = {}): Promise<Uint8Array> {
    return renderHTMLtoPDF(html, { size, orientation: extras.orientation }, {
      security:  resolveSecurityOption(security),
      metadata:  extras.metadata,
      bookmarks: extras.bookmarks,
      header:    extras.header,
      footer:    extras.footer,
      taggedPdf: extras.taggedPdf,
      pdfA:      extras.pdfA,
      pdfUA:     extras.pdfUA,
    })
  },

  async download(html: string, size: PageSize = 'A4', filename: string, security?: SecurityOption, extras: RenderExtras = {}): Promise<void> {
    const bytes = await this.render(html, size, security, extras)
    triggerDownload(bytes, filename)
  },

  name: safeName,
}

export default pdf
export { previewHTML, renderHTMLtoPDF } from './src/index.js'
export type { PageSize, PageConfig, PDFSecurity, PDFMetadata, BookmarkEntry } from './src/types/index.js'
// Named explicitly because they appear in renderHTMLtoPDF's signature: a caller typing its
// own options object needs them, and only what this file names reaches the bundled .d.ts.
export type { FontBridgeMap, HTMLToPDFOptions } from './src/html/index.js'
