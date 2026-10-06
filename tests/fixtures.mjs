import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

export const WASM = path.join(ROOT, 'src/daegun/wasm/daegun.wasm')

// The suite needs a real variable font to shape and subset against, and the
// repo deliberately ships no font assets — point DAEPDF_TEST_FONT at one.
export const FONT = process.env.DAEPDF_TEST_FONT
  ?? path.resolve(ROOT, '../../web-apps/beom-cv/public/fonts/inter-var.ttf')

export function requireFont() {
  if (existsSync(FONT)) return FONT
  throw new Error(
    `[daepdf tests] Test font not found at ${FONT}\n` +
    `Set DAEPDF_TEST_FONT to a variable TTF/OTF, e.g.\n` +
    `  DAEPDF_TEST_FONT=/path/to/Inter-Variable.ttf node tests/run.mjs`,
  )
}

// every font-dependent suite needs the same two steps, in this order
export async function bootEngine({ initEngine, register_font_raw }, name = 'Inter') {
  await initEngine(readFileSync(WASM))
  register_font_raw(name, new Uint8Array(readFileSync(requireFont())))
}
