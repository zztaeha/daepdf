import type { DrawCommand, ImageCommand } from '../types/index.js'

// Two independent full-byte hashes, not a single 32-bit one — the same fix
// already applied to _dataUriKey in src/html/images.ts after real
// EXIF-orientation test files proved a single hash collides (two JPEGs
// differing by one byte encoded to the same 32-bit digest, silently reusing
// the wrong cached result for a different image). A large document with many
// inline SVGs is exactly the kind of input where a single-hash collision
// stops being astronomically unlikely.
function _hashBytes(bytes: Uint8Array): string {
  let h1 = 5381, h2 = 52711
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    h1 = (Math.imul(h1, 33) ^ b) >>> 0
    h2 = (h2 * 31 + b) | 0
  }
  return bytes.length + ':' + h1.toString(36) + ':' + (h2 >>> 0).toString(36)
}

function svgToPng(svgBytes: Uint8Array, drawW: number, drawH: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgBytes as unknown as ArrayBuffer], { type: 'image/svg+xml' })
    const url  = URL.createObjectURL(blob)
    const img  = new Image()
    // 3× the pt size ≈ 216 dpi — at 2× (144 dpi) vector logos look visibly soft in print
    const dpr  = 3
    // `onload` fires asynchronously, well after this Promise executor has
    // already returned — a synchronous throw in here (e.g. canvas.toBlob()
    // on a tainted canvas throws "Tainted canvases may not be exported"
    // immediately, not via its callback, for an SVG with embedded content
    // the browser treats as cross-origin-tainting, such as a <foreignObject>)
    // is NOT caught by the executor's own implicit try/catch and becomes an
    // unhandled page-level error instead of a rejected promise — confirmed
    // via a real render that crashed the whole page. Reject explicitly so
    // the SAME "one unloadable SVG must not kill the export" contract
    // rasterizeSVGs already relies on actually holds for this failure mode.
    img.onload = () => {
      URL.revokeObjectURL(url)
      try {
        const canvas = document.createElement('canvas')
        canvas.width  = Math.round(drawW * dpr)
        canvas.height = Math.round(drawH * dpr)
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        canvas.toBlob(rasterized => {
          if (!rasterized) { reject(new Error('SVG rasterization failed')); return }
          rasterized.arrayBuffer().then(buf => resolve(new Uint8Array(buf))).catch(reject)
        }, 'image/png')
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG load failed')) }
    img.src = url
  })
}

// must be awaited before applyToPDF if the command list may contain SVGs
export async function rasterizeSVGs(commands: DrawCommand[]): Promise<void> {
  // key includes dimensions so the same SVG at different sizes rasterizes independently
  const byContent = new Map<string, Promise<Uint8Array>>()
  const keyOf     = (c: ImageCommand) => `${_hashBytes(c.src)}|${c.w}|${c.h}`
  const jobs: Array<{ cmd: ImageCommand; key: string }> = []

  for (const c of commands) {
    if (c.type !== 'image') continue
    if (c.format !== 'svg') continue
    const key = keyOf(c)
    if (!byContent.has(key)) {
      // one unloadable SVG must not reject the Promise.all below and kill the export —
      // resolve to empty bytes so the command keeps format 'svg' and applyToPDF skips it
      byContent.set(key, svgToPng(c.src, c.w, c.h).catch(err => {
        console.warn('[daepdf] SVG rasterization failed – image skipped.', err)
        return new Uint8Array(0)
      }))
    }
    jobs.push({ cmd: c, key })
  }

  await Promise.all(byContent.values())

  for (const { cmd, key } of jobs) {
    const png = await byContent.get(key)!
    if (png.length > 0) {
      ;(cmd as unknown as Record<string, unknown>)['src']    = png
      ;(cmd as unknown as Record<string, unknown>)['format'] = 'png'
    }
  }
}
