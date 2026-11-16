/**
 * Peak / off-peak usage split, reconstructed from a session log.
 *
 * DSH's projections carry usage **totals** only: `tokenUsage.totals` has the
 * four buckets but no time axis, and `sessionStats` has durations but no
 * tokens. The billing window is a fixed rule (Beijing time, Mon–Fri
 * 09:00–12:00 and 14:00–18:00, holidays excluded), so the only missing piece is
 * *when* each request happened — and the session log has it: every
 * `assistant/message` event carries `time` and `data.usage`.
 *
 * The log is a sequence of concatenated zstd frames, one per append. A single
 * `zstdDecompressSync` on the whole file stops after the first frame, so this
 * walks the frame magic instead. Parsing a 20 MB session takes under a second;
 * results are cached by (mtime, size) by the caller.
 */

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * DeepSeek's peak windows in Beijing time: weekday mornings and afternoons.
 * Public holidays are not modelled — the host does not expose a calendar.
 * @param epochMs - event timestamp.
 * @returns true when the request bills at the peak rate.
 */
export function isPeakTime(epochMs) {
  if (!Number.isFinite(epochMs)) return false
  const shifted = new Date(epochMs + BEIJING_OFFSET_MS)
  const weekday = shifted.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  const hour = shifted.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

/** Decompress every concatenated zstd frame in a buffer. */
export function decompressFrames(buffer, zstd) {
  let text = ''
  let pos = 0
  while (pos < buffer.length) {
    const start = buffer.indexOf(MAGIC, pos)
    if (start < 0) break
    const next = buffer.indexOf(MAGIC, start + 4)
    const frame = buffer.subarray(start, next < 0 ? buffer.length : next)
    try {
      text += zstd(frame).toString('utf8')
    } catch {
      // A truncated tail (a session still being written) is normal: keep what
      // decoded and stop.
      break
    }
    if (next < 0) break
    pos = next
  }
  return text
}

const emptyUsage = () => ({ uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

/**
 * Walk a decoded log and sum usage into peak / off-peak buckets.
 * @param text - decompressed JSONL.
 * @returns `{ peak, off, requests }` or null when the log has no usage.
 */
export function splitUsageText(text) {
  const peak = emptyUsage()
  const off = emptyUsage()
  let requests = 0
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'assistant/message') continue
    const usage = event.data?.usage
    if (!usage || typeof usage !== 'object') continue
    const bucket = isPeakTime(event.time) ? peak : off
    bucket.uncached += Number(usage.inputTokens) || 0
    bucket.cacheRead += Number(usage.cacheReadTokens) || 0
    bucket.cacheWrite += Number(usage.cacheWriteTokens) || 0
    bucket.output += Number(usage.outputTokens) || 0
    requests += 1
  }
  const total = peak.uncached + peak.cacheRead + peak.cacheWrite + peak.output
    + off.uncached + off.cacheRead + off.cacheWrite + off.output
  return total > 0 ? { peak, off, requests } : null
}
