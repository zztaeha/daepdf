import type { Affine } from '../types/affine.js'
import type { StructNode } from '../types/index.js'
import type { ColrResources } from './colr.js'

export interface DocFont {
  id:              string
  fontName:        string
  style:           string
  weight:          number
  opsz:            number
  glyphIds:        Set<number>
  // a ligature glyph maps back to its full codepoint run ("fi" copy-pastes
  // as f + i), hence the array
  glyphToUnicode:  Map<number, number[]>
  objectNumber:    number
  // A4 (vertical writing modes): the SAME embedded glyph subset backs both
  // orientations — only the CIDFont's width array and the Type0 wrapper's
  // /Encoding differ (/W + Identity-H vs /W2+/DW2 + Identity-V) — so a
  // second, parallel Type0/CIDFont dict pair is built ONLY when this font is
  // actually used vertically, referencing the same FontDescriptor/FontFile2.
  usedVertically:        boolean
  verticalObjectNumber:  number
}

export interface EmbedImage {
  name:         string
  width:        number
  height:       number
  colorSpace:   string
  filter:       string
  data:         Uint8Array
  smask:        Uint8Array | null
  decodeInvert: boolean
  orientation:  number
  objectNumber: number
  icc?:         Uint8Array | null | undefined
}

// V5/R6 (AES-256) standard security handler fields — see crypto_r6.ts
export interface SecurityConfig {
  fileKey:     Uint8Array // 32 bytes — the actual AES-256 content-encryption key
  o:           Uint8Array // 48 bytes
  u:           Uint8Array // 48 bytes
  oe:          Uint8Array // 32 bytes
  ue:          Uint8Array // 32 bytes
  perms:       Uint8Array // 16 bytes
  permissions: number
}

export interface GradDef {
  gradType: number
  angle:    number
  cx:       number
  cy:       number
  // SVG's radial focal point (a true 0-radius inner circle) — equals cx/cy
  // for every non-SVG (CSS) gradient and every SVG one that doesn't use fx/fy
  fx:       number
  fy:       number
  // ending ellipse radii as fractions of the filled box; absent, the farthest-corner circle
  rx?:      number | undefined
  ry?:      number | undefined
  // [position, r, g, b, a] — all 0-1 normalized
  stops:    [number, number, number, number, number][]
}

export interface ShadPat {
  patName: string
  defIdx:  number
  x: number; y: number; w: number; h: number
  pageH:   number
  objId:   number
  // the CTM where it's used: a pattern lives in the page's default space, which cm doesn't move
  ctm:     Affine
}

// registered when a gradient has any stop with alpha < 1 — PDF shading
// patterns have no native alpha channel, so variable transparency needs a
// separate grayscale luminosity shading composited via an ExtGState's
// /SMask, applied right before the color shading pattern paints
export interface GradSoftMask {
  gsName: string
  defIdx: number
  x: number; y: number; w: number; h: number
  pageH:  number
  objId:  number
}

export interface Bookmark {
  title: string
  page:  number
  y:     number
  level: number
}

export interface PageAnnot {
  rect:      [number, number, number, number]
  href?:     string
  destPage?: number
  destY?:    number
  // D1 (AcroForm) — see PdfDoc.add_form_field. fieldApOn/fieldApOff are
  // already-composed content-stream bodies (built immediately, at
  // add_form_field call time, since the font registry/emission-cache state
  // they depend on is only correct THEN — not deferred rebuild material);
  // build_pages.ts just wraps each in a Form XObject object.
  fieldType?:    'Tx' | 'Btn' | 'Ch'
  fieldName?:    string
  fieldDA?:      string | undefined
  fieldValue?:   string | undefined
  fieldChecked?: boolean | undefined
  fieldOptions?: string[] | undefined
  fieldExportValues?: string[] | undefined
  fieldFlags?:   number | undefined
  fieldApOn?:    string
  fieldApOff?:   string | undefined
  // D3 (tagged PDF): the structure tree's key for this annotation (an AnnotRef)
  structAnnot?:  number | undefined
  // accessible descriptions for tagged output: a link's /Contents, a field's /TU
  contents?:     string | undefined
  tooltip?:      string | undefined
}

export interface ObjStmItem {
  oid:     number
  content: string
}

export interface InternalCtx {
  buf:               Uint8Array[]
  byteLen:           number
  objectNumber:      number
  offsets:           number[]
  fonts:             DocFont[]
  usedFonts:         Set<string>
  images:            EmbedImage[]
  gradDefs:          GradDef[]
  shadPats:          ShadPat[]
  gradSoftMasks:     GradSoftMask[]
  extGStates:        { alpha: number; blend: string }[]
  colrRes:           ColrResources
  allPageBufs:       string[][]
  pageAnnots:        PageAnnot[][]
  pageObjIds:        number[]
  rootDictObjId:     number
  resourceDictObjId: number
  security:          SecurityConfig | undefined
  fileId:            Uint8Array
  creationDate:      string
  metadata:          [string, string][]
  bookmarks:         Bookmark[]
  namedDests:        [string, number, number][]
  objStmQueue:       ObjStmItem[]
  objStmMembers:     [number, number, number][]
  formatW:           number
  formatH:           number
  structRoot:        StructNode | undefined
  pdfA:              boolean
  pdfUA:             boolean
  // the document language for the XMP packet (PDF/A, PDF/UA)
  pdfaLang:          string | undefined
  // D1 (AcroForm): filled in by build_pages.ts's putPages as it allocates
  // each field's merged Widget/Field object id, read by build_catalog.ts's
  // putCatalog for /AcroForm /Fields — same "producer writes, consumer
  // reads after" pattern as pageObjIds itself
  formFieldObjIds:   number[]
  // tagged annotations by AnnotRef key: the object and its /StructParent, set by putPages
  annotStructs:      Map<number, { oid: number; key: number }>

  write(s: string): void
  writeBytes(b: Uint8Array): void
  out(s: string): void
  outBytes(b: Uint8Array): void
  newObject(): number
  newObjectDeferred(): number
  newObjectDeferredBegin(oid: number): void
  queueForObjStm(content: string): number
  beginCapture(): void
  endCapture(): string
  strLit(s: string): string
  encBytes(data: Uint8Array): Uint8Array
  encryptedLength(plainLen: number): number
}
