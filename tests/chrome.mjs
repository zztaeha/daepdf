// Browser-backed suites need a real layout engine: CHROME_BIN, a standard install,
// or puppeteer's cache.
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function findChrome() {
  const home = homedir()
  const cached = (sub, tail) => {
    const base = path.join(home, '.cache', 'puppeteer', sub)
    if (!existsSync(base)) return []
    return readdirSync(base).sort().reverse().flatMap(v => {
      const dir = path.join(base, v)
      return readdirSync(dir).map(d => path.join(dir, d, tail))
    })
  }
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    ...cached('chrome-headless-shell', 'chrome-headless-shell'),
    ...cached('chrome', 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
    ...cached('chrome', 'chrome'),
  ]
  return candidates.find(c => c && existsSync(c)) ?? null
}
