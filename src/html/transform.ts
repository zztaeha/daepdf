// CSS transforms: 2D affine only (rotate/scale/skew/translate/matrix). Any
// matrix3d(...)/perspective resolves to a 16-value 3D matrix computed style
// has no 2D equivalent for — those elements render untransformed rather than
// risk a wrong projection.

import type { Affine } from '../types/affine.js'

// getComputedStyle(el).transform always resolves to this form for a 2D
// transform (browsers only emit matrix3d for anything with 3D components)
export function parseCSSMatrix(transformStr: string): Affine | null {
  const m = transformStr.match(/^matrix\(([^)]+)\)$/)
  if (!m) return null
  const parts = (m[1] ?? '').split(',').map(v => parseFloat(v.trim()))
  if (parts.length !== 6 || parts.some(Number.isNaN)) return null
  return parts as Affine
}
