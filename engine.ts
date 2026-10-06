import initEngine, {
  register_font_raw,
  register_font_ttc,
  measure_string_width,
  list_registered_fonts,
} from './src/daegun/wasm/daegun.js'

export {
  initEngine,
  measure_string_width,
  list_registered_fonts,
}

export type ManifestEntry = { path: string; name: string; ttcIndex?: number }

const _fetchCache  = new Map<string, Promise<Uint8Array>>()

function _fetchFont(path: string): Promise<Uint8Array> {
  if (!_fetchCache.has(path)) {
    const p = fetch(path).then(r => {
      if (!r.ok) throw new Error(`Failed to fetch font ${path}: ${r.status}`)
      return r.arrayBuffer().then(b => new Uint8Array(b))
    })
    p.catch(() => _fetchCache.delete(path))
    _fetchCache.set(path, p)
  }
  return _fetchCache.get(path)!
}

function _isRawFont(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  const sig = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  return sig === 0x00010000 || sig === 0x4F54544F || sig === 0x74727565
}

export async function loadAndRegisterFont(entry: ManifestEntry): Promise<void> {
  await initEngine()
  const bytes = await _fetchFont(entry.path)

  const sig = bytes.length >= 4
    ? (((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0)
    : 0
  if (sig === 0x74746366) { // 'ttcf' collection
    register_font_ttc(entry.name, bytes, entry.ttcIndex ?? 0)
    return
  }
  if (_isRawFont(bytes)) {
    register_font_raw(entry.name, bytes)
    return
  }

  // Named rather than left to a generic failure: a WOFF2 in an existing @font-face is the one
  // way a working setup breaks on upgrade, and the fix is to point src at the uncompressed file.
  const label = sig === 0x774F4632 ? 'WOFF2' : sig === 0x774F4646 ? 'WOFF' : 'an unrecognized format'
  throw new Error(
    `Font ${entry.path} is ${label}. daepdf embeds TTF, OTF and TTC only \u2013 point src at the uncompressed font.`,
  )
}

export function triggerDownload(bytes: Uint8Array, fileName: string): void {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: isIOS ? 'application/octet-stream' : 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

// \w is ASCII-only in JS regex — a plain [^\w-] strip silently deleted every
// non-Latin character rather than just filesystem-unsafe ones, emptying out
// e.g. a CJK-only name entirely (confirmed: safeName('田中太郎') === '').
// \p{L}/\p{N}/\p{M} (letter/number/combining-mark, any script) keep real
// name characters — including NFD-decomposed accents, which are their own
// \p{M} codepoint, not part of \p{L} — while still stripping path
// separators, quotes, and other filesystem-unsafe punctuation.
export const safeName = (s: string): string =>
  s.trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}\p{M}_-]/gu, '')
