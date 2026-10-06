import type { InternalCtx, PageAnnot } from './types.js'
import { hpf, _te, uriString } from './utils.js'
import { deflate } from './deflate.js'

// annotation flag Print (ISO 32000-1 table 165): without it a field's value is left out
// of print, and PDF/A requires it on every annotation
const ANNOT_PRINT = 4

// A tagged annotation's key into the ParentTree, numbered after the pages' own keys
function putStructParent(ctx: InternalCtx, oid: number, ann: PageAnnot): void {
  if (ann.structAnnot === undefined || !ctx.structRoot) return
  const key = ctx.allPageBufs.length + ctx.annotStructs.size
  ctx.annotStructs.set(ann.structAnnot, { oid, key })
  ctx.out(`/StructParent ${key}`)
}

function putCompressedStream(ctx: InternalCtx, data: Uint8Array): void {
  const comp = deflate(data)
  ctx.out('<<')
  ctx.out(`/Length ${ctx.encryptedLength(comp.length)}`)
  ctx.out('/Filter /FlateDecode')
  ctx.out('>>')
  ctx.out('stream')
  ctx.outBytes(comp)
  ctx.out('endstream')
}

// D1 (AcroForm): one Form XObject per appearance STATE (Tx/Ch always have
// exactly one — "on" doubles as the only state; Btn has two, on/off).
// Left uncompressed (unlike page content) — these are typically tiny
// (a few Tj/path operators), not worth FlateDecode's own per-stream
// overhead, and easier to eyeball in a hex/text dump while this feature
// was being verified.
function putAppearanceStream(ctx: InternalCtx, w: number, h: number, body: string): number {
  const oid = ctx.newObject()
  const bytes = _te.encode(body)
  ctx.out('<<')
  ctx.out('/Type /XObject')
  ctx.out('/Subtype /Form')
  ctx.out('/FormType 1')
  ctx.out(`/BBox [0 0 ${hpf(w)} ${hpf(h)}]`)
  ctx.out(`/Resources ${ctx.resourceDictObjId} 0 R`)
  ctx.out(`/Length ${ctx.encryptedLength(bytes.length)}`)
  ctx.out('>>')
  ctx.out('stream')
  ctx.outBytes(bytes)
  ctx.out('endstream')
  ctx.out('endobj')
  return oid
}

// AP object(s) must be FULLY written (their own separate obj...endobj) before
// the widget's own obj/endobj starts — object bodies are plain sequential
// bytes in the file, so building one object's obj...endobj block WHILE
// another is still open would interleave and corrupt both.
function putFieldWidget(
  ctx: InternalCtx, oid: number, pageObjId: number, ann: PageAnnot,
  apIds: { onId: number; offId?: number | undefined },
): void {
  ctx.newObjectDeferredBegin(oid)
  ctx.out('<<')
  ctx.out('/Type /Annot')
  ctx.out('/Subtype /Widget')
  ctx.out(`/F ${ANNOT_PRINT}`)
  putStructParent(ctx, oid, ann)
  ctx.out(`/FT /${ann.fieldType}`)
  ctx.out(`/T ${ctx.strLit(ann.fieldName ?? '')}`)
  if (ctx.structRoot && ann.tooltip) ctx.out(`/TU ${ctx.strLit(ann.tooltip)}`)
  ctx.out(`/P ${pageObjId} 0 R`)
  ctx.out(`/Rect [${hpf(ann.rect[0])} ${hpf(ann.rect[1])} ${hpf(ann.rect[2])} ${hpf(ann.rect[3])}]`)
  ctx.out('/Border [0 0 0]')
  if (ann.fieldDA) ctx.out(`/DA ${ctx.strLit(ann.fieldDA)}`)
  if (ann.fieldFlags) ctx.out(`/Ff ${ann.fieldFlags}`)

  if (ann.fieldType === 'Btn') {
    ctx.out(`/AP << /N << /On ${apIds.onId} 0 R /Off ${apIds.offId} 0 R >> >>`)
    ctx.out(`/AS /${ann.fieldChecked ? 'On' : 'Off'}`)
    ctx.out(`/V /${ann.fieldChecked ? 'On' : 'Off'}`)
  } else {
    ctx.out(`/AP << /N ${apIds.onId} 0 R >>`)
    ctx.out(`/V ${ctx.strLit(ann.fieldValue ?? '')}`)
    if (ann.fieldType === 'Ch' && ann.fieldOptions) {
      // [export display] pairs when an option's value differs from what it shows
      const ev = ann.fieldExportValues
      const opt = ann.fieldOptions.map((o, i) => ev ? `[${ctx.strLit(ev[i] ?? o)} ${ctx.strLit(o)}]` : ctx.strLit(o))
      ctx.out(`/Opt [${opt.join(' ')}]`)
    }
  }

  ctx.out('>>')
  ctx.out('endobj')
}

export function putPages(ctx: InternalCtx): void {
  const pageCount = ctx.allPageBufs.length
  const rootId    = ctx.rootDictObjId
  const resId     = ctx.resourceDictObjId
  const fmtW      = ctx.formatW
  const fmtH      = ctx.formatH

  const pageObjIds:    number[] = []
  const contentObjIds: number[] = []
  for (let i = 0; i < pageCount; i++) {
    pageObjIds.push(ctx.newObjectDeferred())
    contentObjIds.push(ctx.newObjectDeferred())
  }
  ctx.pageObjIds = pageObjIds

  const annotObjIdsList: number[][] = []
  for (let n = 0; n < pageCount; n++) {
    const annots = ctx.pageAnnots[n] ?? []
    annotObjIdsList.push(annots.map(() => ctx.newObjectDeferred()))
  }

  for (let n = 0; n < pageCount; n++) {
    const pageObjId = pageObjIds[n]!
    const contObjId = contentObjIds[n]!
    const annots    = ctx.pageAnnots[n] ?? []
    const annotIds  = annotObjIdsList[n] ?? []

    ctx.newObjectDeferredBegin(pageObjId)
    ctx.out('<</Type /Page')
    ctx.out(`/Parent ${rootId} 0 R`)
    ctx.out(`/Resources ${resId} 0 R`)
    ctx.out(`/MediaBox [0 0 ${hpf(fmtW)} ${hpf(fmtH)}]`)
    ctx.out(`/Contents ${contObjId} 0 R`)
    // D3: this page's own key into /StructTreeRoot's /ParentTree — every
    // page gets one when tagging is on, even if this specific page turns
    // out to have no tagged content of its own (an empty key is harmless
    // and keeps page-index-to-StructParents-index a fixed, simple mapping)
    if (ctx.structRoot) ctx.out(`/StructParents ${n}`)
    if (annotIds.length) {
      ctx.out(`/Annots [${annotIds.map(id => `${id} 0 R`).join(' ')}]`)
      // tagged output: tab through the annotations in structure order
      if (ctx.structRoot) ctx.out('/Tabs /S')
    }
    ctx.out('>>')
    ctx.out('endobj')

    ctx.newObjectDeferredBegin(contObjId)
    putCompressedStream(ctx, _te.encode((ctx.allPageBufs[n] ?? []).join('\n')))
    ctx.out('endobj')

    for (const [i, ann] of annots.entries()) {
      const oid = annotIds[i]!

      if (ann.fieldType) {
        const w = ann.rect[2] - ann.rect[0]
        const h = ann.rect[3] - ann.rect[1]
        // AP object(s) allocated and FULLY written before the widget's own
        // obj/endobj opens (see putFieldWidget's own note on why)
        const onId  = putAppearanceStream(ctx, w, h, ann.fieldApOn ?? '')
        const offId = ann.fieldType === 'Btn' ? putAppearanceStream(ctx, w, h, ann.fieldApOff ?? '') : undefined
        putFieldWidget(ctx, oid, pageObjId, ann, { onId, offId })
        ctx.formFieldObjIds.push(oid)
        continue
      }

      ctx.newObjectDeferredBegin(oid)
      ctx.out('<<')
      ctx.out('/Type /Annot')
      ctx.out('/Subtype /Link')
      ctx.out(`/F ${ANNOT_PRINT}`)
      putStructParent(ctx, oid, ann)
      if (ctx.structRoot && ann.contents) ctx.out(`/Contents ${ctx.strLit(ann.contents)}`)
      ctx.out(`/Rect [${hpf(ann.rect[0])} ${hpf(ann.rect[1])} ${hpf(ann.rect[2])} ${hpf(ann.rect[3])}]`)
      ctx.out('/Border [0 0 0]')
      if (ann.href !== undefined) {
        const lit = ctx.strLit(uriString(ann.href))
        ctx.out(`/A <</S /URI /URI ${lit}>>`)
      } else if (ann.destPage !== undefined) {
        const pg  = Math.min(Math.max(0, ann.destPage - 1), ctx.pageObjIds.length - 1)
        const ref = ctx.pageObjIds[pg] ?? 0
        ctx.out(`/A <</S /GoTo /D [${ref} 0 R /XYZ null ${hpf(ann.destY ?? 0)} null]>>`)
      }
      ctx.out('>>')
      ctx.out('endobj')
    }
  }

  ctx.newObjectDeferredBegin(rootId)
  ctx.out('<</Type /Pages')
  ctx.out(`/Kids [${pageObjIds.map(id => `${id} 0 R`).join(' ')}]`)
  ctx.out(`/Count ${pageCount}`)
  ctx.out('>>')
  ctx.out('endobj')
}
