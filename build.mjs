import { build } from 'tsdown'
import { copyFileSync } from 'node:fs'

// One rolled-up declaration rather than tsc's per-module emit, which would publish
// every internal type alongside the public surface.
// No sourcemap: the map was larger than the bundle it described.
await build({
  entry: ['index.ts'],
  outDir: 'dist',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  dts: true,
  clean: true,
  sourcemap: false,
})

// initEngine resolves the module with new URL('./daegun.wasm', import.meta.url),
// so the binary has to sit beside the emitted entry, not under its source path
copyFileSync('src/daegun/wasm/daegun.wasm', 'dist/daegun.wasm')
