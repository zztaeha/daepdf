// 2D affine matrices [a, b, c, d, e, f], mapping x' = a*x + c*y + e, y' = b*x + d*y + f:
// the convention of CSS matrix(), SVG transform lists and PDF's cm alike.
export type Affine = [number, number, number, number, number, number]

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

// composes m2 ∘ m1 (m1 applied first, then m2)
export function composeAffine(m2: Affine, m1: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a2 * a1 + c2 * b1,
    b2 * a1 + d2 * b1,
    a2 * c1 + c2 * d1,
    b2 * c1 + d2 * d1,
    a2 * e1 + c2 * f1 + e2,
    b2 * e1 + d2 * f1 + f2,
  ]
}

// null when the matrix collapses the plane
export function invertAffine([a, b, c, d, e, f]: Affine): Affine | null {
  const det = a * d - b * c
  if (Math.abs(det) < 1e-12) return null
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det]
}

// The cm for a CSS matrix (e, f in pt) pivoting at origin (pt, y down) on a page pageH tall:
// flipping y negates b, c and f, then the whole is conjugated by the origin.
export function cssToPdfMatrix(css: Affine, originX: number, originY: number, pageH: number): Affine {
  const [a, b, c, d, e, f] = css
  const flipped: Affine = [a, -b, -c, d, e, -f]
  const oy = pageH - originY
  return composeAffine([1, 0, 0, 1, originX, oy], composeAffine(flipped, [1, 0, 0, 1, -originX, -oy]))
}
