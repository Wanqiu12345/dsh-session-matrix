/**
 * Build a committed, anonymised reconciliation fixture from real DSH logs.
 *
 * The CI job has no DSH data, so the local 37/37 check skips there. This strips
 * a few real sessions down to the only fields the parser reads — event type,
 * timestamp, and the usage payload — and records the totals DSH itself computed,
 * so the comparison can run anywhere without shipping anyone's conversations.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { decompressFrames, splitUsageEvents } from '../plugin/agent-workspa../lib/usage-split.js'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const sessionsRoot = join(home, 'sessions')
const cacheRoot = join(home, 'storages', 'session_projcache', 'sessions')
const outFile = 'test/fixtures/reconcile.json'

const totals = new Map()
for (const file of readdirSync(cacheRoot)) {
  if (!file.endsWith('.json')) continue
  try {
    const record = JSON.parse(readFileSync(join(cacheRoot, file), 'utf8'))
    const value = record?.record?.rows?.tokenUsage?.val ?? record?.record?.rows?.tokenUsage
    if (value?.totals) totals.set(file.replace(/\.json$/, '').replace(/^session-/, ''), value.totals)
  } catch { /* ignore a half-written cache entry */ }
}

const samples = []
for (const dir of readdirSync(sessionsRoot)) {
  if (!statSync(join(sessionsRoot, dir)).isDirectory()) continue
  for (const entry of readdirSync(join(sessionsRoot, dir), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(sessionsRoot, dir, entry.name, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const want = totals.get(entry.name)
    if (!want) continue
    let text = ''
    try { text = decompressFrames(readFileSync(file), zstdDecompressSync) } catch { continue }

    const events = []
    for (const line of text.split('\n')) {
      if (!line.includes('assistant/')) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
      // Keep the shape the parser walks and nothing else: no message text, no
      // prompt, no tool arguments, no titles.
      const kept = { type: event.type, time: event.time, data: {} }
      if (event.data?.usage) kept.data.usage = event.data.usage
      const chunks = (event.data?.stream ?? [])
        .filter(r => r?.chunk?.type === 'usage')
        .map(r => ({ time: r.time, chunk: { type: 'usage', usage: r.chunk.usage } }))
      if (chunks.length) kept.data.stream = chunks
      events.push(kept)
    }
    if (!events.length) continue

    const split = splitUsageEvents(events)
    if (!split) continue
    const sum = bucket => ({
      input: bucket.uncached + bucket.cacheRead + bucket.cacheWrite,
      output: bucket.output,
    })
    samples.push({
      // Stable anonymous label: a hash-free counter, not the real session id.
      id: `sample-${samples.length + 1}`,
      events,
      expected: {
        // DSH's own totals, which the parser must reproduce exactly.
        uncachedInputTokens: want.uncachedInputTokens ?? 0,
        outputTokens: want.outputTokens ?? 0,
        cacheReadTokens: want.cacheReadTokens ?? 0,
        cacheWriteTokens: want.cacheWriteTokens ?? 0,
        requests: split.requests,
      },
      checks: [...(sum(split.peak).input ? ['peak'] : []), ...(sum(split.off).input ? ['off'] : [])],
    })
    if (samples.length >= 4) break
  }
  if (samples.length >= 4) break
}

if (!samples.length) throw new Error('no usable samples; run where DSH data exists')
mkdirSync('test/fixtures', { recursive: true })
writeFileSync(outFile, JSON.stringify({ generatedAt: 'fixed', samples }, null, 1) + '\n')
console.log('wrote', outFile, '| samples:', samples.length,
  '| events:', samples.reduce((n, s) => n + s.events.length, 0))
