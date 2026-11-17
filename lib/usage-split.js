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
      // Two cases land here: a genuinely broken frame, and a false magic that
      // split a real frame in two. Skipping one candidate and retrying keeps
      // the rest of the log readable instead of truncating the whole file.
      if (next < 0) break
      pos = start + 4
      continue
    }
    if (next < 0) break
    pos = next
  }
  return text
}

const emptyUsage = () => ({ uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

/**
 * Pull the settled usage out of one model-settlement event.
 *
 * Two event types exist (`packages/core/session/src/types.ts`):
 * `assistant/message` carries an optional top-level `usage` plus the timed
 * `stream`; `assistant/attempt` carries **only** the stream — it is how a
 * failed, retried or cancelled call reaches settlement without a message.
 *
 * Numbers and time come from different places on purpose:
 * - the value prefers the top-level `usage` (it is the settled summary);
 * - the timestamp always prefers the usage chunk's own `time`, because the
 *   settlement event is written after the call finishes and can land on the
 *   other side of a peak/off-peak boundary. This holds even when the top-level
 *   usage exists — an earlier version returned `event.time` in that case and
 *   priced the boundary minute wrong.
 *
 * Across 5,456 real settlement events the stream held 0 or 1 usage chunk and
 * never more, so "the chunk" is unambiguous. If a host ever emits several, the
 * last one wins: they would be cumulative snapshots of one request, not
 * separate requests, and summing them would double count.
 * @param event - one `assistant/message` or `assistant/attempt` line.
 * @returns `{ usage, time }` or null when the event carries no usage at all.
 */
export function usageOfEvent(event) {
  const data = event?.data
  if (!data || typeof data !== 'object') return null
  const stream = Array.isArray(data.stream) ? data.stream : []
  let chunk = null
  for (const record of stream) {
    if (record?.chunk?.type === 'usage' && record.chunk.usage && typeof record.chunk.usage === 'object') {
      chunk = record
    }
  }
  const top = data.usage
  const usage = (top && typeof top === 'object') ? top : (chunk?.chunk?.usage ?? null)
  if (!usage) return null
  const time = Number.isFinite(chunk?.time) ? chunk.time : event.time
  return { usage, time }
}

/**
 * Walk decoded events and sum usage into peak / off-peak buckets.
 *
 * Events may come from the session log (parsed JSONL) or straight from
 * `sessionPersistence.open(id,'read')`, which returns them already parsed.
 * @param events - `assistant/message` / `assistant/attempt` records.
 * @returns `{ peak, off, requests }` or null when there is no usage.
 */
export function splitUsageEvents(events) {
  const peak = emptyUsage()
  const off = emptyUsage()
  let requests = 0
  // Logs are append-only; a resumed session can repeat an event after a crash.
  // Counting it is intentional: the provider billed the request, and `tokenUsage`
  // totals include it too.
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const picked = usageOfEvent(event)
    if (!picked) continue
    const { usage } = picked
    const bucket = isPeakTime(picked.time) ? peak : off
    // Negative or non-numeric values are corruption, not credit.
    const take = v => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : 0
    }
    // `reasoningTokens` is already inside `outputTokens`; adding it again would
    // double-count. Only the four billable buckets are summed.
    bucket.uncached += take(usage.inputTokens)
    bucket.cacheRead += take(usage.cacheReadTokens)
    bucket.cacheWrite += take(usage.cacheWriteTokens)
    bucket.output += take(usage.outputTokens)
    requests += 1
  }
  const total = peak.uncached + peak.cacheRead + peak.cacheWrite + peak.output
    + off.uncached + off.cacheRead + off.cacheWrite + off.output
  return total > 0 ? { peak, off, requests } : null
}

/**
 * Same as {@link splitUsageEvents}, for raw JSONL.
 * @param text - decompressed log lines.
 * @returns `{ peak, off, requests }` or null when the log has no usage.
 */
export function splitUsageText(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A half-written tail line is normal while a session is appending.
    }
  }
  return splitUsageEvents(events)
}
