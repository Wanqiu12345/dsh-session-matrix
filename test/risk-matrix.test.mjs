/**
 * Multi-factor risk matrix tests — docs/32 §3.
 *
 * The point of this matrix is the first row: a fresh session (zero
 * compactions) crossing the critical occupancy line for the first time is
 * still fully usable — its history has never been rebuilt — so it must NOT
 * read as a handoff alarm. Occupancy decides WHEN compaction looms; the
 * compaction count decides WHETHER a handoff is worth it.
 */

import { riskLevel, countCheckpoints } from '../lib/index.js'

const pass = []
const fail = []
const check = (label, fn) => {
  try { fn(); pass.push(label) } catch (error) { fail.push(`${label}: ${error.message}`) }
}
const assert = (cond, message) => { if (!cond) throw new Error(message) }

// 1M window, 256k output → point = 788,480 (75.2%), like the README example.
const POINT = { ratio: 788480 / 1048576 }
const CFG = { warnFactor: 0.8, criticalFactor: 0.92 }
const CRIT = POINT.ratio * CFG.criticalFactor
const WARN = POINT.ratio * CFG.warnFactor
const FRESH = Date.now() - 5 * 60_000 // 5 minutes ago

check('0 次压缩：临界占用降级为注意（首次接近，不推交接）', () => {
  assert(riskLevel(CRIT + 1, POINT, CFG, { compactions: 0 }) === 'warn',
    'first approach at critical must read warn')
})
check('0 次压缩：注意占用为注意', () => {
  assert(riskLevel(WARN + 1, POINT, CFG, { compactions: 0 }) === 'warn',
    'first approach below critical is warn')
})
check('1–2 次压缩：临界占用为临界（建议交接）', () => {
  for (const n of [1, 2]) {
    assert(riskLevel(CRIT + 1, POINT, CFG, { compactions: n }) === 'crit',
      `${n} compactions at critical must read crit`)
  }
})
check('≥3 次压缩：注意占用即升级为临界', () => {
  for (const n of [3, 5, 9]) {
    assert(riskLevel(WARN + 1, POINT, CFG, { compactions: n }) === 'crit',
      `${n} compactions at warn must read crit`)
  }
})
check('≥3 次压缩但占用正常：仍为正常（刚重建的历史有全部余量）', () => {
  assert(riskLevel(0.1, POINT, CFG, { compactions: 4 }) === 'ok',
    'fresh headroom must not stay flagged')
})
check('刚压缩完 10 分钟内：临界降级为注意（摘要最新鲜）', () => {
  assert(riskLevel(CRIT + 1, POINT, CFG, { compactions: 3, lastCompactionAt: FRESH }) === 'warn',
    'fresh summary demotes crit to warn')
})
check('压缩发生在 10 分钟前：新鲜度豁免不适用', () => {
  const old = Date.now() - 11 * 60_000
  assert(riskLevel(CRIT + 1, POINT, CFG, { compactions: 2, lastCompactionAt: old }) === 'crit',
    'stale summary keeps crit')
})
check('压缩次数未知：维持占用单指标行为', () => {
  assert(riskLevel(CRIT + 1, POINT, CFG, null) === 'crit', 'null stats keeps crit')
  assert(riskLevel(CRIT + 1, POINT, CFG, { compactions: null }) === 'crit',
    'null count keeps crit')
})
check('无压缩点（未知模型）：沿用 85%/70% 兜底', () => {
  assert(riskLevel(0.86, null, CFG, { compactions: 0 }) === 'warn', '0.86 fallback warn')
  assert(riskLevel(0.9, null, CFG, { compactions: 4 }) === 'crit', '0.9 fallback crit')
})
check('占用未知：unknown', () => {
  assert(riskLevel(null, POINT, CFG, { compactions: 0 }) === 'unknown')
})
check('占用低于注意线恒为 ok（新鲜度豁免也不越级）', () => {
  assert(riskLevel(0.1, POINT, CFG, { compactions: 2, lastCompactionAt: FRESH }) === 'ok',
    'low occupancy stays ok even when fresh')
})

check('countCheckpoints：从事件流数检查点并取最新时间', () => {
  const events = [
    { type: 'user/message', time: 100, data: { content: 'hi' } },
    { type: 'user/message', time: 200, data: { source: { kind: 'compact-checkpoint', compactionId: 'a' } } },
    { type: 'assistant/message', time: 300, data: { usage: {} } },
    { type: 'user/message', time: 400, data: { source: { kind: 'compact-checkpoint', compactionId: 'b' } } },
  ]
  const { compactions, lastCompactionAt } = countCheckpoints(events)
  assert(compactions === 2, `expected 2 checkpoints, got ${compactions}`)
  assert(lastCompactionAt === 400, `expected last time 400, got ${lastCompactionAt}`)
})
check('countCheckpoints：没有检查点时返回 0 / null', () => {
  const { compactions, lastCompactionAt } = countCheckpoints([
    { type: 'user/message', time: 1, data: {} },
  ])
  assert(compactions === 0 && lastCompactionAt === null, 'empty stream must be 0/null')
})

console.log(`risk-matrix.test.mjs — ${pass.length} passed, ${fail.length} failed`)
for (const label of fail) console.log(`  ✗ ${label}`)
process.exitCode = fail.length ? 1 : 0
