import { list_registered_fonts } from '../../engine.js'
import { font_has_glyph } from '../daegun/wasm/daegun.js'
import { isColorFont } from '../daegun/colorfonts.js'
import type { FontRef } from '../types/index.js'
import type { FontBridgeMap } from './types.js'

let _fontMapCache: Map<string, string[]> | null = null
// per (font, codepoint) glyph-coverage memo — a single font's own coverage
// never changes once registered, but the SET of registered fonts can grow
// (a template's own @font-face), so this clears in lockstep with the font
// map cache rather than living forever
let _glyphCache = new Map<string, boolean>()

export function invalidateFontMapCache(): void {
  _fontMapCache = null
  _glyphCache = new Map()
}

function hasGlyphCached(name: string, style: string, codepoint: number): boolean {
  const key = `${name}|${style}|${codepoint}`
  let hit = _glyphCache.get(key)
  if (hit === undefined) {
    hit = font_has_glyph(name, style, codepoint)
    _glyphCache.set(key, hit)
  }
  return hit
}

export function buildRegisteredFontMap(): Map<string, string[]> {
  if (_fontMapCache) return _fontMapCache
  const map  = new Map<string, string[]>()
  const list = list_registered_fonts()
  for (const entry of list) {
    const colon = entry.indexOf(':')
    if (colon < 0) continue
    const name  = entry.slice(0, colon)
    const style = entry.slice(colon + 1)
    const arr   = map.get(name) ?? []
    arr.push(style)
    map.set(name, arr)
  }
  _fontMapCache = map
  return map
}

function cssWeightNum(w: string): number {
  if (w === 'bold')   return 700
  if (w === 'normal') return 400
  const n = parseInt(w, 10)
  return isNaN(n) ? 400 : n
}

function pickStyle(
  name:   string,
  weight: number,
  italic: boolean,
  reg:    Map<string, string[]>,
): string | null {
  const styles = reg.get(name)
  if (!styles || !styles.length) return null
  if (styles.length === 1) return styles[0]!

  const isBold   = (x: string) => x.includes('bold') || x.includes('semi') || x.includes('medium') || x.includes('heavy')
  const isItalic = (x: string) => x.includes('italic') || x.includes('oblique')

  if (italic && weight >= 500) {
    const s = styles.find(x => isItalic(x) && isBold(x))
    if (s) return s
  }
  if (italic) {
    const s = styles.find(x => isItalic(x))
    if (s) return s
  }
  if (weight >= 500) {
    const s = styles.find(x => isBold(x) && !isItalic(x))
    if (s) return s
  } else {
    const s = styles.find(x => x === 'normal' || x === 'regular' || x === 'light' || x === 'thin')
    if (s) return s
  }
  // the engine names faces normal or italic and picks the weight itself, so an upright
  // request has to skip italic faces here or bold text prints slanted
  return (italic ? undefined : styles.find(x => !isItalic(x))) ?? styles[0]!
}

function resolveOneFamily(
  fam:     string,
  weight:  number,
  italic:  boolean,
  fontMap: FontBridgeMap,
  reg:     Map<string, string[]>,
): FontRef | null {
  const override = fontMap[fam] ?? fontMap[fam.toLowerCase()]
  if (override) return { name: override.name, style: override.style, weight: override.weight }

  if (!fam || ['sans-serif','serif','monospace','system-ui','cursive','fantasy','math'].includes(fam.toLowerCase())) return null

  const lname = fam.toLowerCase()
  const style = pickStyle(lname, weight, italic, reg)
  return style !== null ? { name: fam, style, weight } : null
}

function familyList(family: string): string[] {
  return family.split(',').map(f => f.trim().replace(/^["']|["']$/g, '').trim())
}

// Chrome treats oblique from 14deg up as italic, both for face choice and for synthesis
export function isSlanted(fStyle: string): boolean {
  const m = fStyle.match(/^(italic|oblique)(?:\s+(-?[\d.]+)deg)?$/)
  return !!m && (m[2] === undefined || parseFloat(m[2]) >= 14)
}

export function resolveFontRef(
  family:  string,
  weight:  string,
  fStyle:  string,
  fontMap: FontBridgeMap,
  reg:     Map<string, string[]>,
): FontRef | null {
  const cssWeight = cssWeightNum(weight)
  const italic    = isSlanted(fStyle)
  const families  = familyList(family)

  for (const fam of families) {
    const ref = resolveOneFamily(fam, cssWeight, italic, fontMap, reg)
    if (ref) return ref
  }

  return null
}

function colorFontFor(
  codepoint: number, family: string, weight: string, fStyle: string, fontMap: FontBridgeMap, reg: Map<string, string[]>,
): FontRef | null {
  const cssWeight = cssWeightNum(weight), italic = isSlanted(fStyle)
  for (const fam of familyList(family)) {
    const ref = resolveOneFamily(fam, cssWeight, italic, fontMap, reg)
    if (ref && isColorFont(ref.name, ref.style) && hasGlyphCached(ref.name, ref.style, codepoint)) return ref
  }
  return null
}

// Per-character fallback: `primary` resolved this codepoint to gid 0 (no
// glyph in that font) — try the REST of the CSS font-family list first
// (each candidate's own best style/weight match, the same resolution
// resolveFontRef itself uses), then fall through to ANY other registered
// family at all, in registration order, as a last resort. This is what lets
// a CJK character in a Latin-only font, or an emoji codepoint, fall back to
// a font that actually has it instead of silently vanishing. Returns null
// when nothing else covers it either — caller keeps the primary font's
// .notdef, matching today's behavior for a genuinely unrenderable codepoint.
function resolveGlyphFallback(
  codepoint: number,
  primary:   FontRef,
  family:    string,
  weight:    string,
  fStyle:    string,
  fontMap:   FontBridgeMap,
  reg:       Map<string, string[]>,
): FontRef | null {
  const cssWeight = cssWeightNum(weight)
  const italic    = isSlanted(fStyle)
  const families  = familyList(family)
  const sameAsPrimary = (ref: FontRef) =>
    ref.name.toLowerCase() === primary.name.toLowerCase() && ref.style === primary.style

  for (const fam of families) {
    const ref = resolveOneFamily(fam, cssWeight, italic, fontMap, reg)
    if (ref && !sameAsPrimary(ref) && hasGlyphCached(ref.name, ref.style, codepoint)) return ref
  }

  for (const [name, styles] of reg) {
    for (const style of styles) {
      if (name.toLowerCase() === primary.name.toLowerCase() && style === primary.style) continue
      if (hasGlyphCached(name, style, codepoint)) return { name, style, weight: cssWeight }
    }
  }

  return null
}

export interface FontRun { text: string; font: FontRef }

// Splits `text` into contiguous runs sharing one resolved font, falling back
// per-character (memoized per codepoint, see resolveGlyphFallback/
// hasGlyphCached) when `primary` doesn't cover a character. Fast path: every
// character is already covered by `primary` — returns the text as a single
// unsplit run, the exact common case, at the cost of one cache lookup per
// UNIQUE codepoint (not per character).
export function splitByFontCoverage(
  text:    string,
  primary: FontRef,
  family:  string,
  weight:  string,
  fStyle:  string,
  fontMap: FontBridgeMap,
  reg:     Map<string, string[]>,
): FontRun[] {
  const chars = [...text]
  const fontFor = new Map<number, FontRef>()
  let allPrimary = true

  for (const ch of chars) {
    const cp = ch.codePointAt(0)!
    if (fontFor.has(cp)) continue
    if (hasGlyphCached(primary.name, primary.style, cp)) { fontFor.set(cp, primary); continue }
    allPrimary = false
    const fallback = resolveGlyphFallback(cp, primary, family, weight, fStyle, fontMap, reg)
    fontFor.set(cp, fallback ?? primary)
  }

  if (allPrimary) return [{ text, font: primary }]

  // With the emoji presentation selector after it (❤️), a character takes the family's first color font
  // that has it, as browsers do: Noto Color Emoji maps the selector only in a variation-sequence table
  const fonts = chars.map(ch => fontFor.get(ch.codePointAt(0)!)!)
  for (let i = 0; i + 1 < chars.length; i++) {
    if (chars[i + 1] !== '\uFE0F') continue
    const cp = chars[i]!.codePointAt(0)!, selector = fonts[i + 1]!
    const emoji = colorFontFor(cp, family, weight, fStyle, fontMap, reg)
      ?? (selector !== primary && hasGlyphCached(selector.name, selector.style, cp) ? selector : null)
    if (emoji) { fonts[i] = emoji; fonts[i + 1] = emoji }
  }

  const runs: FontRun[] = []
  let runStart = 0
  let runFont  = fonts[0]!
  const sameRef = (a: FontRef, b: FontRef) => a.name === b.name && a.style === b.style && a.weight === b.weight

  for (let i = 1; i <= chars.length; i++) {
    const nextFont = i < chars.length ? fonts[i]! : null
    if (nextFont && sameRef(nextFont, runFont)) continue
    runs.push({ text: chars.slice(runStart, i).join(''), font: runFont })
    runStart = i
    if (nextFont) runFont = nextFont
  }

  return runs
}
