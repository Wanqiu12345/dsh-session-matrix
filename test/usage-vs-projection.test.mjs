/**
 * Cross-check the log parser against the host's own totals.
 *
 * For every session we can read, sum the usage the parser finds and compare it
 * with `tokenUsage.totals` from the projection cache — the number DSH itself
 * computed while the session ran. A parser that misses `assistant/attempt`
 * shows up here as a shortfall.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { join } from 'node:path'
import { decompressFrames, splitUsageText } from '../lib/usage-split.js'

const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME, '.dsh')
const sessionsRoot = join(home, 'sessions')
const cacheRoot = join(home, 'storages', 'session_projcache', 'sessions')

if (!existsSync(sessionsRoot) || !existsSync(cacheRoot)) {
  console.log('usage-vs-projection.test.mjs — skipped (no local DSH data)')
  process.exit(0)
}

/** session id → tokenUsage totals, from the projection cache. */
const totals = new Map()
for (const file of readdirSync(cacheRoot)) {
  if (!file.endsWith('.json')) continue
  try {
    const record = JSON.parse(readFileSync(join(cacheRoot, file), 'utf8'))
    const value = record?.record?.rows?.tokenUsage?.val ?? record?.record?.rows?.tokenUsage
    const t = value?.totals
    if (t) totals.set(file.replace(/\.json$/, ''), t)
  } catch { /* a half-written cache file is not interesting */ }
}

let compared = 0
let exact = 0
const diffs = []
for (const dir of readdirSync(sessionsRoot)) {
  const ws = join(sessionsRoot, dir)
  if (!statSync(ws).isDirectory()) continue
  for (const entry of readdirSync(ws, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(ws, entry.name, 'session.v4.jsonl.zstd')
    if (!existsSync(file)) continue
    const want = totals.get(`session-${entry.name}`) ?? totals.get(entry.name)
    if (!want) continue
    let text = ''
    try {
      text = decompressFrames(readFileSync(file), zstdDecompressSync)
    } catch { continue }
    const split = splitUsageText(text)
    if (!split) continue
    const got = {
      input: split.peak.uncached + split.off.uncached,
      output: split.peak.output + split.off.output,
      cacheRead: split.peak.cacheRead + split.off.cacheRead,
      cacheWrite: split.peak.cacheWrite + split.off.cacheWrite,
    }
    compared += 1
    const delta = Math.abs(got.input - (want.uncachedInputTokens ?? 0))
      + Math.abs(got.output - (want.outputTokens ?? 0))
      + Math.abs(got.cacheRead - (want.cacheReadTokens ?? 0))
      + Math.abs(got.cacheWrite - (want.cacheWriteTokens ?? 0))
    if (delta === 0) exact += 1
    else if (diffs.length < 3) diffs.push({ id: entry.name.slice(0, 8), got, want, delta })
  }
}

console.log(`usage-vs-projection.test.mjs — ${exact}/${compared} sessions match exactly`)
for (const d of diffs) console.log('  diff', JSON.stringify(d))
process.exitCode = compared > 0 && exact === compared ? 0 : 1
