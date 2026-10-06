export function toUnicodeCmap(glyphToUnicode: Map<number, number[]>): string {
  const codes = [...glyphToUnicode.keys()].sort((a, b) => a - b)
  const ranges: [number, number, number][] = []
  const singles: [number, number[]][] = []

  // bfrange compression only applies to single-codepoint mappings — ligature
  // glyphs (multi-cp) always emit as bfchar
  const single = (g: number): number | null => {
    const v = glyphToUnicode.get(g)!
    return v.length === 1 ? v[0]! : null
  }

  let i = 0
  while (i < codes.length) {
    const sg = codes[i]!
    const sc = single(sg)
    let end = i
    // a bfrange's source codes differ only in their last byte and its destination increments
    // only its last byte, so a run stops where the glyph id or the codepoint would carry
    const startCompressible = sc !== null && sc <= 0xFFFF
    if (startCompressible) {
      while (end + 1 < codes.length) {
        const ng = codes[end + 1]!
        const nc = single(ng)
        const ec = single(codes[end]!)
        if (nc === null || ec === null || ng !== codes[end]! + 1 || nc !== ec + 1 || ec >= 0xFFFF) break
        if ((ng & 0xFF) === 0 || (nc & 0xFF) === 0) break
        end++
      }
    }
    if (end > i && sc !== null && sc <= 0xFFFF) ranges.push([sg, codes[end]!, sc])
    else singles.push([sg, glyphToUnicode.get(sg)!])
    i = end + 1
  }

  const h4 = (n: number) => n.toString(16).padStart(4, '0')
  const cpHex = (cp: number): string => {
    if (cp <= 0xFFFF) return h4(cp)
    const hi = 0xD800 + ((cp - 0x10000) >> 10)
    const lo = 0xDC00 + ((cp - 0x10000) & 0x3FF)
    return h4(hi) + h4(lo)
  }
  const cpsHex = (cps: number[]): string => cps.map(cpHex).join('')
  let map = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo <<\n  /Registry (Adobe)\n  /Ordering (UCS)\n  /Supplement 0\n>> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000><ffff>\nendcodespacerange'

  for (let r = 0; r < ranges.length; r += 100) {
    const batch = ranges.slice(r, r + 100)
    map += `\n${batch.length} beginbfrange\n`
    for (const [s, e, cp] of batch) map += `<${h4(s)}><${h4(e)}><${cpHex(cp)}>\n`
    map += 'endbfrange'
  }
  for (let r = 0; r < singles.length; r += 100) {
    const batch = singles.slice(r, r + 100)
    map += `\n${batch.length} beginbfchar\n`
    for (const [g, cps] of batch) map += `<${h4(g)}><${cpsHex(cps)}>\n`
    map += 'endbfchar'
  }
  map += '\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend'
  return map
}
