import type { InternalCtx } from './types.js'
import { buildSRGBProfile } from './icc.js'
import pkg from '../../package.json'

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// PDF/A wants a custom XMP property declared through an extension schema; PDF/UA's
// pdfuaid is not one of the predefined ones, so it is declared when both are claimed
const PDFUA_EXTENSION_SCHEMA = `<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/" xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">
<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">
<pdfaSchema:schema>PDF/UA Universal Accessibility Schema</pdfaSchema:schema>
<pdfaSchema:namespaceURI>http://www.aiim.org/pdfua/ns/id/</pdfaSchema:namespaceURI>
<pdfaSchema:prefix>pdfuaid</pdfaSchema:prefix>
<pdfaSchema:property><rdf:Seq><rdf:li rdf:parseType="Resource">
<pdfaProperty:name>part</pdfaProperty:name>
<pdfaProperty:valueType>Integer</pdfaProperty:valueType>
<pdfaProperty:category>internal</pdfaProperty:category>
<pdfaProperty:description>Indicates, which part of ISO 14289 standard is followed</pdfaProperty:description>
</rdf:li></rdf:Seq></pdfaSchema:property>
</rdf:li></rdf:Bag></pdfaExtension:schemas>
</rdf:Description>
`

// D4 (PDF/A-2a), PDF/UA-1: an XMP packet declaring the parts claimed (left uncompressed so tools
// can read it), and for PDF/A an /OutputIntent embedding the sRGB profile (icc.ts)
export function putConformanceExtras(ctx: InternalCtx): { outputIntentId: number | null; metadataId: number } | null {
  if (!ctx.pdfA && !ctx.pdfUA) return null

  let outputIntentId: number | null = null
  if (ctx.pdfA) {
    const profile = buildSRGBProfile()
    const iccId = ctx.newObject()
    ctx.out('<<')
    ctx.out('/N 3')
    ctx.out(`/Length ${ctx.encryptedLength(profile.length)}`)
    ctx.out('>>')
    ctx.out('stream')
    ctx.outBytes(profile)
    ctx.out('endstream')
    ctx.out('endobj')

    outputIntentId = ctx.newObject()
    ctx.out('<<')
    ctx.out('/Type /OutputIntent')
    ctx.out('/S /GTS_PDFA1')
    ctx.out(`/OutputConditionIdentifier ${ctx.strLit('sRGB IEC61966-2.1')}`)
    ctx.out(`/Info ${ctx.strLit('sRGB IEC61966-2.1')}`)
    ctx.out(`/DestOutputProfile ${iccId} 0 R`)
    ctx.out('>>')
    ctx.out('endobj')
  }

  // PDF/A wants every Info entry mirrored in XMP, the dates as the same instant
  const lang = ctx.pdfaLang ?? 'en-US'
  const info = (key: string) => ctx.metadata.find(([k]) => k === key)?.[1]
  const alt  = (v: string) => `<rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(v)}</rdf:li></rdf:Alt>`
  const title = info('Title'), author = info('Author'), subject = info('Subject')
  const keywords = info('Keywords'), creator = info('Creator')
  const infoXml = [
    title    ? `<dc:title>${alt(title)}</dc:title>` : '',
    author   ? `<dc:creator><rdf:Seq><rdf:li>${xmlEscape(author)}</rdf:li></rdf:Seq></dc:creator>` : '',
    subject  ? `<dc:description>${alt(subject)}</dc:description>` : '',
    keywords ? `<pdf:Keywords>${xmlEscape(keywords)}</pdf:Keywords>` : '',
    creator  ? `<xmp:CreatorTool>${xmlEscape(creator)}</xmp:CreatorTool>` : '',
  ].join('')
  const created = ctx.creationDate.replace(/^D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)([+-])(\d\d)'(\d\d)'$/, '$1-$2-$3T$4:$5:$6$7$8:$9')

  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
${ctx.pdfA && ctx.pdfUA ? PDFUA_EXTENSION_SCHEMA : ''}<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
${infoXml}<dc:language><rdf:Bag><rdf:li>${xmlEscape(lang)}</rdf:li></rdf:Bag></dc:language>
<pdf:Producer>${xmlEscape(`daepdf ${pkg.version}`)}</pdf:Producer>
<xmp:CreateDate>${created}</xmp:CreateDate>
${ctx.pdfA ? '<pdfaid:part>2</pdfaid:part>\n<pdfaid:conformance>A</pdfaid:conformance>\n' : ''}${ctx.pdfUA ? '<pdfuaid:part>1</pdfuaid:part>\n' : ''}</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`

  const xmpBytes = new TextEncoder().encode(xmp)
  const metadataId = ctx.newObject()
  ctx.out('<<')
  ctx.out('/Type /Metadata')
  ctx.out('/Subtype /XML')
  ctx.out(`/Length ${ctx.encryptedLength(xmpBytes.length)}`)
  ctx.out('>>')
  ctx.out('stream')
  ctx.outBytes(xmpBytes)
  ctx.out('endstream')
  ctx.out('endobj')

  return { outputIntentId, metadataId }
}
