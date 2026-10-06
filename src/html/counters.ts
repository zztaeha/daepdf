// CSS counters: counter-reset pushes a new counter instance whose scope is the
// resetting element, its descendants, AND its following siblings — so the pop
// happens when the resetting element's PARENT finishes walking its children
// (walkChildren collects the pushed names), not when the element itself exits.
// counter-increment/-set mutate the innermost instance in scope.

export type CounterMap = Map<string, number[]>

function parseCounterList(v: string | undefined, def: number): [string, number][] {
  if (!v || v === 'none') return []
  const out: [string, number][] = []
  const toks = v.trim().split(/\s+/)
  for (let i = 0; i < toks.length; i++) {
    const name = toks[i]!
    if (!/^[A-Za-z_-]/.test(name)) continue
    let val = def
    if (i + 1 < toks.length && /^-?\d+$/.test(toks[i + 1]!)) val = parseInt(toks[++i]!, 10)
    out.push([name, val])
  }
  return out
}

// One an earlier sibling created is replaced, not nested, as browsers do (CSS Lists 3).
// True when a new instance was pushed, for the caller to pop at the scope's end.
function instantiate(counters: CounterMap, name: string, val: number, siblings: readonly string[]): boolean {
  const st = counters.get(name) ?? []
  counters.set(name, st)
  if (siblings.includes(name) && st.length) { st[st.length - 1] = val; return false }
  st.push(val)
  return true
}

// applies an element's (or pseudo's) counter properties; returns the names it
// pushed new instances for, so the caller can pop them at the right scope end.
// siblings: the names earlier siblings instantiated, still in scope here
export function applyCounters(counters: CounterMap, s: CSSStyleDeclaration, siblings: readonly string[] = []): string[] {
  const pushed: string[] = []
  const push = (name: string, val: number) => {
    if (instantiate(counters, name, val, pushed.includes(name) ? [] : siblings)) pushed.push(name)
  }

  for (const [name, val] of parseCounterList(s.counterReset, 0)) push(name, val)
  for (const [name, val] of parseCounterList((s as any).counterSet, 0)) {
    const st = counters.get(name)
    if (st?.length) st[st.length - 1] = val
    else push(name, val)
  }
  for (const [name, val] of parseCounterList(s.counterIncrement, 1)) {
    const st = counters.get(name)
    if (st?.length) st[st.length - 1] = (st.at(-1) ?? 0) + val
    // increment with no counter in scope acts as reset-to-0 then increment, per spec
    else push(name, val)
  }
  return pushed
}

// The built-in list-item counter, absent from computed styles: lists reset it and items take
// their ordinal (start, value, reversed), unless the author's CSS manages list-item itself.
export function applyListItemCounter(
  counters: CounterMap, el: Element, s: CSSStyleDeclaration, ordinal: () => number, siblings: readonly string[] = [],
): string[] {
  const authored = [s.counterReset, (s as any).counterSet, s.counterIncrement].some(v => /(^|\s)list-item(\s|$)/.test(v))
  if (authored) return []
  const tag = el.tagName.toUpperCase()
  if (tag === 'OL' || tag === 'UL' || tag === 'MENU') return instantiate(counters, 'list-item', 0, siblings) ? ['list-item'] : []
  if (s.display !== 'list-item') return []
  const st = counters.get('list-item')
  if (st?.length) { st[st.length - 1] = ordinal(); return [] }
  return instantiate(counters, 'list-item', ordinal(), siblings) ? ['list-item'] : []
}

export function popCounters(counters: CounterMap, pushed: string[]): void {
  for (const name of pushed) counters.get(name)?.pop()
}

// Both loops below count down, so a non-finite value never terminates and the
// whole render hangs. CSS can produce one without trying: parseCounterList
// accepts any all-digit token, and parseInt of a 309-digit number is Infinity.
// Roman and alphabetic numbering are only defined for a modest positive range
// anyway; outside it CSS falls back to decimal, which is what returning ''
// signals to counterText.
const COUNTER_LIMIT = 100000

function countable(n: number): number | null {
  if (!Number.isFinite(n)) return null
  const i = Math.trunc(n)
  return i >= 1 && i <= COUNTER_LIMIT ? i : null
}

export function romanNumeral(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ]
  let rest = countable(n)
  if (rest === null) return ''
  let out = ''
  for (const [v, sym] of table) while (rest >= v) { out += sym; rest -= v }
  return out
}

const LATIN = [...'abcdefghijklmnopqrstuvwxyz']
const GREEK = [...'αβγδεζηθικλμνξοπρστυφχψω']

// CSS "alphabetic" counter system: a, b, …, z, aa, ab, …
function alphabetic(n: number, symbols: string[]): string {
  let rest = countable(n)
  if (rest === null) return ''
  let out = ''
  while (rest > 0) { rest--; out = symbols[rest % symbols.length]! + out; rest = Math.floor(rest / symbols.length) }
  return out
}

export const alphaLabel = (n: number): string => alphabetic(n, LATIN)
const greekLabel = (n: number): string => alphabetic(n, GREEK)

export function counterText(n: number, style?: string): string {
  // '' from the two helpers means "outside what this numbering can express" —
  // CSS falls back to decimal there rather than rendering an empty marker.
  const orDecimal = (v: string) => v === '' ? String(n) : v
  switch (style) {
    case 'lower-alpha':
    case 'lower-latin':          return orDecimal(alphaLabel(n))
    case 'upper-alpha':
    case 'upper-latin':          return orDecimal(alphaLabel(n).toUpperCase())
    case 'lower-greek':          return orDecimal(greekLabel(n))
    case 'upper-greek':          return orDecimal(greekLabel(n).toUpperCase())
    case 'lower-roman':          return orDecimal(romanNumeral(n).toLowerCase())
    case 'upper-roman':          return orDecimal(romanNumeral(n))
    case 'decimal-leading-zero': return `${n < 10 && n >= 0 ? '0' : ''}${n}`
    default:                     return String(n)
  }
}

// Resolves a computed `content` list: quoted strings, counter(), counters().
// Returns null when any term can't be resolved (attr(), quotes, url()) — a
// partial render would leak raw CSS text into the document.
export function resolveContentList(content: string, counters: CounterMap): string | null {
  const s = content.trim()
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === ' ') { i++; continue }
    const q = s[i]
    if (q === '"' || q === "'") {
      let j = i + 1, lit = ''
      while (j < s.length && s[j] !== q) {
        if (s[j] === '\\' && j + 1 < s.length) { lit += s[j + 1]; j += 2 }
        else { lit += s[j]; j++ }
      }
      if (j >= s.length) return null
      out += lit
      i = j + 1
      continue
    }
    const fnM = s.slice(i).match(/^(counters?)\(/)
    if (!fnM) return null
    // the separator is a string, which may itself hold a comma or parenthesis
    const parts: string[] = []
    let cur = '', quote: string | null = null, close = -1
    for (let j = i + fnM[0].length; j < s.length; j++) {
      const ch = s[j]!
      if (quote) {
        cur += ch
        if (ch === '\\' && j + 1 < s.length) cur += s[++j]
        else if (ch === quote) quote = null
      } else if (ch === '"' || ch === "'") { quote = ch; cur += ch }
      else if (ch === ',') { parts.push(cur.trim()); cur = '' }
      else if (ch === ')') { parts.push(cur.trim()); close = j; break }
      else cur += ch
    }
    if (close < 0) return null
    const name  = parts[0]
    if (!name) return null
    const stack = counters.get(name)
    if (fnM[1] === 'counters') {
      const sepM = (parts[1] ?? '').match(/^"((?:[^"\\]|\\.)*)"$/) ?? (parts[1] ?? '').match(/^'((?:[^'\\]|\\.)*)'$/)
      if (!sepM) return null
      const sep = (sepM[1] ?? '').replace(/\\(.)/g, '$1')
      out += (stack?.length ? stack : [0]).map(v => counterText(v, parts[2])).join(sep)
    } else {
      out += counterText(stack?.at(-1) ?? 0, parts[1])
    }
    i = close + 1
  }
  return out
}
