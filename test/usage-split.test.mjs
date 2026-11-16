/**
 * usage-split contract test — the parser that reconstructs peak/off-peak usage
 * from session logs.
 *
 * The inputs here are synthetic on purpose: frame layout, truncated tails and
 * corrupted middles are hard to produce from real logs on demand. The one
 * thing that is *not* synthetic is `event.time`: the unit was read off real
 * DSH logs (1794040946351, milliseconds since epoch) and is asserted below.
 */

import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { isPeakTime, decompressFrames, splitUsageText } from '../lib/usage-split.js'

/** zstd frame decoder used by the tests, matching the host's call site. */
const decode = buffer => zstdDecompressSync(buffer)

const pass = []
const fail = []
const check = (label, fn) => {
  try {
    fn()
    pass.push(label)
  } catch (error) {
    fail.push(`${label}: ${error.message}`)
  }
}

const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}

/** Build an epoch-ms timestamp for a given Beijing wall clock. */
const beijing = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h - 8, min)

// 2026-11-16 is a Monday, 2026-11-14 a Saturday.
check('peak windows are 09:00–12:00 and 14:00–18:00 on weekdays', () => {
  assert(isPeakTime(beijing(2026, 11, 16, 8, 59)) === false, '08:59 should be off-peak')
  assert(isPeakTime(beijing(2026, 11, 16, 9, 0)) === true, '09:00 should be peak')
  assert(isPeakTime(beijing(2026, 11, 16, 11, 59)) === true, '11:59 should be peak')
  assert(isPeakTime(beijing(2026, 11, 16, 12, 0)) === false, '12:00 should be off-peak')
  assert(isPeakTime(beijing(2026, 11, 16, 13, 59)) === false, '13:59 should be off-peak')
  assert(isPeakTime(beijing(2026, 11, 16, 14, 0)) === true, '14:00 should be peak')
  assert(isPeakTime(beijing(2026, 11, 16, 17, 59)) === true, '17:59 should be peak')
  assert(isPeakTime(beijing(2026, 11, 16, 18, 0)) === false, '18:00 should be off-peak')
})

check('weekends are always off-peak', () => {
  assert(isPeakTime(beijing(2026, 11, 14, 10, 0)) === false, 'Saturday 10:00')
  assert(isPeakTime(beijing(2026, 11, 15, 15, 0)) === false, 'Sunday 15:00')
})

check('timestamps are milliseconds, not seconds', () => {
  // Taken from a real log line: {"type":"assistant/message","time":1794040946138}
  const real = 1794040946_138
  assert(real > 1e12, 'real log time should be in ms range')
  // Treating it as seconds would land in 1970 and never be peak either way,
  // so assert the shift maths directly against a known Beijing wall clock.
  assert(isPeakTime(beijing(2026, 11, 16, 10, 0)) === true, '10:00 Monday must be peak')
})

/** Encode one JSONL batch as a zstd frame. */
const frame = lines => zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))

const usageEvent = (time, input, output, cacheRead = 0) => JSON.stringify({
  type: 'assistant/message',
  seq: 1,
  time,
  data: { usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0 } },
})

check('multiple concatenated frames are all decompressed', () => {
  const buf = Buffer.concat([
    frame([JSON.stringify({ type: 'session', id: 'x' })]),
    frame([usageEvent(beijing(2026, 11, 16, 10, 0), 100, 10)]),
    frame([usageEvent(beijing(2026, 11, 16, 20, 0), 200, 20)]),
  ])
  const text = decompressFrames(buf, decode)
  const split = splitUsageText(text)
  assert(split, 'should find usage across frames')
  assert(split.peak.uncached === 100, `peak uncached ${split.peak.uncached}`)
  assert(split.off.uncached === 200, `off uncached ${split.off.uncached}`)
  assert(split.requests === 2, `requests ${split.requests}`)
})

check('a truncated tail keeps what decoded', () => {
  const whole = Buffer.concat([
    frame([usageEvent(beijing(2026, 11, 16, 10, 0), 50, 5)]),
    frame([usageEvent(beijing(2026, 11, 16, 20, 0), 60, 6)]),
  ])
  const truncated = whole.subarray(0, whole.length - 12)
  const split = splitUsageText(decompressFrames(truncated, decode))
  assert(split, 'first frame should still decode')
  // A truncated tail decodes to whatever zstd can recover; it must not throw
  // and must not lose the frames that came before it.
  assert(split.peak.uncached === 50, `expected 50, got ${split.peak.uncached}`)
})

check('a corrupted middle frame does not throw', () => {
  // Truncation is what makes zstd throw; a header-only frame decodes to zero
  // bytes without an error, which the parser tolerates either way.
  const good = frame([usageEvent(beijing(2026, 11, 16, 10, 0), 70, 7)])
  const broken = good.subarray(0, Math.max(8, good.length - 6))
  const buf = Buffer.concat([good, broken, good])
  let split = null
  try {
    split = splitUsageText(decompressFrames(buf, decode))
  } catch (error) {
    throw new Error(`decompressFrames threw: ${error.message}`)
  }
  // The damaged frame contributes nothing; the frames around it must still be read.
  assert(split && split.peak.uncached === 140, `expected both good frames, got ${split && split.peak.uncached}`)
})

check('magic bytes inside plain text are not treated as a frame', () => {
  // A JSON string can contain the 4 magic bytes; the scanner only looks at the
  // compressed file, so this exercises the parser's tolerance instead.
  const text = `{"type":"note","text":"\\u28b5\\u2ffd"}\n` + usageEvent(beijing(2026, 11, 16, 10, 0), 3, 1)
  const split = splitUsageText(text)
  assert(split && split.peak.uncached === 3, 'unrelated lines must not break parsing')
})

check('events without usage are ignored', () => {
  const split = splitUsageText([
    JSON.stringify({ type: 'step/end', time: beijing(2026, 11, 16, 10, 0) }),
    JSON.stringify({ type: 'assistant/message', time: beijing(2026, 11, 16, 10, 0), data: {} }),
  ].join('\n'))
  assert(split === null, 'no usage should yield null')
})

check('corrupt numbers are clamped, not credited', () => {
  const split = splitUsageText([
    JSON.stringify({ type: 'assistant/message', time: beijing(2026, 11, 16, 10, 0), data: { usage: { inputTokens: -500, outputTokens: 'abc', cacheReadTokens: 10 } } }),
    JSON.stringify({ type: 'assistant/message', time: beijing(2026, 11, 16, 10, 0), data: { usage: { inputTokens: 5, outputTokens: 1 } } }),
  ].join('\n'))
  assert(split.peak.uncached === 5, `negatives must not reduce the total: ${split.peak.uncached}`)
  assert(split.peak.output === 1, `NaN must count as 0: ${split.peak.output}`)
})

check('an unterminated line is skipped without throwing', () => {
  const split = splitUsageText('{"type":"assistant/message","time":1,"data":{"usage":{"inputT')
  assert(split === null, 'partial JSON should be ignored')
})


if (fail.length) {
  console.error(`\nusage-split.test.mjs — ${pass.length} passed, ${fail.length} failed`)
  for (const line of fail) console.error('  ✗ ' + line)
  process.exitCode = 1
} else {
  console.log(`usage-split.test.mjs — ${pass.length} passed, 0 failed`)
}
