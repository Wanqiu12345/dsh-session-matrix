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
 * `zstdDecompressSync` on the whole file stops after the first frame, so the
 * frames have to be walked one by one. The walk follows the frame structure
 * (RFC 8878: descriptor, block headers, block bodies, checksum) rather than
 * searching for the magic bytes, because a compressed block can contain those
 * four bytes and searching would split a healthy frame in two.
 *
 * Only structurally complete frames are decompressed. A tail that is still
 * being appended is truncated mid-block; Node's zstd will happily return a
 * partial result for it, so completeness is decided here, not by the decoder.
 * Results are cached by (system revision | mtime, size) by the caller.
 */

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ZSTD_MAGIC = 0xfd2fb528 // little-endian 28 b5 2f fd
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
/**
 * Walk one Zstandard frame starting at `start`.
 *
 * Follows the frame layout from RFC 8878 §3.1 instead of trusting the magic
 * bytes: frame header descriptor → optional window descriptor → dictionary id →
 * frame content size → blocks → optional checksum. A block body may contain any
 * bytes, including the magic, so only the length fields can tell us where the
 * next frame begins.
 *
 * @param buffer - the whole log.
 * @param start - offset of the frame magic.
 * @returns `{ end }` when the frame is complete, `{ torn }` when it runs past the
 *   end of the buffer (a live append), `{ corrupt }` when the header or a block
 *   header is invalid.
 */
export function scanFrame(buffer, start) {
  let p = start
  if (buffer.length - p < 5) return { torn: true }
  p += 4 // magic, checked by the caller

  const descriptor = buffer[p]
  p += 1
  const fcsFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const unused = (descriptor & 0x10) !== 0
  const reserved = (descriptor & 0x08) !== 0
  const hasChecksum = (descriptor & 0x04) !== 0
  const dictFlag = descriptor & 0x03
  if (unused || reserved) return { corrupt: true }

  if (!singleSegment) {
    if (p >= buffer.length) return { torn: true }
    p += 1 // window descriptor
  }

  const dictBytes = dictFlag === 3 ? 4 : dictFlag
  if (p + dictBytes > buffer.length) return { torn: true }
  p += dictBytes

  const fcsBytes = fcsFlag === 0
    ? (singleSegment ? 1 : 0)
    : (fcsFlag === 1 ? 2 : (fcsFlag === 2 ? 4 : 8))
  if (p + fcsBytes > buffer.length) return { torn: true }
  let declaredSize = null
  if (fcsBytes === 1) declaredSize = buffer[p]
  else if (fcsBytes === 2) declaredSize = buffer.readUInt16LE(p) + 256
  else if (fcsBytes === 4) declaredSize = buffer.readUInt32LE(p)
  else if (fcsBytes === 8) declaredSize = Number(buffer.readBigUInt64LE(p))
  p += fcsBytes

  for (;;) {
    if (p + 3 > buffer.length) return { torn: true }
    const header = buffer[p] | (buffer[p + 1] << 8) | (buffer[p + 2] << 16)
    p += 3
    const last = (header & 1) === 1
    const type = (header >>> 1) & 3
    const size = header >>> 3
    if (type === 3) return { corrupt: true } // reserved block type
    // An RLE block stores a single byte no matter how large its output is.
    const bodyBytes = type === 1 ? 1 : size
    if (p + bodyBytes > buffer.length) return { torn: true }
    p += bodyBytes
    if (last) break
  }

  if (hasChecksum) {
    if (p + 4 > buffer.length) return { torn: true }
    p += 4
  }
  return { end: p, declaredSize }
}

/**
 * Decompress a concatenated zstd log, counting only complete frames.
 *
 * A frame that is structurally incomplete (the tail of a file being appended)
 * is never handed to the decoder: `zstdDecompressSync` returns partial output
 * for some truncated inputs instead of throwing, and that partial output would
 * silently corrupt the usage totals. A frame whose declared content size does
 * not match what came out is treated the same way.
 *
 * @param buffer - raw log bytes.
 * @param zstd - `zlib.zstdDecompressSync`.
 * @returns the concatenated JSONL text of every complete frame.
 */
export function decompressFrames(buffer, zstd) {
  let text = ''
  let pos = 0
  while (pos + 4 <= buffer.length) {
    if (buffer.readUInt32LE(pos) !== ZSTD_MAGIC) {
      // Not at a frame boundary: either the file is corrupt or the previous
      // frame ended early. Resynchronise on the next magic rather than giving
      // up on the rest of the log.
      const next = buffer.indexOf(MAGIC, pos + 1)
      if (next < 0) break
      pos = next
      continue
    }
    const frame = scanFrame(buffer, pos)
    // A frame is only trustworthy when it ends exactly where the log ends or
    // where the next frame's magic begins. A frame truncated in the middle of a
    // file still "parses": its block header overstates the body by the missing
    // bytes, and those bytes are supplied by the next frame, so the computed end
    // lands inside it. The boundary check is what catches that.
    const atBoundary = frame.end != null
      && (frame.end === buffer.length || buffer.readUInt32LE(frame.end) === ZSTD_MAGIC)
    if (!atBoundary) {
      // Neither a torn nor a corrupt frame is ever counted. Look for the next
      // frame instead of giving up on the file: each append writes its own
      // frame, so one damaged frame does not invalidate the ones after it.
      // A torn tail (a live append) simply has no next magic and ends the walk.
      const next = buffer.indexOf(MAGIC, pos + 4)
      if (next < 0) break
      pos = next
      continue
    }
    try {
      const out = zstd(buffer.subarray(pos, frame.end))
      // A declared content size that does not match the output means the frame
      // decoded to something other than what the writer intended; drop it.
      if (frame.declaredSize == null || out.length === frame.declaredSize) {
        text += out.toString('utf8')
      }
    } catch {
      // Corrupt payload: skip this frame, keep the ones already decoded.
    }
    pos = frame.end
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
