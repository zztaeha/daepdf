export interface RawImage {
  width:      number
  height:     number
  colorSpace: 'DeviceRGB' | 'DeviceGray'
  data:       Uint8Array
  smask:      Uint8Array | null
}

// keyed by the SAME Uint8Array instance resolveImage's own _imageCache/
// _dataUriCache already guarantee for a given URL/data-URI — without this,
// the SAME logical image (e.g. a repeated WebP/AVIF logo) decodes and
// embeds ONCE PER OCCURRENCE instead of once total: JPEG/PNG dedupe
// correctly downstream because embed_image's cache is keyed on those same
// cached byte arrays, but every decodeToRaw() call returned a brand-new
// RawImage object even for identical input, so the downstream dedupe
// (keyed by object reference) could never match — confirmed via a real
// render, 3 occurrences of one WebP producing 3 separate Image XObjects
// (~3x the file size) instead of 1.
const _decodeCache = new Map<Uint8Array, Promise<RawImage | null>>()

// browser-decode any format the engine doesn't handle natively straight to
// raw pixels for embedding — no PNG re-encode round trip
export function decodeToRaw(bytes: Uint8Array): Promise<RawImage | null> {
  if (_decodeCache.has(bytes)) return _decodeCache.get(bytes)!
  const p = decodeToRawUncached(bytes)
  _decodeCache.set(bytes, p)
  return p
}

async function decodeToRawUncached(bytes: Uint8Array): Promise<RawImage | null> {
  try {
    const blob = new Blob([bytes as unknown as ArrayBuffer])
    let bmp: ImageBitmap
    try {
      // unpremultiplied, and converted to sRGB as the browser shows it: the PDF embeds
      // these as DeviceRGB, so a P3-tagged image's raw values would print off-color
      bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none' })
    } catch {
      bmp = await createImageBitmap(blob)
    }
    const w = bmp.width, h = bmp.height
    if (!w || !h) { bmp.close(); return null }

    const canvas  = document.createElement('canvas')
    canvas.width  = w
    canvas.height = h
    const c2d = canvas.getContext('2d', { willReadFrequently: true })
    if (!c2d) { bmp.close(); return null }
    c2d.drawImage(bmp, 0, 0)
    bmp.close()
    const rgba = c2d.getImageData(0, 0, w, h).data

    const n = w * h
    let hasAlpha = false
    let isGray   = true
    for (let i = 0; i < n; i++) {
      const o = i * 4
      if (rgba[o + 3] !== 255) hasAlpha = true
      if (rgba[o] !== rgba[o + 1] || rgba[o + 1] !== rgba[o + 2]) isGray = false
      if (hasAlpha && !isGray) break
    }

    const data = new Uint8Array(isGray ? n : n * 3)
    for (let i = 0; i < n; i++) {
      const o = i * 4
      if (isGray) {
        data[i] = rgba[o]!
      } else {
        data[i * 3]     = rgba[o]!
        data[i * 3 + 1] = rgba[o + 1]!
        data[i * 3 + 2] = rgba[o + 2]!
      }
    }
    let smask: Uint8Array | null = null
    if (hasAlpha) {
      smask = new Uint8Array(n)
      for (let i = 0; i < n; i++) smask[i] = rgba[i * 4 + 3]!
    }

    return { width: w, height: h, colorSpace: isGray ? 'DeviceGray' : 'DeviceRGB', data, smask }
  } catch {
    return null
  }
}
