// Minimal zero-dependency runner. Each test file default-exports a function
// receiving { test, eq, ok, hex, bytes }.
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from './load.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
let pass = 0, fail = 0
const failures = []

const hex = b => Buffer.from(b).toString('hex')
const bytes = h => new Uint8Array(Buffer.from(h, 'hex'))

function makeCtx(file, pending) {
  const failed = (name, e) => { fail++; failures.push(`${file} › ${name}\n    ${e?.message ?? e}`) }
  return {
    hex, bytes, load,
    test(name, fn) {
      try {
        const r = fn()
        if (r instanceof Promise) pending.push(r.then(() => { pass++ }, e => failed(name, e)))
        else pass++
      } catch (e) { failed(name, e) }
    },
    eq(actual, expected, msg = '') {
      const a = typeof actual === 'object' ? hex(actual) : String(actual)
      const b = typeof expected === 'object' ? hex(expected) : String(expected)
      if (a !== b) throw new Error(`${msg}\n    expected ${b}\n    actual   ${a}`)
    },
    ok(cond, msg = 'expected truthy') { if (!cond) throw new Error(msg) },
  }
}

const only = process.argv[2] ?? ''
for (const f of readdirSync(HERE).filter(name => name.endsWith('.test.mjs')).sort()) {
  if (only && !f.includes(only)) continue
  const mod = await import(pathToFileURL(path.join(HERE, f)).href)
  const pending = []
  await mod.default(makeCtx(f.replace('.test.mjs', ''), pending))
  await Promise.all(pending)
}

console.log(`\n${pass} passed, ${fail} failed`)
for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(fail ? 1 : 0)
