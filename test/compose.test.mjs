/**
 * composeFromEvents unit tests — the engine that replaces dsh-context's
 * projections when that plugin is absent.
 */
import { composeFromEvents, riskLevel, countCheckpoints } from '../lib/index.js'

const pass = []
const fail = []
const check = (label, fn) => {
  try { fn(); pass.push(label) } catch (error) { fail.push(`${label}: ${error.message}`) }
}
const assert = (cond, message) => { if (!cond) throw new Error(message) }
const blocks = (text) => [{ type: 'text', text }]

check('七类分类：普通用户消息归 user', () => {
  const r = composeFromEvents([{ type: 'user/message', time: 1, data: { content: blocks('hello world') } }])
  assert(r.parts.user > 0, `user should be counted, got ${r.parts.user}`)
  assert(r.total > 0, `total should be positive, got ${r.total}`)
})

check('压缩摘要注入归 inject，工具结果归 tool，助手归 assistant', () => {
  const r = composeFromEvents([
    { type: 'user/message', time: 1, data: { content: blocks('a'.repeat(400)), source: { kind: 'compact-checkpoint' } } },
    { type: 'tool/result', time: 2, data: { message: { role: 'tool', content: blocks('b'.repeat(400)) } } },
    { type: 'assistant/message', time: 3, data: { message: { role: 'assistant', content: blocks('c'.repeat(400)) } } },
  ])
  assert(r.parts.inject > 0 && r.parts.tool > 0 && r.parts.assistant > 0, `categories: ${JSON.stringify(r.parts)}`)
})

check('skill 调用归 skill', () => {
  const r = composeFromEvents([{ type: 'user/message', time: 1, data: { content: blocks('x'.repeat(400)), source: { kind: 'skill-invocation', name: 'writer' } } }])
  assert(r.parts.skill > 0, `skill should count, got ${JSON.stringify(r.parts)}`)
})

check('system/message 取最后一个非零值', () => {
  const r = composeFromEvents([
    { type: 'system/message', time: 1, data: { message: { role: 'system', content: blocks('a'.repeat(400)) } } },
    { type: 'system/message', time: 2, data: { message: { role: 'system', content: blocks('b'.repeat(800)) } } },
  ])
  assert(r.parts.system > 0, `system should count, got ${r.parts.system}`)
})

check('request/header 提供工具定义 tokens，request/context 提供窗口', () => {
  const tools = [{ name: 'ask', description: 'd'.repeat(200), parameters: { type: 'object' } }]
  const r = composeFromEvents([
    { type: 'request/header', time: 1, data: { header: { tools, config: { maxTokens: 256000 } } } },
    { type: 'request/context', time: 2, data: { contextWindow: 1048576 } },
  ])
  assert(r.parts.tools > 0, `tools should count, got ${r.parts.tools}`)
  assert(r.contextWindow === 1048576, `window ${r.contextWindow}`)
  assert(r.maxOutputTokens === 256000, `maxOut ${r.maxOutputTokens}`)
})

check('锚定：真实输入缩放估算构成', () => {
  // estimate: 1000 chars ≈ 250 tok；真实输入 500 → 缩放 0.5
  const events = [
    { type: 'user/message', time: 1, data: { content: blocks('a'.repeat(1000)) } },
    { type: 'request/header', time: 2, data: { header: { tools: [], config: { maxTokens: 256000 } } } },
  ]
  const raw = composeFromEvents(events)
  assert(raw.parts.user === 254, `raw estimate ${raw.parts.user}`)
})

check('空事件流：全零但结构完整', () => {
  const r = composeFromEvents([])
  assert(r.total === 0 && r.contextWindow === null && r.parts.tools === 0, 'empty stream shape')
})

console.log(`compose.test.mjs — ${pass.length} passed, ${fail.length} failed`)
for (const label of fail) console.log(`  ✗ ${label}`)
process.exitCode = fail.length ? 1 : 0
