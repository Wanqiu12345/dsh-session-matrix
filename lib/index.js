/**
 * DSH Session Matrix — host half.
 *
 * Responsibility: read Session/Context facts through public DSH services and
 * serve them as one normalized JSON contract. The browser half never touches
 * DSH internals; it only consumes this contract.
 *
 * Boundaries (deliberate):
 *   - ContextAdapter  : `sessionProjections.snapshot()` — never re-parses jsonl
 *   - SessionAdapter  : `sessionQuery.listSessions()` — never owns sessions
 *   - WorkspaceAdapter: `workspaceRegistry` — never duplicates project data
 *   - RiskEngine      : pure function over the normalized DTO
 *   - Store           : view preferences only, never conversation content
 *
 * Degradation: when a projection is absent (e.g. dsh-context not installed),
 * the affected fields are reported as unavailable instead of being invented.
 *
 * @module dsh-session-matrix
 */

/** Stable Cordis plugin name. */
export const name = 'dsh-session-matrix'

import { decompressFrames, splitUsageEvents, splitUsageText } from './usage-split.js'

/**
 * Services required to answer anything at all. Optional capabilities
 * (`sessionProjections`, `workspaceRegistry`) are probed with `ctx.get()`
 * so the plugin still loads when they are missing.
 */
export const inject = ['webServer', 'sessionQuery', 'sessions', 'connection']

/** Always-registered projections: the panel has nothing without these. */
const BASE_KEYS = ['contextTimeline', 'contextActivity', 'title', 'sessionListMetadata', 'modelSelection']

/**
 * session id → `{ mtime, size, peak, off }`, rebuilt from the session logs.
 * Filled by `collect()` (budgeted) and read by `toDto()`, so a host without
 * time-bucketed projections can still price peak hours instead of guessing.
 */
const LOG_SPLITS = new Map()

/**
 * Projections that a trimmed Host profile may not register. They are requested
 * in the same snapshot for speed, and dropped on retry so one missing key does
 * not cost the panel every number it has.
 */
const OPTIONAL_KEYS = ['contextPressure', 'contextBreakdown', 'tokenUsage', 'sessionStats']

/** Category breakdown read from `contextTimeline.current`. */
const PART_KEYS = ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool']

/** Every part except the fixed system prompt and tool definitions. */
const MESSAGE_KEYS = ['user', 'inject', 'skill', 'assistant', 'tool']

/** Number guard: anything that is not a finite number is "unknown". */
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/** Number guard for samples that must be present to mean anything (0 = absent). */
const positive = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)

/**
 * Bundled handoff prompts: one markdown file per protocol version.
 *
 * Kept out of the browser half on purpose. Changing the wording of a handoff
 * protocol is a content edit, not a code change, and the panel must never ship
 * a stale copy because the browser bundle was cached.
 */
const HANDOFF_VERSIONS = { v1: './handoff/v1.md' }
const HANDOFF_DEFAULT = 'v1'
/** Tokens the panel fills in before the text reaches the clipboard. */
const HANDOFF_PLACEHOLDERS = ['SESSION_TITLE', 'HANDOFF_ID', 'DATE']

/**
 * Billing constants, chosen to match dsh-context exactly so the two panels never
 * disagree about the same session:
 *   - models.dev lists DeepSeek's **off-peak** price; peak windows cost twice.
 *   - CNY is derived at `1 CNY = 0.15 USD`.
 */
const PEAK_FACTOR = 2
const CNY_PER_USD = 1 / 0.15

/**
 * DeepSeek's official price list, CNY per 1M tokens, **off-peak**.
 *
 * Source: platform.deepseek.com pricing page, checked 2026-11-17. Peak hours
 * (Beijing time, Mon–Fri 09:00–12:00 and 14:00–18:00, holidays excluded) bill at
 * exactly twice these numbers, which `PEAK_FACTOR` applies per bucket.
 *
 * `deepseek-flash` is the current id and serves V4.1-Flash; `deepseek-v4-flash`
 * is the **old name of the same model** (still accepted, routed to V4.1), so it
 * shares the price. `deepseek-v4-pro` bills separately and is not routed.
 */
const DEEPSEEK_CNY = {
  'deepseek-flash': { hit: 0.02, miss: 1, out: 4 },
  'deepseek-v4-flash': { hit: 0.02, miss: 1, out: 4 },
  'deepseek-v4.1-flash': { hit: 0.02, miss: 1, out: 4 },
  'deepseek-v4-pro': { hit: 0.15, miss: 4.5, out: 13.5 },
  'deepseek-chat': { hit: 0.02, miss: 1, out: 4 },
  'deepseek-reasoner': { hit: 0.02, miss: 1, out: 4 },
}

/**
 * Official CNY price for a DeepSeek model, or null for third-party routes.
 * @param provider - routing id from the timeline.
 * @param model - model id.
 * @returns `{ hit, miss, out }` or null.
 */
function deepseekCny(provider, model) {
  if (!String(provider ?? '').includes('deepseek')) return null
  return DEEPSEEK_CNY[String(model ?? '')] ?? null
}

/** `tokenUsage` is read in the same snapshot when the Host registers it. */
const USAGE_KEY = 'tokenUsage'

/**
 * Auto-compaction boundaries, taken from `dsh-compaction-basic` itself:
 *
 *   messageBudget = contextWindow − reservedCompletionTokens
 *   pressureBudget = messageBudget − policy.headroomTokens
 *
 * `headroomTokens` defaults to 4096 in the shipped policy, and
 * `reservedCompletionTokens` is the output reserved by one routed request —
 * the model's max output. An earlier version of this file used a 64K headroom
 * plus a 0.8× ceiling, which warned earlier than DSH actually compacts; that
 * was a guess, not a mirror.
 */
const COMPACT_HEADROOM = 4_096
/** Share of (window − output) kept verbatim after compaction (retainRatio). */
const COMPACT_RETAIN = 0.16

/** Defaults; the row config may override them later. */
const DEFAULTS = {
  cacheTtlMs: 45_000,
  coldConcurrency: 4,
  coldBudgetMs: 20_000,
  /**
   * Warning thresholds as a fraction of the **real** compaction point, not of
   * the window. A flat 70% would only warn after a 1M-window session with a
   * 393k output reservation had already compacted at 56%.
   */
  warnFactor: 0.8,
  criticalFactor: 0.92,
  /** Fetch models.dev list prices for the cost estimate. */
  prices: true,
  /**
   * Multiplier applied when usage has no peak/off-peak split (a host without
   * dsh-context). 1 = price everything at the off-peak rate, 1.5 = assume half
   * the usage happened in peak hours, 2 = all peak. Only affects the estimate.
   */
  peakFactor: 1,
  /**
   * Rebuild the peak/off split from session logs when the host exposes no
   * time-bucketed usage. Off = price everything at the off-peak rate.
   */
  peakFromLogs: true,
  /** Log files parsed per collect, smallest first. */
  logBudget: 6,
  /** Bytes of log parsed per collect; keeps one poll from stalling on a big file. */
  logBudgetBytes: 8 * 1024 * 1024,
  /**
   * Hard per-file ceiling. The soft budget above is a target, not a promise: a
   * single file larger than it used to be read whole. Anything past this limit
   * is skipped and reported as incomplete instead of blowing up one poll.
   */
  logMaxFileBytes: 32 * 1024 * 1024,
  priceTtlMs: 24 * 60 * 60 * 1000,
}

/**
 * Where this session's history would actually be compressed.
 *
 * `dsh-compaction-basic` triggers at `floor(min(window × 0.8,
 * window − output − headroom))`; for a 1M window with a 393k output
 * reservation that is 56%, not 80%. Thresholds derived from the window alone
 * would therefore arrive after the fact.
 * @param window - context window in tokens.
 * @param output - max output reservation in tokens.
 * @returns `{ tokens, ratio, retain }` or null when the window is unknown.
 */
function compactPointOf(window, output) {
  if (!(window > 0)) return null
  const byBudget = window - (output ?? 0) - COMPACT_HEADROOM
  // A window smaller than the output reservation would yield a negative point;
  // treat it as "unknown" rather than reporting a nonsense percentage.
  if (!(byBudget > 0)) return null
  const tokens = Math.floor(byBudget)
  if (!(tokens > 0)) return null
  return {
    tokens,
    ratio: tokens / window,
    // How much history survives verbatim after a compaction run. The client
    // renders this number, so it is computed here rather than duplicated there.
    retain: Math.round(Math.max(0, window - (output ?? 0)) * COMPACT_RETAIN),
  }
}

/**
 * Classify one ratio into the three capacity levels.
 * @param ratio - used / capacity, or null when capacity is unknown.
 * @param point - this session's compaction point (or null).
 * @param cfg - thresholds as fractions of `point`.
 * @returns risk level.
 */
/**
 * Count compaction checkpoints in one session's event stream.
 *
 * Every compaction run persists a `user/message` whose source carries
 * `{ kind: 'compact-checkpoint', compactionId }` — manual /compact included
 * (its source also has `sourceCommandId`). Counting them is the only way to
 * know how many times a session's history has been rebuilt: the host exposes
 * no compaction projection, and `contextTimeline.requests` is a two-slot ring
 * buffer that only ever shows the most recent one.
 * @param events - persisted session events (or parsed log lines).
 * @returns `{ compactions, lastCompactionAt }` — zero when the stream has none.
 */
/** A summary younger than this is considered fresh; freshness demotes one level. */
const COMPACTION_FRESH_MS = 10 * 60_000

export function countCheckpoints(events) {
  let fullCompactions = 0
  let pruneCompactions = 0
  let lastCompactionAt = null
  for (const event of events) {
    let kind = null
    let time = Number(event?.time)
    if (event?.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint') {
      kind = 'full' // full compaction: history rebuilt into a summary
    } else if (event?.type === 'compaction/prune') {
      kind = 'prune' // tool-result pruning: outputs dropped, no checkpoint
    } else {
      continue
    }
    if (kind === 'full') fullCompactions += 1
    else pruneCompactions += 1
    if (Number.isFinite(time)) lastCompactionAt = Math.max(lastCompactionAt ?? time, time)
  }
  return {
    compactions: fullCompactions + pruneCompactions,
    fullCompactions,
    pruneCompactions,
    lastCompactionAt,
  }
}

/**
 * Occupancy decides WHEN compaction looms; the compaction count decides
 * WHETHER the session is worth handing off. Community consensus (Claude Code
 * ecosystem) is that two compactions in one session already mean the task was
 * scoped wrong, and every further pass stacks information loss on top.
 *
 * Matrix (docs/32 §3):
 *   0 compactions  — a fresh session first crossing the critical line is still
 *     fully usable: the history has never been rebuilt, so the alarm is
 *     demoted to warn and flagged as firstApproach instead of pushing a
 *     handoff the user does not need yet.
 *   1–2 compactions — critical occupancy escalates to a handoff suggestion.
 *   ≥3 compactions  — warn occupancy is already a handoff suggestion: history
 *     has been rebuilt repeatedly and detail loss is stacked.
 * A compaction in the last ten minutes leaves the freshest possible summary,
 * so the level is demoted one step regardless of the matrix.
 *
 * @param stats - `{ compactions, lastCompactionAt }` from the log pipeline;
 *   `compactions === null` means "not parsed yet" and keeps the old
 *   occupancy-only verdict rather than guessing.
 */
export function riskLevel(ratio, point, cfg, stats) {
  if (ratio == null) return 'unknown'
  let level
  if (!point) {
    level = ratio >= 0.85 ? 'crit' : ratio >= 0.7 ? 'warn' : 'ok'
  } else if (ratio >= point.ratio * cfg.criticalFactor) {
    level = 'crit'
  } else if (ratio >= point.ratio * cfg.warnFactor) {
    level = 'warn'
  } else {
    return 'ok'
  }

  const count = stats?.compactions
  const firstApproach = count === 0 && level === 'crit'
  if (firstApproach) level = 'warn'
  else if (typeof count === 'number' && count >= 3 && level === 'warn') level = 'crit'

  // A timestamp in the future (clock skew between machines) must not keep the
  // freshness exemption alive until the clock catches up.
  const sinceLast = stats?.lastCompactionAt != null ? Date.now() - stats.lastCompactionAt : null
  const fresh = sinceLast != null && sinceLast >= 0 && sinceLast < COMPACTION_FRESH_MS
  if (fresh) level = level === 'crit' ? 'warn' : level === 'warn' ? 'ok' : level
  return level
}

/**
 * Optimal-string-alignment distance, enough for "is this folder name a typo of
 * that workspace name" (a transposition counts as one edit).
 * @param a - lowercase token.
 * @param b - lowercase token.
 * @returns edit distance.
 */
function editDistance(a, b) {
  const m = a.length
  const n = b.length
  const d = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0)
    row[0] = i
    return row
  })
  for (let j = 0; j <= n; j += 1) d[0][j] = j
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
      }
    }
  }
  return d[m][n]
}

/** Normalize a filesystem path for comparison: forward slashes, no trailing
 *  separator, lowercase (Windows workspaces are case-insensitive). */
const normPath = value => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * Token accounting for one session, from the provider's own counters.
 *
 * Preferred source is the core `tokenUsage` projection; when a Host does not
 * register it, the same four buckets are recoverable from
 * `contextActivity.days[*].cost`, which dsh-context fills from the same usage
 * events. Nothing is inferred from message counts.
 * @param values - projection values for one session.
 * @returns `{uncached, cacheRead, cacheWrite, output}` or null.
 */
function usageOf(values) {
  // The projection value arrives wrapped as `{ ver, seq, val }`; older hosts
  // hand over the bare object. Unwrap once, then read `totals`.
  const raw = values?.[USAGE_KEY]
  const unwrapped = raw && typeof raw === 'object' && 'val' in raw ? raw.val : raw
  const flat = unwrapped?.totals ?? unwrapped
  const num = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  if (flat && (typeof flat.cacheReadTokens === 'number' || typeof flat.uncachedInputTokens === 'number')) {
    const usage = {
      uncached: num(flat.uncachedInputTokens),
      cacheRead: num(flat.cacheReadTokens),
      cacheWrite: num(flat.cacheWriteTokens),
      output: num(flat.outputTokens),
    }
    return usage.uncached + usage.cacheRead + usage.cacheWrite + usage.output > 0 ? usage : null
  }

  const usage = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  for (const day of Object.values(values?.contextActivity?.days ?? {})) {
    for (const provider of Object.values(day?.cost ?? {})) {
      for (const model of Object.values(provider ?? {})) {
        for (const bucket of Object.values(model ?? {})) {
          usage.uncached += num(bucket?.uncached)
          usage.cacheRead += num(bucket?.cacheRead)
          usage.cacheWrite += num(bucket?.cacheWrite)
          usage.output += num(bucket?.output)
        }
      }
    }
  }
  return usage.uncached + usage.cacheRead + usage.cacheWrite + usage.output > 0 ? usage : null
}

/** Provider ids the DSH model catalogue uses, mapped onto models.dev ids. */
const PROVIDER_ALIAS = {
  'deepseek-official': 'deepseek',
  'deepseek-api': 'deepseek',
  'deepseek-platform': 'deepseek',
  'deepseek-account': 'deepseek',
}

/**
 * Normalize a provider id for price lookup.
 * @param provider - provider id from the session timeline.
 * @returns lowercase catalogue key.
 */
function normalizeProvider(provider) {
  const value = String(provider ?? '').toLowerCase()
  return PROVIDER_ALIAS[value] ?? value.replace(/-(official|api|platform|account|cloud)$/, '')
}

/**
 * Price book over models.dev's public catalogue.
 *
 * models.dev is the same source dsh-context prices against, and it is the only
 * public machine-readable list of per-model token prices. The request is
 * optional (config `prices: false` disables it), made at most once a day, and
 * cached under `storages/agent-workspace/` when the Host exposes a home path.
 * The directory keeps its pre-rename name on purpose: renaming it would orphan
 * the price table every existing install already has on disk.
 * @param ctx - Cordis context (for `dshHomePath`).
 * @param cfg - plugin config.
 * @param logger - host logger.
 * @returns `{ ready, ensure, lookup, info }`.
 */
function createPriceBook(ctx, cfg, logger) {
  const state = { book: null, at: 0, failed: false, inflight: null, source: 'models.dev' }

  /** @returns directory of the plugin's own storage, or null. */
  function storageDir() {
    try {
      const home = ctx.get?.('dshHomePath') ?? ctx.dshHomePath
      if (typeof home !== 'function') return null
      return home('storages', 'agent-workspace')
    } catch {
      return null
    }
  }

  /**
   * @param raw - parsed models.dev payload.
   * @returns lookup tables.
   */
  function index(raw) {
    const byProvider = new Map()
    const byModel = new Map()
    for (const [pid, prov] of Object.entries(raw ?? {})) {
      const models = prov?.models
      if (!models || typeof models !== 'object') continue
      const table = new Map()
      for (const [mid, model] of Object.entries(models)) {
        const cost = model?.cost
        if (!cost || typeof cost.input !== 'number') continue
        const price = {
          input: cost.input,
          output: typeof cost.output === 'number' ? cost.output : cost.input,
          cacheRead: typeof cost.cache_read === 'number' ? cost.cache_read : cost.input,
          cacheWrite: typeof cost.cache_write === 'number' ? cost.cache_write : cost.input,
        }
        table.set(mid, price)
        const seen = byModel.get(mid) ?? []
        seen.push({ provider: pid, price })
        byModel.set(mid, seen)
      }
      if (table.size) byProvider.set(pid, table)
    }
    return { byProvider, byModel }
  }

  async function load() {
    const dir = storageDir()
    let raw = null
    if (dir) {
      try {
        const fs = await import('node:fs/promises')
        const path = `${dir}/prices.json`
        const stat = await fs.stat(path)
        if (Date.now() - stat.mtimeMs < cfg.priceTtlMs) {
          raw = JSON.parse(await fs.readFile(path, 'utf8'))
        }
      } catch { /* no cache yet */ }
    }
    if (!raw) {
      const res = await fetch('https://models.dev/api.json', {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`models.dev ${res.status}`)
      raw = await res.json()
      if (dir) {
        try {
          const fs = await import('node:fs/promises')
          await fs.mkdir(dir, { recursive: true })
          await fs.writeFile(`${dir}/prices.json`, JSON.stringify(raw))
        } catch { /* cache is a bonus, not a requirement */ }
      }
    }
    state.book = index(raw)
    state.at = Date.now()
    state.failed = false
  }

  /** Kick off a load if the book is stale. Never throws, never blocks. */
  function ensure() {
    if (!cfg.prices || state.inflight) return
    if (state.book && Date.now() - state.at < cfg.priceTtlMs) return
    if (!state.book && state.failed && Date.now() - state.at < 60_000) return
    state.inflight = load()
      .catch(error => {
        state.failed = true
        state.at = Date.now()
        logger.debug?.(`dsh-session-matrix: price book unavailable: ${error?.message ?? error}`)
      })
      .finally(() => { state.inflight = null })
  }

  /**
   * @param provider - session provider id.
   * @param model - session model id.
   * @returns `{input, output, cacheRead, cacheWrite}` per 1M tokens, or null.
   */
  function lookup(provider, model) {
    const book = state.book
    if (!book || !model) return null
    const prov = normalizeProvider(provider)
    const direct = book.byProvider.get(prov)?.get(model)
    if (direct) return direct
    for (const [pid, table] of book.byProvider) {
      if (!(pid.includes(prov) || prov.includes(pid))) continue
      const hit = table.get(model)
      if (hit) return hit
    }
    const list = book.byModel.get(model)
    return list && list.length === 1 ? list[0].price : null
  }

  function info() {
    return {
      ready: Boolean(state.book),
      enabled: Boolean(cfg.prices),
      failed: state.failed,
      source: state.source,
      providers: state.book?.byProvider.size ?? 0,
      fetchedAt: state.at || null,
    }
  }

  return { ensure, lookup, info }
}

/**
 * Estimate what the usage would cost at list price.
 * @param usage - `{uncached, cacheRead, cacheWrite, output}`.
 * @param price - per-million-token prices.
 * @returns USD amount, or null.
 */
function costOf(usage, price) {
  if (!usage || !price) return null
  return (usage.uncached * price.input
    + usage.cacheRead * price.cacheRead
    + usage.cacheWrite * price.cacheWrite
    + usage.output * price.output) / 1_000_000
}

/**
 * Cost from the timeline's peak / off-peak buckets.
 *
 * `contextTimeline.cost` keeps usage split by provider, model and billing
 * window. DeepSeek bills its peak windows (Beijing time, Mon–Fri 09:00–12:00
 * and 14:00–18:00) at twice the listed rate — models.dev publishes the off-peak
 * rate — so the two buckets cannot be priced identically.
 *
 * The result is also converted to CNY with the same `1 CNY = 0.15 USD` the
 * dsh-context plugin uses, so both panels show the same number for the same
 * session instead of disagreeing by a rounding convention.
 * @param timeline - `contextTimeline` wire value.
 * @param lookup - `(provider, model) => price | null`.
 * @returns `{ usd, cny, buckets, peakBuckets }` or null when nothing is priced.
 */
export function costOfBuckets(timeline, lookup, cnyLookup = () => null) {
  const cost = timeline?.cost
  if (!cost || typeof cost !== 'object') return null
  let cny = 0
  let buckets = 0
  let peakBuckets = 0
  let official = 0
  for (const [provider, models] of Object.entries(cost)) {
    for (const [model, byKind] of Object.entries(models ?? {})) {
      // DeepSeek's own price list is quoted in CNY and is authoritative for its
      // models; models.dev only covers third-party routes, and converting it at
      // a fixed rate is off by ~2% on v4-pro. Prefer the official table.
      const local = cnyLookup(provider, model)
      const remote = local ? null : lookup(provider, model)
      if (!local && !remote) continue
      if (local) official += 1
      for (const [kind, used] of Object.entries(byKind ?? {})) {
        if (!used) continue
        buckets += 1
        if (kind === 'peak') peakBuckets += 1
        const factor = kind === 'peak' ? PEAK_FACTOR : 1
        if (local) {
          cny += factor * (used.uncached * local.miss
            + used.cacheRead * local.hit
            + used.cacheWrite * local.hit
            + used.output * local.out) / 1_000_000
        } else {
          cny += factor * costOf(used, remote) * CNY_PER_USD
        }
      }
    }
  }
  if (!buckets) return null
  return { cny, usd: cny / CNY_PER_USD, buckets, peakBuckets, officialModels: official }
}

/**
 * Build the plugin.
 * @param ctx - Cordis context.
 * @param config - row config (all fields optional).
 */
export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const logger = ctx.logger ?? console
  /** List prices for the cost estimate; optional and never blocking. */
  const priceBook = createPriceBook(ctx, cfg, logger)

  /** id → { at, dto } */
  const cache = new Map()

  // sessionPersistence is optional: get() throws for a service that is not in
  // the inject list, and an older host may not mount it at all. Reads prefer it
  // and fall back to the file scanner.
  let persistence = null
  try {
    persistence = ctx.get?.('sessionPersistence') ?? ctx.sessionPersistence ?? null
  } catch {
    persistence = null
  }

  /** `${id}|${revision}` → in-flight read, so two collects never open two handles. */
  const inflightSplits = new Map()

  /** Sessions skipped because their log exceeds `logMaxFileBytes`. */
  const oversize = new Set()
  const maxFileBytes = Math.max(1, cfg.logMaxFileBytes ?? 32 * 1024 * 1024)

  /** Session-log index and its timestamp; see indexSessionLogs(). */
  let logIndex = null
  let logIndexAt = 0

  let inflight = null
  let lastCollectedAt = 0
  let dirty = true

  const projections = () => ctx.get?.('sessionProjections') ?? ctx.sessionProjections
  const registry = () => ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry
  const titles = () => ctx.get?.('sessionTitle') ?? ctx.sessionTitle

  /**
   * Read the authoritative title for a session that is currently live.
   *
   * The `title` projection value is a **plain string** (`string | null`), not
   * an object — reading `.title` off it silently yields `undefined` and used to
   * turn every row into the "Untitled session" fallback. The `sessionTitle`
   * service is the same fold, exposed without the projection envelope, so it is
   * preferred for live sessions and costs one in-memory lookup.
   * @param rec - session record.
   * @returns title text, or undefined when the session is cold / untitled.
   */
  function liveTitle(rec) {
    if (rec.live !== true) return undefined
    const id = rec.header?.id
    const sessions = ctx.get?.('sessions') ?? ctx.sessions
    if (!id || typeof sessions?.get !== 'function') return undefined
    try {
      const session = sessions.get(id)
      if (!session) return undefined
      const text = titles()?.get?.(session)?.title
      return typeof text === 'string' && text.trim() ? text.trim() : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Read projections for one session. Uses the public `inspectSession` read
   * face so cold (not-yet-live) sessions work too.
   * @param id - session id.
   * @returns projection snapshot values, or null.
   */
  async function readProjections(id) {
    const sp = projections()
    if (!sp || typeof sp.snapshot !== 'function') return null
    const read = keys => ctx.sessionQuery.inspectSession(id, session => sp.snapshot(session, keys))
    try {
      const snap = await read([...BASE_KEYS, ...OPTIONAL_KEYS])
      return snap?.values ?? null
    } catch {
      // One unregistered key makes the whole snapshot throw. Retry with the
      // optional ones dropped rather than losing every context number.
      for (const keys of [[...BASE_KEYS, 'tokenUsage'], BASE_KEYS]) {
        try {
          const snap = await read(keys)
          return snap?.values ?? null
        } catch { /* try the next, narrower key set */ }
      }
      logger.debug?.(`dsh-session-matrix: projection read failed for ${id}`)
      return null
    }
  }

  /**
   * The prompt size the panel speaks in.
   *
   * `contextTimeline` counts tokens by estimating every event, and that estimate
   * runs ~1.4× low on Chinese-heavy logs. The provider reports the real prompt
   * on every request, and `contextPressure` keeps it, so the same precedence
   * dsh-context uses applies here:
   *
   *   1. `projectedTokens` — what the *next* request would cost
   *   2. `pressureTokens`  — what the last request actually cost
   *   3. last request `prompt` + the heuristic delta since that sample
   *   4. the heuristic total (no provider sample yet)
   * @param timeline - `contextTimeline` wire value.
   * @param pressure - `contextPressure` wire value.
   * @returns `{ tokens, source }`; tokens is null when nothing is known.
   */
  function pressureOf(timeline, pressure) {
    const projected = positive(pressure?.projectedTokens)
    if (projected != null) return { tokens: projected, source: 'projected' }
    const sampled = positive(pressure?.pressureTokens)
    if (sampled != null) return { tokens: sampled, source: 'pressure' }
    const last = timeline?.last
    const total = num(timeline?.current?.total)
    if (last && num(last.prompt) != null && num(last.total) != null && total != null) {
      return { tokens: last.prompt + (total - last.total), source: 'prompt+delta' }
    }
    if (total != null) return { tokens: total, source: 'estimate' }
    return { tokens: null, source: null }
  }

  /**
   * Category breakdown, calibrated to the measured prompt size.
   *
   * The split between categories can only come from the event estimates, but the
   * *sum* must match the number shown everywhere else — otherwise the panel says
   * "4.8M used" while its own parts add up to 3.2M. So: build the estimate (using
   * `contextBreakdown` for the system / tools / message totals, which are more
   * accurate than the per-event sums), then scale the whole set onto `total`.
   * @param current - `contextTimeline.current`.
   * @param breakdown - `contextBreakdown` wire value.
   * @param total - measured prompt size.
   * @returns part → tokens, or null.
   */
  function partsOf(current, breakdown, total) {
    if (!current) return null
    const messageSum = MESSAGE_KEYS.reduce((n, k) => n + (num(current[k]) ?? 0), 0)
    const messages = num(breakdown?.messageTokens) ?? messageSum
    const parts = {
      system: num(breakdown?.systemTokens) ?? (num(current.system) ?? 0),
      tools: num(breakdown?.toolsTokens) ?? (num(current.tools) ?? 0),
    }
    let assigned = 0
    for (const k of MESSAGE_KEYS) {
      const value = messageSum > 0 ? Math.round(messages * ((num(current[k]) ?? 0) / messageSum)) : 0
      parts[k] = value
      assigned += value
    }
    if (messageSum > 0 && assigned !== messages) {
      const biggest = MESSAGE_KEYS.reduce((a, b) => (parts[b] > parts[a] ? b : a), MESSAGE_KEYS[0])
      parts[biggest] = Math.max(0, parts[biggest] + (messages - assigned))
    }
    const sum = PART_KEYS.reduce((n, k) => n + (parts[k] ?? 0), 0)
    const measured = positive(total)
    if (measured != null && sum > 0 && measured !== sum) {
      const scale = measured / sum
      for (const k of PART_KEYS) parts[k] = Math.round((parts[k] ?? 0) * scale)
    }
    return parts
  }

  /**
   * Normalize one session record into the wire DTO.
   * @param rec - `SessionRecord` from `sessionQuery.listSessions()`.
   * @param values - projection values (may be null).
   * @param projectOf - resolver mapping a session id to its project title.
   * @returns normalized row.
   */
  function toDto(rec, values, projectOf, liveTitleText) {
    const header = rec.header ?? {}
    const id = header.id
    const timeline = values?.contextTimeline ?? null
    const current = timeline?.current ?? null
    const pressure = values?.contextPressure ?? null
    const breakdown = values?.contextBreakdown ?? null

    // Capacity comes from the newest recorded route; the pressure projection is
    // fresher than the timeline's copy when a model switch happened.
    const capacity = positive(pressure?.contextWindow) ?? positive(timeline?.contextWindow) ?? null
    const pressureTokens = pressureOf(timeline, pressure)
    // `total` is the number the panel, the threshold and the tooltip all speak
    // in: the provider-reported prompt size (or the documented fallback chain).
    const total = pressureTokens.tokens ?? current?.total ?? null
    const estimatedTotal = current?.total ?? null
    const ratio = capacity && total != null ? total / capacity : null
    const point = compactPointOf(capacity, timeline?.maxOutputTokens ?? null)

    const parts = partsOf(current, breakdown, total)

    // The model picker is a core projection; `contextTimeline` is not (it comes
    // from dsh-context). Resolve once and use it for both the label and pricing,
    // so a host without that plugin still prices what it can.
    const modelName = timeline?.model ?? values?.modelSelection?.lastUsed?.model ?? null
    const providerName = timeline?.provider ?? values?.modelSelection?.lastUsed?.provider ?? null

    const usage = usageOf(values)
    // Prefer the projection's own peak/off buckets. When the host has none (no
    // dsh-context), use the split reconstructed from the session log; the
    // lifetime totals times `peakFactor` is the last resort.
    const projectionBuckets = costOfBuckets(timeline, priceBook.lookup, deepseekCny)
    // Compaction counts come from the log pipeline regardless of where the
    // usage buckets came from — a projection-priced session still has a log.
    const logStats = LOG_SPLITS.get(id)
    const split = projectionBuckets ? null : logStats
    const logBuckets = !projectionBuckets && split && (split.peak || split.off)
      ? costOfBuckets(
        { cost: { [providerName ?? 'deepseek']: { [modelName ?? 'unknown']: { peak: split.peak, off: split.off } } } },
        priceBook.lookup,
        deepseekCny,
      )
      : null
    const buckets = projectionBuckets ?? logBuckets
    const fallbackUsd = costOf(usage, priceBook.lookup(providerName, modelName))
    // No time buckets in core projections: the caller decides how much of the
    // usage to treat as peak rather than guessing here.
    const peakFactor = Number.isFinite(cfg.peakFactor) ? Math.min(2, Math.max(1, cfg.peakFactor)) : 1
    const costCny = buckets ? buckets.cny : (fallbackUsd == null ? null : fallbackUsd * CNY_PER_USD * peakFactor)
    // Which path priced this session: the projection's own buckets, the split
    // rebuilt from the log, or lifetime totals × peakFactor.
    const costSource = projectionBuckets ? 'projection' : logBuckets ? 'log' : (fallbackUsd == null ? null : 'totals')
    const costUsd = costCny == null ? null : costCny / CNY_PER_USD

    // Turns and steps are NOT on the timeline's wire view: `sessionStats` is
    // where the Host keeps them (it is the same fold the conversation footer
    // renders "55 轮 406 步" from). Reading `timeline.turns` produced a wall of
    // "— / —" for every session.
    const stats = values?.sessionStats ?? null
    const turns = num(stats?.turns) ?? num(timeline?.last?.turn) ?? null
    const steps = num(stats?.steps) ?? null

    const activity = values?.contextActivity?.days ?? null
    const activityDays = {}
    if (activity) {
      for (const [day, v] of Object.entries(activity)) {
        activityDays[day] = { tokens: v?.tokens ?? 0, requests: v?.requests ?? 0 }
      }
    }

    // The `title` projection folds to `string | null`; older snapshots and
    // `sessionListMetadata` may still carry an object, so accept both shapes.
    const projected = values?.title
    const fromProjection = typeof projected === 'string'
      ? projected
      : (projected?.title ?? values?.sessionListMetadata?.title ?? null)
    const fromPrompt = values?.sessionListMetadata?.lastPrompt
      ? String(values.sessionListMetadata.lastPrompt).slice(0, 64)
      : null
    const blank = values?.sessionListMetadata?.blank === true
    const created = header.createdAt ? new Date(header.createdAt) : null
    const stamp = created && !Number.isNaN(created.getTime())
      ? `${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`
      : null
    const title =
      (typeof liveTitleText === 'string' && liveTitleText.trim()) ? liveTitleText.trim()
        : (typeof fromProjection === 'string' && fromProjection.trim()) ? fromProjection.trim()
          : (fromPrompt && fromPrompt.trim()) ? fromPrompt.trim()
            : blank ? '新会话'
              : header.origin === 'subagent'
                ? `子代理${stamp ? ' · ' + stamp : ''}`
                : `未命名会话${stamp ? ' · ' + stamp : ''}`

    const rowRisk = riskLevel(ratio, point, cfg, logStats)
    return {
      id,
      title,
      project: projectOf(id, header),
      origin: header.origin === 'subagent' ? 'subagent' : 'user',
      parentId: header.parentSession ?? null,
      cwd: header.cwd ?? null,
      createdAt: header.createdAt ?? null,
      live: rec.live === true,
      persisted: rec.persisted === true,
      blank: values?.sessionListMetadata?.blank === true,
      model: modelName,
      provider: providerName,
      contextWindow: capacity,
      maxOutputTokens: timeline?.maxOutputTokens ?? null,
      total,
      ratio,
      /** Where `total` came from: projected | pressure | prompt+delta | estimate. */
      contextSource: pressureTokens.source,
      /** The event-estimate total, kept only to explain the gap in a tooltip. */
      estimatedTotal,
      /** Where this session compacts; the panel colours against this, not 100%. */
      compactRatio: point?.ratio ?? null,
      compactTokens: point?.tokens ?? null,
      compactRetain: point?.retain ?? null,
      parts,
      turns,
      steps,
      usage,
      costUsd,
      costCny,
      costSource,
      costBuckets: buckets ? buckets.buckets : 0,
      costPeakBuckets: buckets ? buckets.peakBuckets : 0,
      updatedAt: values?.sessionListMetadata?.lastPromptAt ?? header.createdAt ?? null,
      activityDays,
      compactions: logStats?.compactions ?? null,
      lastCompactionAt: logStats?.lastCompactionAt ?? null,
      firstApproach: rowRisk === 'warn' && logStats?.compactions === 0 && ratio >= (point?.ratio ?? Infinity) * cfg.criticalFactor,
      risk: rowRisk,
      contextAvailable: total != null,
    }
  }

  /**
   * Resolve project membership for every session: direct workspace membership
   * first, then the parent chain, then a cwd tail, then "Ungrouped".
   * @param records - session records.
   * @returns resolver + project rows.
   */
  function buildProjects(records) {
    const reg = registry()
    const workspaces = typeof reg?.list === 'function' ? (reg.list() ?? []) : []

    const direct = new Map()
    const projects = []
    for (const w of workspaces) {
      const title = w.title ?? w.path ?? w.id
      projects.push({ id: w.id, title, path: w.path ?? null, count: w.sessionIds?.length ?? 0 })
      for (const sid of w.sessionIds ?? []) direct.set(sid, title)
    }

    const headerById = new Map()
    for (const rec of records) {
      const h = rec.header ?? {}
      if (h.id) headerById.set(h.id, h)
    }

    /**
     * @param id - session id.
     * @param header - its header.
     * @returns project title.
     */
    /** Workspaces with a usable path, for cwd-based attribution. */
    const byPath = projects
      .map(w => ({ title: w.title, path: normPath(w.path) }))
      .filter(w => w.path)

    /**
     * Attribute a cwd to a workspace: contained path first, then a near-name
     * match (a typo'd folder such as `D:////AIVdeio` next to `D:////AIVideo`).
     * Without this, every stray directory invented its own "project" and the
     * chip row no longer matched the workspaces the user actually has.
     * @param cwd - the session's working directory.
     * @returns workspace title, or '' when it belongs to no workspace.
     */
    function projectFromCwd(cwd) {
      const value = normPath(cwd)
      if (!value) return ''
      for (const w of byPath) {
        if (value === w.path || value.startsWith(`${w.path}/`)) return w.title
      }
      const base = value.split('/').pop() ?? ''
      let best = null
      for (const w of byPath) {
        const other = w.path.split('/').pop() ?? ''
        if (!other || Math.abs(other.length - base.length) > 2) continue
        const distance = editDistance(base, other)
        if (distance <= 2 && (best === null || distance < best.distance)) {
          best = { distance, title: w.title }
        }
      }
      return best ? best.title : ''
    }

    function projectOf(id, header) {
      let cursor = id
      for (let depth = 0; depth < 12 && cursor; depth += 1) {
        if (direct.has(cursor)) return direct.get(cursor)
        const h = headerById.get(cursor)
        cursor = h?.parentSession ?? (cursor === id ? header?.parentSession : undefined)
      }
      return projectFromCwd(header?.cwd)
    }

    return { projectOf, projects }
  }

  /**
   * Run `worker` over `items` with a concurrency cap and a wall-clock budget.
   * Items not reached within the budget keep their previous cache entry.
   * @param items - work items.
   * @param worker - async perform.
   * @param limit - max in flight.
   * @param budgetMs - soft deadline.
   */
  async function mapLimited(items, worker, limit, budgetMs) {
    const started = Date.now()
    let index = 0
    const runners = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
      while (index < items.length) {
        if (Date.now() - started > budgetMs) return
        const current = index
        index += 1
        try {
          await worker(items[current], current)
        } catch (error) {
          // One malformed session must not cost every other session its row:
          // collect() would otherwise serve the last good payload forever.
          logger.debug?.(`dsh-session-matrix: session collect failed: ${error?.message ?? error}`)
        }
      }
    })
    await Promise.all(runners)
  }

/**
 * Archived sessions, as the native sidebar sees them.
 *
 * DSH keeps this out of the session records: it lives in the workspace storage
 * table (`storages/workspace.json`) as `archivedSessionIds`. The native list
 * hides those sessions, so this panel must hide them too — otherwise the two
 * lists disagree about what exists.
 *
 * Read defensively: an older or newer host may move the table, so the walk looks
 * for the key at any depth, and a missing file simply means "nothing archived".
 * @returns set of archived session ids.
 */
  async function archivedSessionIds() {
    const home = ctx.get?.('dshHomePath') ?? ctx.dshHomePath
    if (typeof home !== 'function') return new Set()
    try {
      const fs = await import('node:fs/promises')
      const file = home('storages', 'workspace.json')
      const raw = JSON.parse(await fs.readFile(file, 'utf8'))
      const ids = new Set()
      const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 6) return
        for (const [key, value] of Object.entries(node)) {
          if (key === 'archivedSessionIds' && Array.isArray(value)) {
            for (const id of value) if (typeof id === 'string') ids.add(id)
            continue
          }
          walk(value, depth + 1)
        }
      }
      walk(raw, 0)
      return ids
    } catch {
      return new Set()
    }
  }

  /**
   * Map every session id to its log file. Rebuilt at most once a minute: the
   * directory layout is `sessions/<workspace>/<sessionId>/session.v4.jsonl.zstd`.
   * @returns Map id → absolute path.
   */
  async function indexSessionLogs() {
    if (logIndex && Date.now() - logIndexAt < 60_000) return logIndex
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const map = new Map()
    const home = ctx.get?.('dshHomePath') ?? ctx.dshHomePath
    if (typeof home !== 'function') return map
    try {
      const root = home('sessions')
      for (const ws of await fs.readdir(root, { withFileTypes: true })) {
        if (!ws.isDirectory()) continue
        const wsPath = path.join(root, ws.name)
        for (const entry of await fs.readdir(wsPath, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          // The directory is the bare uuid; session ids carry a `session-` prefix.
          const file = path.join(wsPath, entry.name, 'session.v4.jsonl.zstd')
          map.set(entry.name, file)
          map.set(entry.name.startsWith('session-') ? entry.name : `session-${entry.name}`, file)
        }
      }
    } catch {
      // No sessions directory (fresh install) is not an error.
    }
    logIndex = map
    logIndexAt = Date.now()
    return map
  }

  /**
   * Rebuild the peak/off split for sessions whose log changed.
   *
   * Budgeted on purpose: each file costs a few dozen milliseconds, and a cold
   * start must not block the first paint for seconds. Smallest files go first
   * so the common case warms up within one or two polls.
   * @param records - session records about to be collected.
   */
  /**
   * Read one session's split through the official persistence service.
   *
   * `open(id,'read')` returns events that are already parsed, so this path skips
   * zstd entirely, and `stat().revision` is the change token DSH documents for
   * caching (equal revisions may be treated as unchanged). Returns null when the
   * service is absent, the session is not materialized, or the read fails — the
   * caller then falls back to the file scanner.
   * @param id - session id.
   * @returns cached or freshly computed entry, or null.
   */
  /**
   * Read one session's split through the official persistence service.
   *
   * `open(id,'read')` returns events that are already parsed, so this path needs
   * neither zstd nor the log-file index. `stat().revision` is the documented
   * change token: an equal revision is a cache hit, a different revision is a
   * real change and must be re-read — the 256 KB / 60 s throttle that used to
   * sit here belonged to the file path and contradicted the token's meaning.
   * Cost control lives in the caller (per-collect budget) and in `inflight`,
   * which collapses concurrent reads of the same revision into one handle.
   * @param id - session id.
   * @returns `{ entry, read }`, or null when persistence cannot answer.
   */
  async function splitFromPersistence(id) {
    if (!persistence?.stat || !persistence?.open) return null
    let snapshot
    try {
      snapshot = await persistence.stat(id)
    } catch {
      return null
    }
    if (!snapshot) return null
    const revision = String(snapshot.revision ?? '')
    const size = Number(snapshot.sizeBytes) || 0
    if (size > maxFileBytes) {
      // Over the ceiling: leave the previous split in place and record that this
      // session is not covered, rather than reading it whole.
      oversize.add(id)
      return { skipped: true, size }
    }
    oversize.delete(id)
    const hit = LOG_SPLITS.get(id)
    if (revision && hit?.revision === revision) return { entry: hit, read: false, size }

    const key = `${id}|${revision}`
    const running = inflightSplits.get(key)
    if (running) {
      const entry = await running
      return entry ? { entry, read: false, size } : null
    }

    const job = (async () => {
      const handle = await persistence.open(id, 'read')
      try {
        const result = await handle.read()
        const events = result?.events ?? []
        const split = splitUsageEvents(events)
        const entry = {
          revision,
          size,
          at: Date.now(),
          peak: split?.peak ?? null,
          off: split?.off ?? null,
          ...countCheckpoints(events),
        }
        LOG_SPLITS.set(id, entry)
        cache.delete(id)
        return entry
      } finally {
        try { await handle.close?.() } catch { /* already closed */ }
      }
    })()

    inflightSplits.set(key, job)
    try {
      const entry = await job
      return { entry, read: true, size }
    } catch {
      return null
    } finally {
      inflightSplits.delete(key)
    }
  }

  async function refreshLogSplits(records) {
    if (!cfg.peakFromLogs) return
    const maxFiles = Math.max(1, cfg.logBudget)
    const maxBytes = Math.max(1, cfg.logBudgetBytes)
    let parsed = 0
    let bytes = 0

    // Phase 1 — official persistence. This must not require zstd, and it must
    // not require the log-file index: an installed host can answer entirely
    // from parsed events. Only a changed revision costs a read.
    const remaining = []
    for (const rec of records) {
      const id = rec.header?.id
      if (!id) continue
      if (parsed >= maxFiles) { remaining.push(rec); continue }
      // The soft budget is checked before the read, not after: adding a file and
      // then discovering it blew the budget is how one 50 MB log used to stall a
      // whole poll.
      if (bytes > 0 && bytes >= maxBytes) { remaining.push(rec); continue }
      const official = await splitFromPersistence(id)
      if (!official) { remaining.push(rec); continue }
      if (official.skipped) { parsed += 0; continue }
      if (official.read) {
        parsed += 1
        bytes += official.size ?? 0
      }
    }
    if (!remaining.length) return

    // Phase 2 — file fallback. Only now do zstd and the directory index matter.
    const zlib = await import('node:zlib')
    const zstd = zlib.zstdDecompressSync
    if (typeof zstd !== 'function') return
    const fs = await import('node:fs/promises')
    const index = await indexSessionLogs()
    const todo = []
    for (const rec of remaining) {
      const id = rec.header?.id
      const file = id ? index.get(id) : null
      if (!file) continue
      try {
        const stat = await fs.stat(file)
        if (stat.size > maxFileBytes) {
          oversize.add(id)
          continue
        }
        const hit = LOG_SPLITS.get(id)
        if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) continue
        // The fallback has no revision token, so it keeps the growth throttle:
        // an active session appends constantly and a 20 MB decompress per poll
        // would cost a second. The persistence path above does not need this.
        if (hit && stat.size - hit.size < 256 * 1024 && Date.now() - (hit.at ?? 0) < 60_000) continue
        todo.push({ id, file, stat })
      } catch {
        // A session without a log file simply has no usage to split.
      }
    }
    todo.sort((a, b) => a.stat.size - b.stat.size)
    for (const item of todo) {
      if (parsed >= maxFiles) break
      // Do not start a file that cannot fit in what is left of the budget; a
      // smaller one later in the queue can still be read this round.
      if (bytes > 0 && bytes + item.stat.size > maxBytes) continue
      parsed += 1
      bytes += item.stat.size
      const stamp = { mtime: item.stat.mtimeMs, size: item.stat.size }
      try {
        const buf = await fs.readFile(item.file)
        const text = decompressFrames(buf, zstd)
        const split = splitUsageText(text)
        LOG_SPLITS.set(item.id, {
          ...stamp,
          at: Date.now(),
          peak: split?.peak ?? null,
          off: split?.off ?? null,
          ...countCheckpoints(text.split('\n').map((line) => {
            try { return JSON.parse(line) } catch { return null }
          })),
        })
        // The DTO cache may hold a totals-priced copy: drop it so the next
        // collect re-prices with the buckets we just found.
        cache.delete(item.id)
      } catch {
        LOG_SPLITS.set(item.id, { ...stamp, at: Date.now(), peak: null, off: null })
        cache.delete(item.id)
      }
    }
  }

  /**
   * Collect the full overview. Live sessions read first; cold sessions fill in
   * under the concurrency/budget caps and reuse the projection cache.
   * @returns overview payload.
   */
  async function collect() {
    // Fire-and-forget: the price book may need the network, and an overview
    // must never wait on it. First call reports `costUsd: null`, the next one
    // (15s later, from the panel's own poll) has the numbers.
    priceBook.ensure()
    let records = (await ctx.sessionQuery.listSessions()) ?? []
    const { projectOf, projects } = buildProjects(records)
    // Hide what the native sidebar hides. The set is re-read every collect, so
    // un-archiving a session brings it back within one refresh.
    const archived = await archivedSessionIds()
    const archivedCount = records.filter(rec => archived.has(rec.header?.id)).length
    if (archivedCount) records = records.filter(rec => !archived.has(rec.header?.id))

    // Price peak hours from the logs when the host has no buckets for them.
    // Budgeted, so this costs a few dozen ms per collect, not seconds.
    await refreshLogSplits(records)

    // Live first: their projection cells are already warm, reads are cheap.
    const ordered = [...records].sort((a, b) => Number(b.live === true) - Number(a.live === true))

    await mapLimited(ordered, async rec => {
      const id = rec.header?.id
      if (!id) return
      const cached = cache.get(id)
      if (cached && Date.now() - cached.at < cfg.cacheTtlMs) {
        return
      }
      const values = await readProjections(id)
      const dto = toDto(rec, values, projectOf, liveTitle(rec))
      cache.set(id, { at: Date.now(), values, dto })
    }, cfg.coldConcurrency, cfg.coldBudgetMs)

    // Drop cache entries for sessions that no longer exist: this module lives
    // as long as the window, and deleted sessions would otherwise pin their
    // DTOs for the whole day.
    const alive = new Set(records.map(rec => rec.header?.id).filter(Boolean))
    for (const key of [...cache.keys()]) if (!alive.has(key)) cache.delete(key)

    const sessions = []
    let pending = 0
    for (const rec of records) {
      const id = rec.header?.id
      if (!id) continue
      const hit = cache.get(id)
      if (hit?.dto) sessions.push({ ...hit.dto, project: projectOf(id, rec.header) })
      else {
        pending += 1
        sessions.push({ ...toDto(rec, null, projectOf, liveTitle(rec)), pending: true })
      }
    }

    // A session created but never used is a stub, not a conversation: the
    // native sidebar does not list it either. `blank` comes from the host's own
    // list metadata, so this matches what the shell counts as a real session.
    const stubs = sessions.filter(x => x.blank === true && (x.turns ?? 0) === 0)
    const stubIds = new Set(stubs.map(x => x.id))
    const listed = stubs.length ? sessions.filter(x => !stubIds.has(x.id)) : sessions

    listed.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1))

    // Project rows must cover every project a session actually resolved to —
    // including ones derived from cwd or the parent chain rather than the
    // Workspace registry — otherwise the filter bar silently loses entries.
    const byTitle = new Map()
    for (const p of projects) {
      byTitle.set(p.title, { ...p, count: 0, derived: false })
    }
    for (const s of listed) {
      let row = byTitle.get(s.project)
      if (!row) {
        row = { id: null, title: s.project, path: null, count: 0, derived: true }
        byTitle.set(s.project, row)
      }
      row.count += 1
    }
    const mergedProjects = [...byTitle.values()]
      .sort((a, b) => b.count - a.count || String(a.title).localeCompare(String(b.title)))

    const sp = projections()
    const cap = {
      contextProjections: Boolean(sp),
      projectionKeys: typeof sp?.summaryKeys === 'function' ? [...sp.summaryKeys()] : [],
      workspaceRegistry: typeof registry()?.list === 'function',
      coldPending: pending,
      emptyStubs: stubs.length,
    }

    lastCollectedAt = Date.now()
    dirty = false

    return {
      version: 1,
      generatedAt: lastCollectedAt,
      thresholds: { warnFactor: cfg.warnFactor, criticalFactor: cfg.criticalFactor },
      pricing: priceBook.info(),
      capabilities: cap,
      projects: mergedProjects,
      sessions: listed,
      totals: {
        all: listed.length,
        user: listed.filter(s => s.origin === 'user').length,
        subagent: listed.filter(s => s.origin === 'subagent').length,
        unknownContext: listed.filter(s => !s.contextAvailable).length,
        archived: archivedCount,
      },
    }
  }

  /**
   * Serve one overview request, coalescing concurrent callers onto one collect.
   * @param force - bypass the TTL.
   * @returns overview payload.
   */
  /** Last good payload, served when a collect throws. */
  let lastOverview = null

  function overview(force = false) {
    if (!force && !dirty && lastCollectedAt > 0 && Date.now() - lastCollectedAt < cfg.cacheTtlMs) {
      return Promise.resolve(lastOverview)
    }
    if (inflight) return inflight
    inflight = collect()
      .then(payload => {
        lastOverview = payload
        return payload
      })
      .catch(error => {
        logger.warn?.(`dsh-session-matrix: collect failed: ${error?.stack ?? error}`)
        return lastOverview ?? {
          version: 1,
          generatedAt: Date.now(),
          error: String(error?.message ?? error),
          thresholds: { warnFactor: cfg.warnFactor, criticalFactor: cfg.criticalFactor },
          pricing: priceBook.info(),
          capabilities: { contextProjections: false, projectionKeys: [], workspaceRegistry: false },
          projects: [],
          sessions: [],
          totals: { all: 0, user: 0, subagent: 0, unknownContext: 0 },
        }
      })
      .finally(() => { inflight = null })
    return inflight
  }

  /**
   * Answer one JSON resource read.
   * @param body - JSON-serializable payload.
   * @param status - HTTP status.
   * @returns Fetch response.
   */
  function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  }

  /** Bundled prompts, read once per process. */
  const handoffCache = new Map()

  /**
   * Read one bundled handoff prompt and describe it for the panel.
   * @param version - key of `HANDOFF_VERSIONS`.
   * @returns `{ version, text, bytes, hash, placeholders, versions }`.
   */
  async function handoffPrompt(version) {
    const cached = handoffCache.get(version)
    if (cached) return cached
    const fs = await import('node:fs/promises')
    const { createHash } = await import('node:crypto')
    const text = await fs.readFile(new URL(HANDOFF_VERSIONS[version], import.meta.url), 'utf8')
    const entry = {
      version,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      // Short digest so a bug report can name the exact prompt it ran.
      hash: createHash('sha256').update(text).digest('hex').slice(0, 12),
      placeholders: HANDOFF_PLACEHOLDERS,
      versions: Object.keys(HANDOFF_VERSIONS),
    }
    handoffCache.set(version, entry)
    return entry
  }

  // ── Routes ────────────────────────────────────────────────────────────────
  ctx.effect(() => {
    const disposers = []

    // Exact routes must ride the shared /api channel: Connection runs
    // admit(request) before dispatching to them (401 without a token, 403 for a
    // non-owner principal). Registering straight on the web server skips that
    // step entirely, which is how an unauthenticated GET used to return 200.
    // Cordis throws on get() for a service that is not in the inject list, so the
    // probe has to tolerate that rather than assume the service exists.
    let connection = null
    try {
      connection = ctx.get?.('connection') ?? ctx.connection ?? null
    } catch {
      connection = null
    }
    /**
     * Mount one authenticated GET route.
     *
     * There is deliberately no unauthenticated fallback: a webServer exact route
     * matches before the /api prefix and therefore skips Connection admission,
     * which would expose session titles, projects and usage to anything that can
     * reach the port. If Connection is missing the panel loses its API, and that
     * is the correct failure mode.
     */
    const mountGet = (path, handler) => {
      if (typeof connection?.fetch?.register !== 'function') {
        logger.error?.('dsh-session-matrix: connection.fetch unavailable; routes not registered')
        return () => {}
      }
      // The path carries the /api prefix: assertFetchRoute() validates it via
      // endpointFromPath('/api', path), so a bare /session-matrix/... is rejected.
      return connection.fetch.register({
        path,
        methods: ['GET', 'HEAD'],
        requestBody: 'buffered',
        fetch: async request => handler(request),
      })
    }


    // Overview: the whole workbench contract in one read.
    disposers.push(mountGet('/api/session-matrix/overview', async request => {
        const url = new URL(request.url, 'http://localhost')
        const force = url.searchParams.get('refresh') === '1'
        return json(await overview(force))
    }))

    // Reported in capabilities so a bug report can name the exact build, and
    // so an install can be verified from the outside without opening the UI.
    let cachedVersion = null
    const packageVersion = async () => {
      if (cachedVersion) return cachedVersion
      try {
        const fs = await import('node:fs/promises')
        const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
        cachedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown'
      } catch {
        cachedVersion = 'unknown'
      }
      return cachedVersion
    }
    // Capability probe: lets the panel decide what to hide before the first
    // heavy collect finishes.
    disposers.push(mountGet('/api/session-matrix/capabilities', async () => {
        const sp = projections()
        return json({
          version: 1,
          contextProjections: Boolean(sp),
          projectionKeys: typeof sp?.summaryKeys === 'function' ? [...sp.summaryKeys()] : [],
          workspaceRegistry: typeof registry()?.list === 'function',
          dshVersion: ctx.get?.('appBoot')?.version ?? null,
          pluginVersion: await packageVersion(),
          persistenceReads: (() => { try { return Boolean(ctx.get?.('sessionPersistence')?.stat) } catch { return false } })(),
          logSplits: LOG_SPLITS.size,
          logSplitsWithUsage: [...LOG_SPLITS.values()].filter(v => v.peak || v.off).length,
          // A session over the per-file ceiling is never parsed, so the aggregate
          // is incomplete while this is non-zero. Saying so beats a silent cap.
          oversizeSessions: oversize.size,
          logBudget: { maxFiles: cfg.logBudget, maxBytes: cfg.logBudgetBytes, maxFileBytes },
        })
    }))

    // Handoff prompt: one bundled markdown file per protocol version. The panel
    // fetches it at click time, so editing the prompt never requires touching
    // the browser half — and `hash` lets a bug report name the exact text.
    disposers.push(mountGet('/api/session-matrix/handoff', async request => {
        const url = new URL(request.url, 'http://localhost')
        const version = url.searchParams.get('v') || HANDOFF_DEFAULT
        if (!Object.hasOwn(HANDOFF_VERSIONS, version)) {
          return json({ error: 'unknown version', versions: Object.keys(HANDOFF_VERSIONS) }, 404)
        }
        try {
          return json(await handoffPrompt(version))
        } catch (error) {
          logger.warn?.(`dsh-session-matrix: handoff prompt unreadable: ${error?.message ?? error}`)
          return json({ error: 'prompt unavailable' }, 500)
        }
    }))

    return () => { for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } } }
  }, 'dsh-session-matrix: routes')

  // ── Change signal ────────────────────────────────────────────────────────
  // Any committed session event invalidates the snapshot; the next request
  // re-collects. No timer, no polling from this side.
  ctx.on('session/event', () => { dirty = true })
  ctx.on('session/created', () => { dirty = true })
  ctx.on('session/disposed', () => { dirty = true })

  logger.info?.('dsh-session-matrix: host ready (/api/session-matrix/*)')
}
