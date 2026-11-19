/**
 * costOfBuckets edge cases — malformed host projections must degrade to zero,
 * never NaN, because one NaN poisons the subtree aggregate.
 */

import { costOfBuckets } from '../lib/index.js'

const pass = []
const fail = []
const check = (label, fn) => {
  try { fn(); pass.push(label) } catch (error) { fail.push(`${label}: ${error.message}`) }
}
const assert = (cond, message) => { if (!cond) throw new Error(message) }

const CNY = () => ({ miss: 1, hit: 0.02, out: 4 })
const PEAK = { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }
// peak 1M miss ×1 + 1M out ×4 → ¥5；峰时 ×2 → ¥10

check('正常桶：峰时 ×2 计费', () => {
  const r = costOfBuckets({ cost: { deepseek: { 'deepseek-flash': { peak: PEAK } } } }, () => null, CNY)
  assert(Math.abs(r.cny - 10) < 1e-9, `peak cost should be ¥10, got ${r.cny}`)
  assert(r.peakBuckets === 1 && r.buckets === 1, 'bucket counts')
})

check('畸形桶（数字/缺失字段）：跳过，不产生 NaN', () => {
  const r = costOfBuckets({ cost: { deepseek: { 'deepseek-flash': { peak: 42, off: { uncached: 'x', cacheRead: null } } } } }, () => null, CNY)
  assert(r !== null && Number.isFinite(r.cny), `expected finite, got ${r && r.cny}`)
})

check('桶内负值与非数字字段：按 0 处理', () => {
  const r = costOfBuckets({
    cost: { deepseek: { 'deepseek-flash': { peak: { uncached: -5, cacheRead: 'x', cacheWrite: 'x', output: NaN } } } },
  }, () => null, CNY)
  assert(r.cny === 0, `all-invalid fields must bill ¥0, got ${r.cny}`)
})
check('缓存写入按未命中价计（DeepSeek 无独立写入价）', () => {
  const r = costOfBuckets({
    cost: { deepseek: { 'deepseek-flash': { peak: { uncached: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 } } } },
  }, () => null, CNY)
  assert(Math.abs(r.cny - 2) < 1e-9, `1M write ×1 ×2 = ¥2, got ${r.cny}`)
})

check('非对象桶整体跳过', () => {
  const r = costOfBuckets({ cost: { deepseek: { 'deepseek-flash': { peak: null, off: 7 } } } }, () => null, CNY)
  assert(r === null, 'no valid buckets → null')
})

check('缓存命中按命中价计', () => {
  const r = costOfBuckets({
    cost: { deepseek: { 'deepseek-flash': { peak: { uncached: 0, cacheRead: 1_000_000, output: 0 } } } },
  }, () => null, CNY)
  assert(Math.abs(r.cny - 0.04) < 1e-9, `1M hit ×0.02 ×2 = ¥0.04, got ${r.cny}`)
})

console.log(`cost-buckets.test.mjs — ${pass.length} passed, ${fail.length} failed`)
for (const label of fail) console.log(`  ✗ ${label}`)
process.exitCode = fail.length ? 1 : 0
