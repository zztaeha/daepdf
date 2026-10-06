import type { PageConfig } from './page.js'

export interface FontRef {
  name:   string
  style:  string
  weight: number
}

export interface PDFMetadata {
  title?:    string
  author?:   string
  subject?:  string
  keywords?: string[]
  creator?:  string
  language?: string
}

export interface PDFSecurity {
  userPassword?:  string
  ownerPassword?: string
  permissions?: {
    print?:     boolean
    copy?:      boolean
    modify?:    boolean
    annotate?:  boolean
    fillForms?: boolean
  }
}

export interface BookmarkEntry {
  title:  string
  page:   number
  y?:     number
  level?: number
}

export type AnchorEntry = { page: number; y: number }

// D3 (tagged PDF): a node in the parallel structure tree the HTML walker
// builds alongside the flat DrawCommand list, consumed by
// pdf_doc/build_structtree.ts. `tag` is a PDF structure type name without
// the leading slash (H1, P, Table, Figure, Div, ...). A kid is either a
// nested StructNode or a marked-content reference into a specific page's
// content stream.
export interface StructNode {
  tag:    string
  alt?:   string
  lang?:  string
  // a TH's /Scope attribute: which cells it heads
  scope?: 'Row' | 'Column'
  kids:   StructKid[]
}
export interface McrRef { mcid: number; page: number }
// an annotation (link or form field) the element owns, by its per-capture key
export interface AnnotRef { annot: number; page: number }
export type StructKid = StructNode | McrRef | AnnotRef

export function isStructNode(k: StructKid): k is StructNode {
  return 'tag' in k
}

export function isMcrRef(k: StructKid): k is McrRef {
  return 'mcid' in k
}

export interface DocDefinition {
  config:     PageConfig
  metadata?:  PDFMetadata | undefined
  security?:  PDFSecurity | null | undefined
  bookmarks?: BookmarkEntry[] | undefined
  // PDF/A-2a: XMP metadata and an OutputIntent; the tags come from the
  // structRoot passed to applyToPDF
  pdfA?:      boolean
  // PDF/UA-1: identification, DisplayDocTitle and a required title
  pdfUA?:     boolean
}
