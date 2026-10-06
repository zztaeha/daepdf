export default async function ({ test, eq, ok, load }) {
  const c = await load('src/html/css.ts')

  test('parseColorAlpha handles the classic computed forms', () => {
    eq(JSON.stringify(c.parseColorAlpha('rgb(255, 0, 0)')), '[255,0,0,255]')
    eq(JSON.stringify(c.parseColorAlpha('rgba(1, 2, 3, 0.5)')), '[1,2,3,128]')
    eq(JSON.stringify(c.parseColorAlpha('red')), '[255,0,0,255]')
    ok(c.parseColorAlpha('transparent') === null)
    eq(JSON.stringify(c.parseColorAlpha('transparent', true)), '[0,0,0,0]')
  })

  // What Chrome's getComputedStyle actually returns for CSS Color 4 values: it
  // preserves the function rather than converting to rgb().
  test('parseColorAlpha handles CSS Color 4 computed values', () => {
    const modern = [
      'color(srgb 1 0 0)',
      'oklch(0.7 0.1 200)',
      'lab(50% 40 30)',
      'color(display-p3 1 0 0)',
      'rgb(255 0 0)',
      'rgb(255 0 0 / 50%)',
    ]
    const dropped = modern.filter(s => c.parseColorAlpha(s) === null)
    ok(dropped.length === 0, `silently dropped, so nothing is painted: ${dropped.join(', ')}`)
  })

  // Reference values: the OKLab/CIELab coordinates of sRGB primaries are fixed
  // published quantities, so these check the conversion maths against something
  // outside the implementation rather than against itself.
  test('CSS Color 4 converts to the right sRGB values', () => {
    const near = (got, want, tol, what) => {
      ok(got, `${what}: returned null`)
      for (let i = 0; i < 3; i++) {
        ok(Math.abs(got[i] - want[i]) <= tol,
          `${what}: channel ${i} was ${got[i]}, expected about ${want[i]} — full ${JSON.stringify(got)}`)
      }
    }
    near(c.parseColorAlpha('oklab(0.6279 0.2249 0.1258)'), [255, 0, 0], 3, 'OKLab sRGB red')
    near(c.parseColorAlpha('oklch(0.6279 0.2577 29.23)'),  [255, 0, 0], 3, 'OKLCh sRGB red')
    near(c.parseColorAlpha('oklab(1 0 0)'),                [255, 255, 255], 2, 'OKLab white')
    near(c.parseColorAlpha('oklab(0 0 0)'),                [0, 0, 0], 1, 'OKLab black')
    near(c.parseColorAlpha('lab(54.29 80.80 69.89)'),      [255, 0, 0], 4, 'CIELab D50 red')
    near(c.parseColorAlpha('lab(100 0 0)'),                [255, 255, 255], 2, 'CIELab white')
    near(c.parseColorAlpha('color(srgb 1 0 0)'),           [255, 0, 0], 1, 'color(srgb) red')
    near(c.parseColorAlpha('color(srgb 0.5 0.5 0.5)'),     [128, 128, 128], 2, 'color(srgb) mid gray')
    near(c.parseColorAlpha('color(display-p3 1 0 0)'),     [255, 0, 0], 2, 'P3 red clamps into sRGB')
    near(c.parseColorAlpha('rgb(255 0 0)'),                [255, 0, 0], 0, 'space-separated rgb')
  })

  test('CSS Color 4 alpha is honored', () => {
    eq(c.parseColorAlpha('rgb(255 0 0 / 50%)')[3], 128)
    eq(c.parseColorAlpha('color(srgb 1 0 0 / 0.5)')[3], 128)
    ok(c.parseColorAlpha('oklch(0.6 0.2 30 / 0)') === null, 'fully transparent still drops by default')
    eq(c.parseColorAlpha('oklch(0.6 0.2 30 / 0)', true)[3], 0, 'unless the caller keeps zero alpha')
  })

  test('nonsense inside a color function is still rejected', () => {
    ok(c.parseColorAlpha('oklch(nope bad here)') === null)
    ok(c.parseColorAlpha('color(some-space 1 0 0)') === null)
    ok(c.parseColorAlpha('notacolor(1 2 3)') === null)
  })

  test('splitByTopLevelComma respects nesting', () => {
    eq(JSON.stringify(c.splitByTopLevelComma('a, b')), '["a","b"]')
    eq(JSON.stringify(c.splitByTopLevelComma('rgb(1,2,3), blue')), '["rgb(1,2,3)","blue"]')
  })

  test('splitByTopLevelComma does not emit empty parts', () => {
    const got = c.splitByTopLevelComma('a,,b')
    ok(!got.includes(''), `empty part leaks through: ${JSON.stringify(got)}`)
  })

  test('splitPositionPair keeps calc() intact', () => {
    eq(JSON.stringify(c.splitPositionPair('calc(100% - 10px) 20px')), '["calc(100% - 10px)","20px"]')
    eq(JSON.stringify(c.splitPositionPair('red 20% 40%')), '["red","20%","40%"]')
  })

  test('pxToPt converts and rejects', () => {
    eq(c.pxToPt('96px').toFixed(2), '72.00')
    eq(c.pxToPt('auto'), 0)
  })

  test('isTransparentColor distinguishes unparseable from transparent', () => {
    ok(c.isTransparentColor('transparent'))
    ok(c.isTransparentColor('rgba(0, 0, 0, 0)'))
    ok(!c.isTransparentColor('rgb(0, 0, 0)'))
  })

  test('parseCSSBoxShadow reads a computed shadow', () => {
    const s = c.parseCSSBoxShadow('rgba(0, 0, 0, 0.5) 0px 2px 4px 1px')
    eq(s.length, 1)
    eq(s[0].color[3], 128)
    ok(s[0].blur > 0 && s[0].spread > 0, JSON.stringify(s[0]))
  })

  test('a transparent shadow paints nothing, beside a visible one', () => {
    eq(c.parseCSSBoxShadow('rgba(0, 0, 0, 0) 0px 0px 0px 4px').length, 0)
    const s = c.parseCSSBoxShadow('rgba(0, 0, 0, 0) 2px 2px 0px, rgb(255, 0, 0) 1px 1px 0px')
    eq(JSON.stringify(s.map(x => x.color)), JSON.stringify([[255, 0, 0, 255]]))
  })

  test('clampRadiusToBox turns a huge radius into a pill', () => {
    const r = c.clampRadiusToBox({ all: 9999 }, 100, 40)
    eq(r.topLeft.v, 20, 'v should clamp to half the height')
  })

  test('overlap clamping leaves a fitting radius alone', () => {
    const r = c.clampRadiusToBox({ all: 5 }, 100, 40)
    eq(r.all, 5)
  })

  // A repeating gradient with a small period needs many tiles; the loop stops at
  // 200 stops with no diagnostic.
  test('tileStops covers the whole 0..1 range for a fine repeating gradient', () => {
    const period = 0.004   // 0.4% — 250 tiles of 2 stops
    const stops = [{ color: [255,0,0,255], position: 0 }, { color: [0,0,255,255], position: period }]
    const out = c.tileStops(stops, true)
    const last = out[out.length - 1]
    ok(last.position >= 1,
      `tiling stopped at ${last.position.toFixed(3)} instead of reaching 1 — ${out.length} stops`)
  })

  // gradient parsing: interpolation clauses, and the CSS stop-position fixup
  const resolved = (css, w = 100, h = 100) => c.resolveGradientBox(c.parseCSSGradient(css), w, h)
  const positions = g => g.stops.map(st => Math.round(st.position * 1000) / 1000).join(' ')
  const R = 'rgb(255, 0, 0)', G = 'rgb(0, 255, 0)', B = 'rgb(0, 0, 255)'

  test('an interpolation clause does not hide the direction', () => {
    eq(c.parseCSSGradient(`linear-gradient(to right in oklch, ${R}, ${B})`).angle, 90)
    eq(c.parseCSSGradient(`linear-gradient(90deg in hsl longer hue, ${R}, ${B})`).angle, 90)
  })

  test('an interpolation clause is not counted as a stop', () => {
    eq(positions(resolved(`linear-gradient(in oklab, ${R}, ${B})`)), '0 1')
    const radial = resolved(`radial-gradient(circle in oklab, ${R}, ${B})`)
    ok(Number.isFinite(radial.rx) && Number.isFinite(radial.ry), `radial radii ${radial.rx} ${radial.ry}`)
  })

  test('implicit stop positions follow the CSS fixup', () => {
    // a run without positions spreads between its neighbors, not by index over the whole list
    eq(positions(resolved(`linear-gradient(${R}, rgb(255, 255, 0), ${B} 30%)`)), '0 0.15 0.3')
    // a hint is not a stop and takes no slot
    eq(positions(resolved(`linear-gradient(${R}, 30%, ${G}, ${B})`)), '0 0.5 1')
    // a position below an earlier one is raised to it
    eq(positions(resolved(`linear-gradient(${R} 60%, ${B} 20%)`)), '0.6 0.6')
  })

  test('conic stops use the same fixup', () => {
    const g = c.parseCSSConicGradient(`conic-gradient(in oklab, ${R}, ${G} 90deg, ${B})`)
    eq(g.stops.map(st => Math.round(st.position * 1000) / 1000).join(' '), '0 0.25 1')
  })

  test('a conic center keeps px positions, as computed style serializes them', () => {
    const g = c.parseCSSConicGradient(`conic-gradient(from 90deg at 10px 20%, ${R}, ${B})`)
    eq(JSON.stringify([g.fromDeg, g.position, g.stops.length]), JSON.stringify([90, ['10px', '20%'], 2]))
  })

  test('a fully transparent CSS Color 4 color counts as transparent', () => {
    eq(['transparent', 'rgba(0, 0, 0, 0)', 'oklch(0.5 0.1 20 / 0)', 'color(srgb 1 0 0 / 0)', 'rgb(0, 0, 0)', 'nonsense']
      .map(v => c.isTransparentColor(v)).join(), 'true,true,true,true,false,false')
  })

  test('clip-path shapes resolve calc() and a geometry box', async () => {
    const { parseClipPath } = await load('src/html/clippath.ts')
    const box = { x: 0, y: 0, w: 75, h: 75 }
    const style = { borderTopWidth: '10px', borderRightWidth: '10px', borderBottomWidth: '10px', borderLeftWidth: '10px',
      paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px' }
    const notch = parseClipPath('polygon(0px 0px, calc(100% - 20px) 0px, 100% 20px, 100% 100%, 0px 100%)', box, style)
    eq(JSON.stringify(notch.ops.map(o => o.args)), JSON.stringify([[0, 0], [60, 0], [75, 15], [75, 75], [0, 75]]))
    const inPad = parseClipPath('circle(50%) padding-box', box, style)
    eq(JSON.stringify([inPad.x, inPad.y, inPad.w]), JSON.stringify([7.5, 7.5, 60]))
    eq(parseClipPath('inset(calc(10% + 5px) 10px)', box, style).y, 11.25)
    const circ = parseClipPath('circle(calc(50% - 10px))', box, style)
    eq(JSON.stringify([circ.x, circ.w]), JSON.stringify([7.5, 60]))
    const ell = parseClipPath('ellipse(calc(50% - 5px) 20px)', box, style)
    eq(JSON.stringify([ell.w, ell.h]), JSON.stringify([67.5, 30]))
  })

  test('path data reads run-together arc flags, and a missing number as 0', async () => {
    const { parseSvgPath } = await load('src/html/clippath.ts')
    const arc = parseSvgPath('M0 0A7 7 0 105 9.3')
    eq(JSON.stringify(arc.at(-1).args.slice(-2)), JSON.stringify([5, 9.3]))
    eq(JSON.stringify(parseSvgPath('M0 0L5').at(-1)), JSON.stringify({ op: 'l', args: [5, 0] }))
  })

  test('a calc() border radius resolves instead of going square', () => {
    const style = { borderTopLeftRadius: 'calc(50% - 10px)', borderTopRightRadius: '0px', borderBottomRightRadius: '0px', borderBottomLeftRadius: 'calc(1em)' }
    const r = c.parseBorderRadius(style, undefined, { w: 75, h: 75 })
    eq(JSON.stringify([r.topLeft, r.bottomLeft]), JSON.stringify([{ h: 30, v: 30 }, { h: 0, v: 0 }]))
  })
}
