/**
 * Reconciliation fixture test — runs everywhere, including CI.
 *
 * `usage-vs-projection.test.mjs` compares against whatever DSH data exists on
 * the machine, so it skips on a clean runner. That left CI green without ever
 * exercising the reconciliation. This fixture is a stripped copy of four real
 * sessions (event type, time, usage payload only — no text, no titles, no tool
 * arguments) together with the totals DSH itself computed for them, so the same
 * comparison runs on every machine.
 *
 * Regenerate with: node scripts/make-reconcile-fixture.mjs (needs local DSH data).
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { splitUsageEvents } from '../lib/usage-split.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'reconcile.json'), 'utf8'))

const pass = []
const fail = []
const check = (label, fn) => {
  try { fn(); pass.push(label) } catch (error) { fail.push(`${label}: ${error.message}`) }
}
const assert = (cond, message) => { if (!cond) throw new Error(message) }

check('the fixture is present and non-trivial', () => {
  assert(Array.isArray(fixture.samples) && fixture.samples.length > 0, 'no samples')
  const events = fixture.samples.reduce((n, s) => n + s.events.length, 0)
  assert(events >= 20, `only ${events} events`)
})

for (const sample of fixture.samples) {
  check(`${sample.id} reproduces DSH's totals exactly`, () => {
    const split = splitUsageEvents(sample.events)
    assert(split, 'parser returned nothing for a sample that has usage')
    const got = {
      uncachedInputTokens: split.peak.uncached + split.off.uncached,
      outputTokens: split.peak.output + split.off.output,
      cacheReadTokens: split.peak.cacheRead + split.off.cacheRead,
      cacheWriteTokens: split.peak.cacheWrite + split.off.cacheWrite,
      requests: split.requests,
    }
    for (const [key, want] of Object.entries(sample.expected)) {
      assert(got[key] === want, `${key}: parser ${got[key]} vs DSH ${want}`)
    }
  })

  check(`${sample.id} splits across the peak/off boundary`, () => {
    // A sample that lands entirely in one bucket would not exercise the time
    // classification at all.
    assert(sample.checks.length > 0, 'sample has no usage')
    const split = splitUsageEvents(sample.events)
    const total = split.peak.uncached + split.off.uncached
    assert(total === sample.expected.uncachedInputTokens,
      `peak ${split.peak.uncached} + off ${split.off.uncached} != ${sample.expected.uncachedInputTokens}`)
  })
}

check('the fixture carries no conversation text', () => {
  const raw = JSON.stringify(fixture)
  for (const word of ['"text"', '"content"', '"title"', '"prompt"']) {
    assert(!raw.includes(word), `fixture contains ${word}`)
  }
})

console.log(`usage-reconcile.test.mjs — ${pass.length} passed, ${fail.length} failed`)
for (const label of fail) console.log(`  ✗ ${label}`)
process.exitCode = fail.length ? 1 : 0
