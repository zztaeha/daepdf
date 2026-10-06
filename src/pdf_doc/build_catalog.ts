import type { InternalCtx } from './types.js'
import { hpf, toPdfName, bytesToHex, textStringBytes } from './utils.js'
import { deflate } from './deflate.js'
import pkg from '../../package.json'

function putOutline(ctx: InternalCtx): number | null {
  if (!ctx.bookmarks.length) return null

  const bms   = ctx.bookmarks
  const n     = bms.length
  const fmtH  = ctx.formatH
  const NO    = -1

  const parent:     number[] = new Array(n).fill(NO)
  const prevSib:    number[] = new Array(n).fill(NO)
  const nextSib:    number[] = new Array(n).fill(NO)
  const firstChild: number[] = new Array(n).fill(NO)
  const lastChild:  number[] = new Array(n).fill(NO)
  const ancestry:   number[] = []

  for (const [i, bm] of bms.entries()) {
    // A level that skips one (an h1 followed by an h3) has no parent to attach
    // to. Falling through to top level orphaned it: `par` became NO while
    // `prevSib` still read the skipped level's own chain, so nothing linked it
    // into the sibling list and readers walking /First then /Next never saw it,
    // even though the object was written and counted. Anchor it one below the
    // deepest ancestor that actually exists instead.
    let level = bm.level
    while (level > 0 && (level - 1 >= ancestry.length || ancestry[level - 1] === NO)) level--
    while (ancestry.length <= level) ancestry.push(NO)
    for (let l = level + 1; l < ancestry.length; l++) ancestry[l] = NO

    const par = level === 0 ? NO : ancestry[level - 1]!
    const prv = ancestry[level]!
    parent[i]  = par
    prevSib[i] = prv
    if (prv !== NO) nextSib[prv] = i
    if (par !== NO) {
      if (firstChild[par] === NO) firstChild[par] = i
      lastChild[par] = i
    }
    ancestry[level] = i
  }

  const topFirst = [...Array(n).keys()].find(i => parent[i] === NO) ?? NO
  const topLast  = [...Array(n).keys()].reverse().find(i => parent[i] === NO) ?? NO
  const topCount = [...Array(n).keys()].filter(i => parent[i] === NO).length

  // Per spec (ISO 32000-1 Table 153), a negative /Count's magnitude is the
  // descendant count at ALL levels below the entry, not just direct
  // children — a bookmark list is always built in document/depth-first
  // order, so every child has a strictly higher index than its parent,
  // meaning a single backward pass already has each node's own total fully
  // accumulated before it's folded into its parent's.
  const totalDescendants: number[] = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    const par = parent[i]!
    if (par !== NO) totalDescendants[par] = totalDescendants[par]! + 1 + totalDescendants[i]!
  }

  const rootId  = ctx.newObjectDeferred()
  const objIds  = Array.from({ length: n }, () => ctx.newObjectDeferred())

  for (const [i, bm] of bms.entries()) {
    const pg     = Math.min(Math.max(0, bm.page - 1), ctx.pageObjIds.length - 1)
    const pgRef  = ctx.pageObjIds[pg] ?? 0
    const yPdf   = fmtH - bm.y
    const parRef = parent[i] === NO ? `${rootId} 0 R` : `${objIds[parent[i]!]} 0 R`

    ctx.newObjectDeferredBegin(objIds[i]!)
    const titleLit = ctx.strLit(bm.title)
    ctx.out('<<')
    ctx.out(`/Title ${titleLit}`)
    ctx.out(`/Parent ${parRef}`)
    if (prevSib[i] !== NO) ctx.out(`/Prev ${objIds[prevSib[i]!]} 0 R`)
    if (nextSib[i] !== NO) ctx.out(`/Next ${objIds[nextSib[i]!]} 0 R`)
    if (firstChild[i] !== NO) {
      ctx.out(`/First ${objIds[firstChild[i]!]} 0 R`)
      ctx.out(`/Last ${objIds[lastChild[i]!]} 0 R`)
      ctx.out(`/Count -${totalDescendants[i]}`)
    } else {
      ctx.out('/Count 0')
    }
    ctx.out(`/Dest [${pgRef} 0 R /XYZ null ${hpf(yPdf)} null]`)
    ctx.out('>>')
    ctx.out('endobj')
  }

  ctx.newObjectDeferredBegin(rootId)
  ctx.out('<<')
  ctx.out('/Type /Outlines')
  if (topFirst !== NO) {
    ctx.out(`/First ${objIds[topFirst]!} 0 R`)
    ctx.out(`/Last ${objIds[topLast]!} 0 R`)
  }
  ctx.out(`/Count ${topCount}`)
  ctx.out('>>')
  ctx.out('endobj')
  return rootId
}

export function putCatalog(
  ctx:             InternalCtx,
  structTreeRootId: number | null,
  conformance:      { outputIntentId: number | null; metadataId: number } | null,
): number {
  const infoId = ctx.newObject()
  ctx.out('<<')
  ctx.out(`/Producer ${ctx.strLit(`daepdf ${pkg.version}`)}`)
  ctx.out(`/CreationDate ${ctx.strLit(ctx.creationDate)}`)
  // the document language is a catalog entry, not document information
  for (const [k, v] of ctx.metadata) if (k !== 'Lang') ctx.out(`/${toPdfName(k)} ${ctx.strLit(v)}`)
  ctx.out('>>')
  ctx.out('endobj')

  let namesObjId: number | null = null
  if (ctx.namedDests.length) {
    const oid = ctx.newObjectDeferred()
    // a name tree's keys must be sorted, by their bytes as written; readers binary-search them
    const key = (s: string) => textStringBytes(s)
    const byKey = (a: Uint8Array, b: Uint8Array) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!
      return a.length - b.length
    }
    const sorted = [...ctx.namedDests].sort((a, b) => byKey(key(a[0]), key(b[0])))
    const pairs = sorted.map(([name, page, y]) => {
      const pg  = Math.min(Math.max(0, page - 1), ctx.pageObjIds.length - 1)
      const ref = ctx.pageObjIds[pg] ?? 0
      const yp  = ctx.formatH - y
      return `${ctx.strLit(name)} [${ref} 0 R /XYZ null ${hpf(yp)} null]`
    })
    ctx.newObjectDeferredBegin(oid)
    ctx.out('<<')
    ctx.out('/Type /Names')
    ctx.out(`/Names [${pairs.join(' ')}]`)
    ctx.out('>>')
    ctx.out('endobj')
    namesObjId = oid
  }

  const outlineId = putOutline(ctx)
  const rootId    = ctx.rootDictObjId

  ctx.newObject()
  ctx.out('<<')
  ctx.out('/Type /Catalog')
  ctx.out(`/Pages ${rootId} 0 R`)
  ctx.out(`/OpenAction [${ctx.pageObjIds[0]} 0 R /FitH null]`)
  ctx.out('/PageLayout /OneColumn')
  if (namesObjId !== null) ctx.out(`/Names << /Dests ${namesObjId} 0 R >>`)
  if (outlineId !== null) {
    ctx.out(`/Outlines ${outlineId} 0 R`)
    ctx.out('/PageMode /UseOutlines')
  }
  // D3: /MarkInfo announces a tagged document; /StructTreeRoot is absent
  // when there was nothing taggable at all (putStructTree returns null),
  // even though taggedPdf was requested — an empty-but-marked document
  // would be a stranger result than just not claiming to be tagged
  if (structTreeRootId !== null) {
    ctx.out('/MarkInfo << /Marked true >>')
    ctx.out(`/StructTreeRoot ${structTreeRootId} 0 R`)
  }
  // PDF/A and PDF/UA want a document language even when the caller never set one
  const lang = ctx.metadata.find(([k]) => k === 'Lang')?.[1] ?? (ctx.pdfA || ctx.pdfUA ? ctx.pdfaLang ?? 'en-US' : undefined)
  if (lang) ctx.out(`/Lang ${ctx.strLit(lang)}`)
  // AES-256 (R6) is PDF 2.0, or 1.7 with Adobe extension level 8
  if (ctx.security) ctx.out('/Extensions << /ADBE << /BaseVersion /1.7 /ExtensionLevel 8 >> >>')
  if (conformance) {
    ctx.out(`/Metadata ${conformance.metadataId} 0 R`)
    if (conformance.outputIntentId !== null) ctx.out(`/OutputIntents [${conformance.outputIntentId} 0 R]`)
  }
  // PDF/UA: viewers show the document's title, not its file name
  if (ctx.pdfUA) ctx.out('/ViewerPreferences << /DisplayDocTitle true >>')
  // D1 (AcroForm): /DR reuses the SAME resource dict every page already
  // shares (an indirect resource-dictionary reference is spec-legal, PDF
  // 32000-1 Table 218) rather than duplicating font entries into a second
  // one. /NeedAppearances is explicitly false — real appearance streams
  // were generated for every field (add_form_field), so no viewer needs to
  // synthesize its own.
  if (ctx.formFieldObjIds.length) {
    ctx.out(`/AcroForm << /Fields [${ctx.formFieldObjIds.map(id => `${id} 0 R`).join(' ')}] /DR ${ctx.resourceDictObjId} 0 R /NeedAppearances false >>`)
  }
  ctx.out('>>')
  ctx.out('endobj')
  return infoId
}

export function putEncryptDict(ctx: InternalCtx): number | null {
  if (!ctx.security) return null
  const oid = ctx.newObject()
  ctx.out('<<')
  ctx.out('/Filter /Standard')
  ctx.out('/V 5')
  ctx.out('/R 6')
  ctx.out('/Length 256')
  ctx.out('/CF << /StdCF << /CFM /AESV3 /AuthEvent /DocOpen /Length 32 >> >>')
  ctx.out('/StmF /StdCF')
  ctx.out('/StrF /StdCF')
  ctx.out(`/O <${bytesToHex(ctx.security.o)}>`)
  ctx.out(`/U <${bytesToHex(ctx.security.u)}>`)
  ctx.out(`/OE <${bytesToHex(ctx.security.oe)}>`)
  ctx.out(`/UE <${bytesToHex(ctx.security.ue)}>`)
  ctx.out(`/Perms <${bytesToHex(ctx.security.perms)}>`)
  ctx.out(`/P ${ctx.security.permissions | 0}`)
  ctx.out('>>')
  ctx.out('endobj')
  return oid
}

export function buildXrefStream(ctx: InternalCtx, catalogId: number, encryptId: number | null, infoId: number): void {
  const xrefOffset = ctx.byteLen
  const xrefObjId  = ctx.objectNumber + 1
  const total      = xrefObjId + 1

  const stmMap = new Map<number, [number, number]>()
  for (const [oid, stmId, idx] of ctx.objStmMembers) stmMap.set(oid, [stmId, idx])

  const raw = new Uint8Array(total * 7)
  raw[5] = 0xFF; raw[6] = 0xFF

  for (let i = 1; i <= xrefObjId; i++) {
    const b = i * 7
    if (i === xrefObjId) {
      raw[b] = 1
      raw[b+1] = (xrefOffset >>> 24) & 0xFF; raw[b+2] = (xrefOffset >>> 16) & 0xFF
      raw[b+3] = (xrefOffset >>>  8) & 0xFF; raw[b+4] =  xrefOffset         & 0xFF
    } else if (stmMap.has(i)) {
      const [stmId, idx] = stmMap.get(i)!
      raw[b] = 2
      raw[b+1] = (stmId >>> 24) & 0xFF; raw[b+2] = (stmId >>> 16) & 0xFF
      raw[b+3] = (stmId >>>  8) & 0xFF; raw[b+4] =  stmId         & 0xFF
      raw[b+5] = (idx   >>>  8) & 0xFF; raw[b+6] =  idx            & 0xFF
    } else if (i < ctx.offsets.length) {
      const off = ctx.offsets[i]
      if (off && off !== Number.MAX_SAFE_INTEGER) {
        raw[b] = 1
        raw[b+1] = (off >>> 24) & 0xFF; raw[b+2] = (off >>> 16) & 0xFF
        raw[b+3] = (off >>>  8) & 0xFF; raw[b+4] =  off         & 0xFF
      }
    }
  }

  const comp    = deflate(raw)
  const idHex   = bytesToHex(ctx.fileId)
  const encPart = encryptId !== null ? `\n/Encrypt ${encryptId} 0 R` : ''

  const header = `${xrefObjId} 0 obj\n<<\n/Type /XRef\n/Size ${total}\n/W [1 4 2]\n/Filter /FlateDecode\n/Length ${comp.length}\n/Root ${catalogId} 0 R${encPart}\n/Info ${infoId} 0 R\n/ID [<${idHex}><${idHex}>]\n>>\nstream\n`
  ctx.write(header)
  ctx.writeBytes(comp)
  ctx.write(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF`)
}
