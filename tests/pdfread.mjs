// A minimal PDF reader for the test suite, replacing pdf.js.
//
// It reads only what daepdf itself writes: xref streams, object streams,
// FlateDecode, AES-256 revision-6 encryption, and Identity-H text with a
// ToUnicode CMap. It is not a general PDF reader and is not trying to be.
//
// Deliberately independent of src/: it re-implements parsing from the spec
// rather than importing daepdf's writer, so a test still fails if the writer
// and the format disagree. The one thing it borrows is inflate, since
// re-implementing DEFLATE a second time would prove nothing.

import { load } from './load.mjs'

const { unzlib } = await load('src/daefl/index.ts')

const WHITE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIM = new Set('()<>[]{}/%'.split('').map(c => c.charCodeAt(0)))

class Name {
  constructor(name) { this.name = name }
  toString() { return `/${this.name}` }
}
// Tagged records rather than plain objects: the parser tells these apart with
// instanceof, which is what keeps a reference distinct from a number.
class Ref {
  constructor(num, gen) { this.num = num; this.gen = gen }
}
class PdfStream {
  constructor(dict, raw) { this.dict = dict; this.raw = raw }
}

class Lexer {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos }

  skip() {
    for (;;) {
      while (this.pos < this.buf.length && WHITE.has(this.buf[this.pos])) this.pos++
      if (this.buf[this.pos] === 0x25) {            // % comment to end of line
        while (this.pos < this.buf.length && this.buf[this.pos] !== 0x0a) this.pos++
      } else return
    }
  }

  // "12 0 obj" is three tokens; parse() would read the first as a number and
  // rewind, leaving the rest in the stream.
  skipObjHeader() {
    this.readToken()
    this.readToken()
    const kw = this.readToken()
    if (kw !== 'obj') throw new Error(`pdfread: expected obj, saw ${kw}`)
  }

  readToken() {
    this.skip()
    const start = this.pos
    while (this.pos < this.buf.length &&
           !WHITE.has(this.buf[this.pos]) && !DELIM.has(this.buf[this.pos])) this.pos++
    if (this.pos === start) this.pos++
    return this.buf.toString('latin1', start, this.pos)
  }

  parse() {
    this.skip()
    const b = this.buf[this.pos]

    if (b === 0x2f) return this.parseName()
    if (b === 0x28) return this.parseLiteralString()
    if (b === 0x5b) return this.parseArray()
    if (b === 0x3c) {
      return this.buf[this.pos + 1] === 0x3c ? this.parseDict() : this.parseHexString()
    }
    if (b === 0x5d || b === 0x3e) { this.pos++; return undefined }

    const tok = this.readToken()
    if (tok === 'true') return true
    if (tok === 'false') return false
    if (tok === 'null') return null

    if (/^[+-]?[0-9]*\.?[0-9]+$/.test(tok)) {
      // "12 0 R" is a reference; "12 0 obj" is a definition. Both start with
      // two integers, so the third token decides and is rewound if it is not
      // part of either.
      if (/^[0-9]+$/.test(tok)) {
        const save = this.pos
        this.skip()
        const p2 = this.pos
        const t2 = this.readToken()
        if (/^[0-9]+$/.test(t2)) {
          const t3 = this.readToken()
          if (t3 === 'R') return new Ref(parseInt(tok, 10), parseInt(t2, 10))
          this.pos = p2
        } else this.pos = save
      }
      return parseFloat(tok)
    }
    return { keyword: tok }
  }

  parseName() {
    this.pos++
    let out = ''
    while (this.pos < this.buf.length &&
           !WHITE.has(this.buf[this.pos]) && !DELIM.has(this.buf[this.pos])) {
      if (this.buf[this.pos] === 0x23) {             // #XX escape
        out += String.fromCharCode(parseInt(this.buf.toString('latin1', this.pos + 1, this.pos + 3), 16))
        this.pos += 3
      } else out += String.fromCharCode(this.buf[this.pos++])
    }
    return new Name(out)
  }

  parseLiteralString() {
    this.pos++
    const bytes = []
    let depth = 1
    while (this.pos < this.buf.length) {
      const c = this.buf[this.pos++]
      if (c === 0x5c) {                              // backslash escape
        const e = this.buf[this.pos++]
        const simple = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 }
        if (simple[e] !== undefined) bytes.push(simple[e])
        else if (e >= 0x30 && e <= 0x37) {           // up to three octal digits
          let oct = String.fromCharCode(e)
          for (let k = 0; k < 2 && this.buf[this.pos] >= 0x30 && this.buf[this.pos] <= 0x37; k++) {
            oct += String.fromCharCode(this.buf[this.pos++])
          }
          bytes.push(parseInt(oct, 8) & 0xff)
        } else if (e === 0x0a) { /* line continuation */ }
        else bytes.push(e)
      } else if (c === 0x28) { depth++; bytes.push(c) }
      else if (c === 0x29) { if (--depth === 0) break; bytes.push(c) }
      else bytes.push(c)
    }
    return { str: Buffer.from(bytes) }
  }

  parseHexString() {
    this.pos++
    let hex = ''
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0x3e) {
      const c = String.fromCharCode(this.buf[this.pos++])
      if (/[0-9a-fA-F]/.test(c)) hex += c
    }
    this.pos++
    if (hex.length & 1) hex += '0'
    return { str: Buffer.from(hex, 'hex') }
  }

  parseArray() {
    this.pos++
    const out = []
    for (;;) {
      this.skip()
      if (this.pos >= this.buf.length) break
      if (this.buf[this.pos] === 0x5d) { this.pos++; break }
      const v = this.parse()
      if (v === undefined) break
      out.push(v)
    }
    return out
  }

  parseDict() {
    this.pos += 2
    const dict = new Map()
    for (;;) {
      this.skip()
      if (this.pos >= this.buf.length) break
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) { this.pos += 2; break }
      const key = this.parse()
      if (!(key instanceof Name)) break
      dict.set(key.name, this.parse())
    }

    // A dictionary followed by `stream` owns the bytes up to `endstream`.
    const save = this.pos
    this.skip()
    if (this.buf.toString('latin1', this.pos, this.pos + 6) === 'stream') {
      this.pos += 6
      if (this.buf[this.pos] === 0x0d) this.pos++
      if (this.buf[this.pos] === 0x0a) this.pos++
      const len = dict.get('Length')
      const start = this.pos
      let end
      if (typeof len === 'number') end = start + len
      else end = this.buf.indexOf('endstream', start, 'latin1')
      return new PdfStream(dict, this.buf.subarray(start, end))
    }
    this.pos = save
    return dict
  }
}

const num = v => (typeof v === 'number' ? v : 0)

class Doc {
  constructor(buf, password = '') {
    this.buf = buf
    this.objs = new Map()          // objnum -> parsed object
    this.offsets = new Map()       // objnum -> byte offset
    this.inObjStm = new Map()      // objnum -> container objnum
    this.crypt = null
    this.readXref()
    if (this.trailer.get('Encrypt')) this.setupCrypt(password)
  }

  readXref() {
    const tail = this.buf.toString('latin1', Math.max(0, this.buf.length - 2048))
    const m = /startxref\s+(\d+)/g
    let last = null, hit
    while ((hit = m.exec(tail)) !== null) last = hit[1]
    if (last === null) throw new Error('pdfread: no startxref')

    let pos = parseInt(last, 10)
    const seen = new Set()
    this.trailer = new Map()

    while (pos !== undefined && pos !== null && !seen.has(pos)) {
      seen.add(pos)
      const lex = new Lexer(this.buf, pos)
      lex.skipObjHeader()
      const obj = lex.parse()
      if (!(obj instanceof PdfStream)) throw new Error('pdfread: only xref streams are supported')

      this.readXrefStream(obj)
      for (const [k, v] of obj.dict) if (!this.trailer.has(k)) this.trailer.set(k, v)
      pos = obj.dict.get('Prev')
    }
  }

  readXrefStream(stm) {
    const data = decodeStream(stm)
    const w = stm.dict.get('W').map(num)
    const size = num(stm.dict.get('Size'))
    const index = stm.dict.get('Index') ?? [0, size]
    const rowLen = w.reduce((a, b) => a + b, 0)

    let p = 0
    for (let s = 0; s < index.length; s += 2) {
      const first = num(index[s]), count = num(index[s + 1])
      for (let i = 0; i < count && p + rowLen <= data.length; i++) {
        const f = []
        for (const width of w) {
          let v = 0
          for (let k = 0; k < width; k++) v = (v << 8) | data[p++]
          f.push(v)
        }
        const objnum = first + i
        const type = w[0] === 0 ? 1 : f[0]
        if (this.offsets.has(objnum) || this.inObjStm.has(objnum)) continue
        if (type === 1) this.offsets.set(objnum, f[1])
        else if (type === 2) this.inObjStm.set(objnum, { container: f[1], index: f[2] })
      }
    }
  }

  setupCrypt(password) {
    const enc = this.resolve(this.trailer.get('Encrypt'))
    const R = num(enc.get('R'))
    if (R !== 6) throw new Error(`pdfread: only revision 6 is supported, saw ${R}`)
    this.crypt = buildR6Key(enc, password)
    this.encryptRef = this.trailer.get('Encrypt')
  }

  resolve(v) {
    if (!(v instanceof Ref)) return v
    return this.get(v.num)
  }

  get(objnum) {
    if (this.objs.has(objnum)) return this.objs.get(objnum)
    let value = null

    if (this.offsets.has(objnum)) {
      const lex = new Lexer(this.buf, this.offsets.get(objnum))
      lex.skipObjHeader()
      value = lex.parse()
      if (this.crypt && !this.isEncryptDict(objnum)) value = this.decryptDeep(value)
    } else if (this.inObjStm.has(objnum)) {
      const { container, index } = this.inObjStm.get(objnum)
      const entries = this.objStmEntries(container)
      value = entries[index] ?? null
    }

    this.objs.set(objnum, value)
    return value
  }

  isEncryptDict(objnum) {
    return this.encryptRef instanceof Ref && this.encryptRef.num === objnum
  }

  objStmEntries(container) {
    if (!this._objStmCache) this._objStmCache = new Map()
    if (this._objStmCache.has(container)) return this._objStmCache.get(container)

    const stm = this.get(container)
    const data = decodeStream(stm)
    const n = num(this.resolve(stm.dict.get('N')))
    const first = num(this.resolve(stm.dict.get('First')))

    const head = new Lexer(data, 0)
    const pairs = []
    for (let i = 0; i < n; i++) {
      const objnum = head.parse()
      const off = head.parse()
      pairs.push([num(objnum), num(off)])
    }
    const out = []
    for (let i = 0; i < n; i++) {
      const lex = new Lexer(data, first + pairs[i][1])
      out.push(lex.parse())
    }
    // Objects inside an object stream are covered by the stream's own
    // decryption, so they are never decrypted a second time.
    this._objStmCache.set(container, out)
    return out
  }

  decryptDeep(value) {
    const walk = v => {
      if (v && v.str !== undefined) return { str: aesDecrypt(this.crypt, v.str) }
      if (Array.isArray(v)) return v.map(walk)
      if (v instanceof PdfStream) {
        v.raw = aesDecrypt(this.crypt, v.raw)
        for (const [k, val] of v.dict) v.dict.set(k, walk(val))
        return v
      }
      if (v instanceof Map) {
        for (const [k, val] of v) v.set(k, walk(val))
        return v
      }
      return v
    }
    return walk(value)
  }

  stream(stm) { return decodeStream(stm) }
}

function decodeStream(stm) {
  const filter = stm.dict.get('Filter')
  const names = filter instanceof Name ? [filter] : Array.isArray(filter) ? filter : []
  let data = stm.raw
  for (const f of names) {
    if (f instanceof Name && f.name === 'FlateDecode') data = Buffer.from(unzlib(new Uint8Array(data)))
    else if (f instanceof Name) throw new Error(`pdfread: unsupported filter ${f.name}`)
  }
  return data
}

// AES-256 revision 6
// ISO 32000-2 algorithms 2.A and 2.B, using node's crypto for the primitives
// so this stays an independent check of daepdf's own implementation.

import crypto from 'node:crypto'

function hash2B(password, salt, udata) {
  let K = crypto.createHash('sha256').update(Buffer.concat([password, salt, udata])).digest()
  for (let round = 0; ; round++) {
    const K1 = Buffer.concat(Array(64).fill(Buffer.concat([password, K, udata])))
    const c = crypto.createCipheriv('aes-128-cbc', K.subarray(0, 16), K.subarray(16, 32))
    c.setAutoPadding(false)
    const E = Buffer.concat([c.update(K1), c.final()])
    let sum = 0
    for (let i = 0; i < 16; i++) sum += E[i]
    const alg = ['sha256', 'sha384', 'sha512'][sum % 3]
    K = crypto.createHash(alg).update(E).digest()
    if (round >= 63 && E[E.length - 1] <= round - 31) break
  }
  return K.subarray(0, 32)
}

function buildR6Key(enc, password) {
  const pw = Buffer.from(password, 'utf8')
  const U = enc.get('U').str
  const UE = enc.get('UE').str
  // Validate against the user password, then unwrap the file key with the
  // intermediate key derived from the key salt.
  const validationSalt = U.subarray(32, 40)
  const keySalt = U.subarray(40, 48)
  const check = hash2B(pw, validationSalt, Buffer.alloc(0))
  if (!check.equals(U.subarray(0, 32))) throw new Error('pdfread: wrong password')

  const intermediate = hash2B(pw, keySalt, Buffer.alloc(0))
  const d = crypto.createDecipheriv('aes-256-cbc', intermediate, Buffer.alloc(16))
  d.setAutoPadding(false)
  return Buffer.concat([d.update(UE), d.final()])
}

function aesDecrypt(key, data) {
  if (data.length <= 16) return Buffer.alloc(0)
  const iv = data.subarray(0, 16)
  const d = crypto.createDecipheriv('aes-256-cbc', key, iv)
  d.setAutoPadding(false)
  const out = Buffer.concat([d.update(data.subarray(16)), d.final()])
  const pad = out[out.length - 1]
  return pad >= 1 && pad <= 16 ? out.subarray(0, out.length - pad) : out
}

// Text

// Identity-H hex strings carry glyph ids; ToUnicode maps them back. Only the
// bfchar and bfrange forms daepdf emits are handled.
function parseToUnicode(text) {
  const map = new Map()
  const hex = s => parseInt(s, 16)
  const chars = /beginbfchar([\s\S]*?)endbfchar/g
  let m
  while ((m = chars.exec(text)) !== null) {
    const pairs = m[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g) ?? []
    for (const p of pairs) {
      const [, src, dst] = p.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/)
      map.set(hex(src), utf16beToString(dst))
    }
  }
  const ranges = /beginbfrange([\s\S]*?)endbfrange/g
  while ((m = ranges.exec(text)) !== null) {
    const rows = m[1].match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g) ?? []
    for (const r of rows) {
      const [, lo, hi, dst] = r.match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/)
      const start = hex(lo), end = hex(hi), base = hex(dst)
      for (let c = start; c <= end; c++) map.set(c, String.fromCodePoint(base + (c - start)))
    }
  }
  return map
}

function utf16beToString(hexStr) {
  let out = ''
  for (let i = 0; i + 3 < hexStr.length + 1; i += 4) {
    out += String.fromCharCode(parseInt(hexStr.slice(i, i + 4), 16))
  }
  return out
}

// Public API

class Page {
  constructor(doc, dict) { this.doc = doc; this.dict = dict }

  content() {
    const contents = this.doc.resolve(this.dict.get('Contents'))
    return contents instanceof PdfStream ? this.doc.stream(contents).toString('latin1') : ''
  }

  // Concatenated text of the page, decoded through each font's ToUnicode.
  text() {
    const d = this.doc
    const contents = d.resolve(this.dict.get('Contents'))
    if (!(contents instanceof PdfStream)) return ''
    const body = d.stream(contents).toString('latin1')

    const res = d.resolve(this.dict.get('Resources')) ?? new Map()
    const fonts = d.resolve(res.get('Font')) ?? new Map()
    const cmaps = new Map()
    for (const [name, ref] of fonts) {
      const font = d.resolve(ref)
      if (!(font instanceof Map)) continue
      const tu = d.resolve(font.get('ToUnicode'))
      if (tu instanceof PdfStream) cmaps.set(name, parseToUnicode(d.stream(tu).toString('latin1')))
    }

    let current = null
    let out = ''
    // marked-content spans: one carrying /ActualText stands in for the glyphs inside it
    const spans = []
    // Tf selects the font; Tj and TJ carry the glyphs. Only the operators
    // daepdf emits are recognized.
    const re = /\/([A-Za-z0-9#+.-]+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]*)>\s*Tj|\[((?:[^\]\\]|\\.)*)\]\s*TJ|\/\w+\s*<<(.*?)>>\s*BDC|\bEMC\b/g
    let m
    while ((m = re.exec(body)) !== null) {
      if (m[1] !== undefined) { current = cmaps.get(m[1]) ?? null; continue }
      if (m[4] !== undefined) {
        const actual = /\/ActualText\s*<([0-9a-fA-F]*)>/.exec(m[4])
        if (actual && !spans.includes(true)) out += decodeTextString(Buffer.from(actual[1], 'hex'))
        spans.push(!!actual)
        continue
      }
      if (m[0] === 'EMC') { spans.pop(); continue }
      if (spans.includes(true)) continue
      const hexes = m[2] !== undefined ? [m[2]] : [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => x[1])
      for (const h of hexes) {
        for (let i = 0; i + 4 <= h.length; i += 4) {
          const gid = parseInt(h.slice(i, i + 4), 16)
          out += current?.get(gid) ?? ''
        }
      }
    }
    return out
  }

  // The decoded content of every form XObject the page reaches, nested ones included
  forms() { return this.reach().forms }

  // The dictionaries of the shadings those forms use
  shadings() { return this.reach().shadings }

  reach() {
    const d = this.doc, forms = [], shadings = [], seen = new Set()
    const walk = res => {
      res = d.resolve(res)
      for (const ref of (d.resolve(res?.get('Shading')) ?? new Map()).values()) {
        const sh = d.resolve(ref)
        shadings.push(sh instanceof PdfStream ? sh.dict : sh)
      }
      for (const ref of (d.resolve(res?.get('XObject')) ?? new Map()).values()) {
        const x = d.resolve(ref)
        if (!(x instanceof PdfStream) || seen.has(x) || d.resolve(x.dict.get('Subtype'))?.name !== 'Form') continue
        seen.add(x)
        forms.push(d.stream(x).toString('latin1'))
        walk(x.dict.get('Resources'))
      }
    }
    walk(this.dict.get('Resources'))
    return { forms, shadings }
  }

  annotations() {
    const d = this.doc
    const arr = d.resolve(this.dict.get('Annots')) ?? []
    return arr.map(ref => {
      const a = d.resolve(ref)
      if (!(a instanceof Map)) return null
      const sub = d.resolve(a.get('Subtype'))
      const action = d.resolve(a.get('A')) ?? new Map()
      const uri = d.resolve(action.get('URI'))
      const rect = (d.resolve(a.get('Rect')) ?? []).map(num)
      return {
        subtype: sub instanceof Name ? sub.name : null,
        url: uri?.str ? uri.str.toString('latin1') : undefined,
        dest: action.get('D') !== undefined ? 'GoTo' : undefined,
        fieldName: d.resolve(a.get('T'))?.str ? decodeTextString(d.resolve(a.get('T')).str) : undefined,
        fieldValue: d.resolve(a.get('V'))?.str ? decodeTextString(d.resolve(a.get('V')).str) : undefined,
        fieldType: d.resolve(a.get('FT')) instanceof Name ? d.resolve(a.get('FT')).name : undefined,
        fieldFlags: a.has('Ff') ? num(d.resolve(a.get('Ff'))) : undefined,
        flags: a.has('F') ? num(d.resolve(a.get('F'))) : undefined,
        fieldOptions: a.has('Opt') ? d.resolve(a.get('Opt')).map(o => {
          const v = d.resolve(o)
          return Array.isArray(v) ? v.map(x => decodeTextString(d.resolve(x).str)) : decodeTextString(v.str)
        }) : undefined,
        rect,
      }
    }).filter(Boolean)
  }
}

class Document {
  constructor(buf, password) {
    this.doc = new Doc(Buffer.from(buf), password)
    this.root = this.doc.resolve(this.doc.trailer.get('Root'))
    this.pages = []
    this.collectPages(this.doc.resolve(this.root.get('Pages')))
  }

  collectPages(node) {
    if (!(node instanceof Map)) return
    const type = this.doc.resolve(node.get('Type'))
    if (type instanceof Name && type.name === 'Page') { this.pages.push(node); return }
    for (const kid of this.doc.resolve(node.get('Kids')) ?? []) {
      this.collectPages(this.doc.resolve(kid))
    }
  }

  get numPages() { return this.pages.length }

  getPage(n) { return new Page(this.doc, this.pages[n - 1]) }

  // Same shape the tests previously read off getMetadata().info.
  get info() {
    const d = this.doc
    const inf = d.resolve(d.trailer.get('Info'))
    const out = {}
    if (!(inf instanceof Map)) return out
    for (const [k, v] of inf) {
      const val = d.resolve(v)
      if (val?.str) out[k] = decodeTextString(val.str)
      else if (typeof val === 'number' || typeof val === 'boolean') out[k] = val
      else if (val instanceof Name) out[k] = val.name
    }
    return out
  }

  get outline() {
    const d = this.doc
    const outlines = d.resolve(this.root.get('Outlines'))
    if (!(outlines instanceof Map)) return null
    const first = outlines.get('First')
    if (!first) return null

    const walk = ref => {
      const items = []
      let cur = d.resolve(ref)
      const seen = new Set()
      while (cur instanceof Map) {
        const title = d.resolve(cur.get('Title'))
        const kid = cur.get('First')
        items.push({
          title: title?.str ? decodeTextString(title.str) : '',
          items: kid ? walk(kid) : [],
        })
        const next = cur.get('Next')
        if (!next || seen.has(next.num)) break
        seen.add(next.num)
        cur = d.resolve(next)
      }
      return items
    }
    return walk(first)
  }

  // A catalog entry, resolved: text strings decoded, names as their name, dicts as Maps.
  catalogEntry(key) {
    const v = this.doc.resolve(this.root.get(key))
    if (v?.str) return decodeTextString(v.str)
    if (v instanceof Name) return v.name
    return v
  }

}

// PDF text strings are either UTF-16BE with a BOM or PDFDocEncoding.
function decodeTextString(buf) {
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
    let out = ''
    for (let i = 2; i + 1 < buf.length; i += 2) out += String.fromCharCode((buf[i] << 8) | buf[i + 1])
    return out
  }
  return buf.toString('latin1')
}

export function readPdf(bytes, { password = '' } = {}) {
  return new Document(bytes, password)
}
