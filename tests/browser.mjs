// For suites that need a real layout engine: bundles src, serves it and its fixtures over http
// (fonts and images need it), and runs one page per call in headless Chrome over CDP.
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findChrome } from './chrome.mjs'
import { FONT } from './fixtures.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

let bundle = null
async function bundleSrc() {
  bundle ??= build({
    stdin: {
      contents: [
        `export * from './src/index.js'`,
        `export { default as initEngine, list_registered_fonts } from './src/daegun/wasm/daegun.js'`,
        `export { default as pdf } from './index.js'`,
      ].join('\n'),
      resolveDir: ROOT, loader: 'ts',
    },
    // ESM, so import.meta.url resolves the engine's default wasm location as in dist
    bundle: true, write: false, format: 'esm', target: 'es2022', logLevel: 'error',
  }).then(r => r.outputFiles[0].text)
  return bundle
}

// Why a suite skips, or null when it can run.
export function browserUnavailable() {
  if (!findChrome()) return 'no Chrome found (set CHROME_BIN)'
  if (typeof WebSocket === 'undefined') return 'needs a Node with global WebSocket (22+)'
  return null
}

export const hasTestFont = () => existsSync(FONT)

function serve(files) {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const entry = files[url.pathname.slice(1)]
    if (entry === undefined) { res.writeHead(404); res.end(); return }
    const { body, type, delayMs } = typeof entry === 'object' && !(entry instanceof Uint8Array) && !Buffer.isBuffer(entry) ? entry : { body: entry }
    if (delayMs) await new Promise(r => setTimeout(r, delayMs))
    res.writeHead(200, { 'content-type': type ?? types[path.extname(url.pathname)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)))
}

async function drive(chrome, url, width, timeoutMs) {
  const dir = mkdtempSync(path.join(tmpdir(), 'daepdf-browser-'))
  const proc = spawn(chrome, [
    '--headless', '--disable-gpu', '--no-sandbox', `--window-size=${width},1000`,
    '--remote-debugging-port=0', `--user-data-dir=${path.join(dir, 'profile')}`, url,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let log = ''
      proc.stderr.on('data', d => { log += d; const m = log.match(/ws:\/\/\S+/); if (m) resolve(m[0]) })
      proc.on('exit', () => reject(new Error(`Chrome exited before DevTools came up\n${log.slice(-500)}`)))
    })
    const targets = await (await fetch(endpoint.replace('ws://', 'http://').replace(/\/devtools\/.*/, '/json/list'))).json()
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let id = 0
    const read = () => new Promise(resolve => {
      const sent = ++id
      ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === sent) resolve(m) }
      ws.send(JSON.stringify({ id: sent, method: 'Runtime.evaluate', params: { expression: 'window.__result', returnByValue: true } }))
    })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = (await read()).result?.result?.value
      if (value) { ws.close(); return value }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`page produced no result within ${timeoutMs / 1000}s`)
  } finally {
    proc.kill()
  }
}

// Runs `script`, an async function body seeing the bundle as `D` (engine ready unless `init`
// is false), on a page of `head`/`body`; `files` add fixtures, the test font is font.ttf.
export async function runPage({ script, head = '', body = '', files = {}, width = 1600, timeoutMs = 60000, init = true }) {
  const chrome = findChrome()
  const page = `<!doctype html><html><head><meta charset="utf-8">
<script>window.onerror = (m, s, l, c, e) => { window.__result ??= { error: String(e && e.stack || m) } }</script>${head}</head><body>${body}
<script type="module">
import * as D from './daepdf.js'
const toB64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s) }
;(async () => {
  ${init ? 'await D.initEngine()' : ''}
  ${script}
})().then(value => { window.__result = { value } }, e => { window.__result = { error: String(e && e.stack || e) } })
</script></body></html>`
  const server = await serve({
    'page.html': page,
    'daepdf.js': await bundleSrc(),
    'daegun.wasm': readFileSync(path.join(ROOT, 'src/daegun/wasm/daegun.wasm')),
    ...(hasTestFont() ? { 'font.ttf': readFileSync(FONT) } : {}),
    ...files,
  })
  try {
    const result = await drive(chrome, `http://127.0.0.1:${server.address().port}/page.html`, width, timeoutMs)
    if (result.error) throw new Error(result.error)
    return result.value
  } finally {
    server.close()
  }
}

// runPage for a suite: a page that throws becomes one failing test, not a crashed runner
export async function runSuitePage(test, options) {
  try {
    return await runPage(options)
  } catch (e) {
    test('browser page runs', () => { throw e })
    return null
  }
}
