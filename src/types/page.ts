export type PageSize =
  | 'A3' | 'A4' | 'A5'
  | 'Letter' | 'Legal' | 'Tabloid'
  | { width: number; height: number }

export interface PageConfig {
  size:         PageSize
  orientation?: 'portrait' | 'landscape' | undefined
}

export function resolvePageSize(size: PageSize, orientation?: 'portrait' | 'landscape'): { width: number; height: number } {
  let w: number, h: number
  if (typeof size === 'object') {
    w = size.width; h = size.height
    // A degenerate custom size (0/negative/NaN) reaches paginate()/paginateSpan()
    // (src/html/types.ts) as a division by zero, producing page:Infinity/NaN
    // on emitted commands — which then makes PdfDoc.set_page()'s
    // `while (allPageBufs.length < n) addPageInternal()` loop forever, hanging
    // the tab instead of just producing a bad PDF. Failing fast here, the same
    // way renderHTMLtoPDF already throws immediately for an invalid pdfA+security
    // combination rather than let it surface as a much stranger failure downstream.
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      throw new Error(`[daepdf] Invalid custom page size {width: ${w}, height: ${h}} – both must be finite, positive numbers.`)
    }
  } else {
    const A4: [number, number] = [595.28, 841.89]
    const presets: Record<string, [number, number]> = {
      A3:      [841.89, 1190.55],
      A4,
      A5:      [419.53,  595.28],
      Letter:  [612,     792],
      Legal:   [612,    1008],
      Tabloid: [792,    1224],
    }
    const [pw, ph] = presets[size] ?? A4
    w = pw; h = ph
  }
  if (orientation === 'landscape') return { width: Math.max(w, h), height: Math.min(w, h) }
  return { width: w, height: h }
}
