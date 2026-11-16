/**
 * Host-half contract test. Runs the plugin against a fake Cordis context whose
 * session records are derived from the real `workspace.json` + dsh-context
 * cache shapes, so the aggregation logic is exercised on realistic topology
 * without touching the running DSH.
 *
 * Run: node test/host.test.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply, costOfBuckets } from '../lib/index.js'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

/**
 * Load real session ids and workspace membership; fall back to a synthetic
 * fixture when the user's data is unavailable (e.g. CI).
 * @returns {{records: object[], workspaces: object[], projections: Map<string, object>}}
 */
function loadFixture() {
  try {
    const ws = JSON.parse(readFileSync(join(DSH_HOME, 'storages', 'workspace.json'), 'utf8'))
    const ctxCache = JSON.parse(
      readFileSync(join(DSH_HOME, 'storages', 'dsh-context', 'overview-cache.v1.json'), 'utf8'))

    const workspaces = Object.entries(ws.tables.workspaces).map(([id, w]) => ({
      id, title: w.title, path: w.path, sessionIds: w.sessionIds,
    }))

    const projections = new Map()
    const records = []
    for (const row of ctxCache.sessions) {
      const s = row.session
      records.push({
        header: {
          id: s.id,
          createdAt: s.updatedAt,
          cwd: s.cwd,
          parentSession: s.parentSession,
          isSeeded: false,
          ...(s.origin === 'subagent' ? { origin: 'subagent' } : {}),
        },
        live: records.length % 3 === 0,
        persisted: true,
      })
      projections.set(s.id, {
        contextTimeline: s.timeline
          ? {
            model: s.timeline.model,
            contextWindow: s.timeline.contextWindow,
            maxOutputTokens: s.timeline.maxOutputTokens,
            turns: s.timeline.turns,
            steps: s.timeline.steps,
            current: s.timeline.current,
          }
          : null,
        contextActivity: s.activity ?? null,
        title: s.title,
        sessionListMetadata: { blank: s.blank, lastPromptAt: s.updatedAt },
      })
    }

    // One synthetic cold session with no projection, to exercise degradation.
    const ghostId = 'session-00000000-0000-4000-8000-000000000000'
    records.push({
      header: { id: ghostId, createdAt: Date.now(), cwd: '/tmp/ghost', isSeeded: false },
      live: false,
      persisted: true,
    })

    return { records, workspaces, projections }
  } catch {
    // Self-contained fixture: CI has no DSH home to read, so this path has to
    // cover every shape the assertions rely on — a stub, a parent, a subagent,
    // and a session with provider-reported usage.
    const records = [
      { header: { id: 'session-a', createdAt: 1, cwd: '/work/Alpha', isSeeded: false }, live: true, persisted: true },
      { header: { id: 'session-b', createdAt: 2, cwd: '/work/Alpha', parentSession: 'session-a', isSeeded: false, origin: 'subagent' }, live: false, persisted: true },
      { header: { id: 'session-stub', createdAt: 4, cwd: '/work/Alpha', isSeeded: false }, live: false, persisted: true },
      { header: { id: 'session-wrapped', createdAt: 5, cwd: '/work/Alpha', isSeeded: false }, live: false, persisted: true },
    ]
    const projections = new Map([
      ['session-a', {
        contextTimeline: { model: 'deepseek-flash', contextWindow: 1_000_000, current: { system: 100, tools: 200, user: 50, inject: 0, skill: 0, assistant: 300, tool: 400, total: 1050 } },
        contextActivity: {
          days: {
            '2026-11-15': {
              tokens: 900,
              requests: 3,
              // Provider-reported buckets; usageOf() reads this shape when the
              // host does not register the tokenUsage projection.
              cost: { deepseek: { 'deepseek-flash': { offPeak: { uncached: 400, cacheRead: 1600, cacheWrite: 0, output: 250 } } } },
            },
          },
        },
        title: 'Alpha task',
        sessionListMetadata: { blank: false, lastPromptAt: 3 },
      }],
      ['session-wrapped', {
        contextTimeline: null,
        // Real hosts wrap the projection value as { ver, seq, val }.
        tokenUsage: { ver: 2, seq: 9, val: { totals: { uncachedInputTokens: 1200, outputTokens: 800, cacheReadTokens: 300, cacheWriteTokens: 0 } } },
        contextActivity: null,
        title: 'Wrapped usage',
        sessionListMetadata: { blank: false, lastPromptAt: 5 },
      }],
      ['session-stub', {
        contextTimeline: null,
        contextActivity: null,
        title: 'New session',
        sessionListMetadata: { blank: true, lastPromptAt: 4 },
      }],
    ])
    return {
      records,
      workspaces: [{ id: 'w1', title: 'Alpha', path: '/work/Alpha', sessionIds: ['session-a', 'session-b', 'session-stub', 'session-wrapped'] }],
      projections,
    }
  }
}

/**
 * Build a fake Cordis context exposing only what the plugin injects.
 * @param fixture - fixture data.
 * @param opts - capability toggles.
 * @returns {{ctx: object, routes: Map<string, object>, state: object}}
 */
function makeCtx(fixture, opts = {}) {
  const routes = new Map()
  const state = { events: [], warnings: [], infos: [] }

  const sessionProjections = opts.withProjections === false ? undefined : {
    snapshot: (session, keys) => {
      const values = fixture.projections.get(session.id) ?? {}
      const picked = {}
      for (const k of keys) if (k in values) picked[k] = values[k]
      return { asOfSeq: 0, values: picked }
    },
    summaryKeys: () => new Set(['contextTimeline', 'contextActivity', 'title', 'sessionListMetadata']),
  }

  const workspaceRegistry = opts.withWorkspaces === false ? undefined : {
    list: () => fixture.workspaces,
  }

  const services = {
    sessionProjections,
    workspaceRegistry,
    appBoot: { version: '0.2.2-rc.3' },
  }

  const ctx = {
    logger: {
      info: m => state.infos.push(String(m)),
      warn: m => state.warnings.push(String(m)),
      debug: () => {},
    },
    get: key => services[key],
    webServer: {
      register: route => {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    sessionQuery: {
      listSessions: async () => fixture.records,
      inspectSession: async (id, read) => {
        const rec = fixture.records.find(r => r.header.id === id)
        if (!rec) throw new Error(`unknown session ${id}`)
        return read({ id, header: rec.header })
      },
      // Records carry no payload — this is the shape that made every pane say
      // "还没有消息" when the route read from here instead of `readSession`.
      listEvents: async id => {
        if (id === 'unknown') throw new Error('not found')
        return [{ seq: 0, type: 'user/message', time: 1 }, { seq: 1, type: 'assistant/message', time: 2 }]
      },
      readSession: async id => {
        if (id === 'unknown') throw new Error('not found')
        return {
          session: { id, createdAt: 1, origin: 'user' },
          inheritedEventCount: 0,
          events: [
            { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
            { seq: 1, type: 'user/message', time: 2, data: { content: '检查这个模块' , source: 'user' } },
            { seq: 2, type: 'tool/call', time: 3, data: { name: 'read' } },
            { seq: 3, type: 'assistant/message', time: 4, data: { content: [{ type: 'text', text: '主要增长在工具返回。' }] } },
          ],
        }
      },
    },
    sessions: { list: () => [] },
    effect: fn => { const d = fn(); return d },
    on: (name, handler) => { state.events.push(name); return () => {} },
  }
  return { ctx, routes, state }
}

/**
 * Invoke one registered resource route.
 * @param routes - route map.
 * @param path - pathname.
 * @param query - query string.
 * @returns parsed JSON body.
 */
async function hit(routes, path, query = '') {
  const route = routes.get(path)
  assert.ok(route, `route ${path} not registered`)
  assert.equal(typeof route.resource, 'function', `${path} must answer as a resource`)
  const res = await route.resource(new Request(`http://localhost${path}${query ? `?${query}` : ''}`))
  return { status: res.status, body: await res.json() }
}

async function main() {
  const fixture = loadFixture()
  const pass = []
  const fail = []

  const check = (label, fn) => {
    try { fn(); pass.push(label) } catch (error) { fail.push(`${label}: ${error.message}`) }
  }

  // ── 1. Normal path ───────────────────────────────────────────────────────
  const { ctx, routes, state } = makeCtx(fixture)
  // `prices: false` keeps the contract test offline: the cost estimate needs
  // models.dev, and a unit test must not depend on the network.
  apply(ctx, { cacheTtlMs: 1000, coldBudgetMs: 5000, prices: false })

  check('registers the three read routes', () => {
    // The session-detail route was removed with the in-cell preview: panes host
    // the real conversation now, so the host no longer needs to ship text.
    assert.equal(routes.size, 3)
    assert.ok(routes.has('/api/session-matrix/overview'))
    assert.ok(routes.has('/api/session-matrix/capabilities'))
    assert.ok(routes.has('/api/session-matrix/handoff'))
  })

  check('subscribes to session lifecycle events', () => {
    assert.ok(state.events.includes('session/event'))
    assert.ok(state.events.includes('session/created'))
    assert.ok(state.events.includes('session/disposed'))
  })

  const handoff = await hit(routes, '/api/session-matrix/handoff')
  check('handoff route serves the bundled prompt', () => {
    assert.equal(handoff.status, 200)
    assert.equal(handoff.body.version, 'v1')
    assert.ok(handoff.body.bytes > 1000, 'prompt looks truncated')
    assert.match(handoff.body.hash, /^[0-9a-f]{12}$/)
    assert.ok(handoff.body.text.includes('{{SESSION_TITLE}}'), 'title placeholder missing')
    assert.ok(handoff.body.text.includes('{{HANDOFF_ID}}'), 'file-name placeholder missing')
    // The markers are what v2 will scrape; losing them silently breaks the plan.
    assert.ok(handoff.body.text.includes('<<<HANDOFF-MSG'))
    assert.ok(handoff.body.text.includes('HANDOFF-MSG>>>'))
    assert.ok(handoff.body.text.includes('已否决'), 'rejected-approaches section missing')
    assert.deepEqual(handoff.body.placeholders, ['SESSION_TITLE', 'HANDOFF_ID', 'DATE'])
  })

  const unknownVersion = await hit(routes, '/api/session-matrix/handoff', 'v=v9')
  check('handoff route rejects unknown versions', () => {
    assert.equal(unknownVersion.status, 404)
    assert.deepEqual(unknownVersion.body.versions, ['v1'])
  })

  const caps = await hit(routes, '/api/session-matrix/capabilities')
  check('capabilities reports projections + workspaces', () => {
    assert.equal(caps.status, 200)
    assert.equal(caps.body.contextProjections, true)
    assert.equal(caps.body.workspaceRegistry, true)
    assert.ok(caps.body.projectionKeys.includes('contextTimeline'))
  })

  const overview = await hit(routes, '/api/session-matrix/overview')
  const body = overview.body
  const byId = new Map(body.sessions.map(s => [s.id, s]))

  check('overview lists every session except unused stubs', () => {
    assert.equal(overview.status, 200)
    const stubs = Number(body.capabilities.emptyStubs ?? 0)
    assert.ok(stubs >= 1, 'fixture should contain an unused stub')
    assert.equal(body.sessions.length, fixture.records.length - stubs)
  })

  check('a blank session with no turns is not listed', () => {
    for (const s of body.sessions) {
      assert.ok(!(s.blank === true && (s.turns ?? 0) === 0), `stub leaked: ${s.id}`)
    }
    assert.equal(body.totals.all, body.sessions.length)
  })

  check('dto carries the full contract', () => {
    const sample = body.sessions.find(s => s.contextAvailable)
    assert.ok(sample, 'expected at least one session with context')
    for (const key of ['id', 'title', 'project', 'origin', 'model', 'contextWindow', 'total', 'ratio', 'parts', 'risk', 'activityDays']) {
      assert.ok(key in sample, `missing field ${key}`)
    }
    assert.deepEqual(Object.keys(sample.parts).sort(), ['assistant', 'inject', 'skill', 'system', 'tool', 'tools', 'user'])
  })

  check('ratio equals total / contextWindow', () => {
    const sample = body.sessions.find(s => s.total != null && s.contextWindow)
    const expected = sample.total / sample.contextWindow
    assert.ok(Math.abs(sample.ratio - expected) < 1e-9)
  })

  // Regression: the `title` projection folds to `string | null`. Reading
  // `.title` off it produced `undefined` and every row fell back to the
  // "Untitled session" label — the live panel showed a wall of Untitled.
  check('title projection string is used verbatim', () => {
    for (const s of body.sessions) {
      assert.ok(!/^Untitled/.test(s.title), `session ${s.id} fell back to Untitled`)
      assert.ok(typeof s.title === 'string' && s.title.trim().length > 0,
        `session ${s.id} has an empty title`)
    }
  })

  check('risk level follows the compaction point, not a flat percentage', () => {
    assert.equal(body.thresholds.warnFactor, 0.8)
    assert.equal(body.thresholds.criticalFactor, 0.92)
    for (const s of body.sessions) {
      if (s.ratio == null) { assert.equal(s.risk, 'unknown'); continue }
      assert.ok(s.compactRatio > 0 && s.compactRatio <= 0.8,
        `compactRatio out of range for ${s.id}: ${s.compactRatio}`)
      if (s.ratio >= s.compactRatio * 0.92) assert.equal(s.risk, 'crit', `${s.id} @ ${s.ratio}`)
      else if (s.ratio >= s.compactRatio * 0.8) assert.equal(s.risk, 'warn', `${s.id} @ ${s.ratio}`)
      else assert.equal(s.risk, 'ok', `${s.id} @ ${s.ratio}`)
    }
  })

  check('cost doubles the peak bucket and converts to CNY', () => {
    const timeline = {
      cost: {
        'deepseek-official': {
          'deepseek-flash': {
            off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
            peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 },
          },
        },
      },
    }
    const price = { input: 0.15, cacheRead: 0.003, cacheWrite: 0, output: 0.6 }
    const result = costOfBuckets(timeline, () => price)
    // off: 1M x 0.15 + 1M x 0.6 = 0.75 USD; peak: 1M x 0.15 x 2 = 0.30 USD.
    assert.ok(Math.abs(result.usd - 1.05) < 1e-9, `usd ${result.usd}`)
    assert.ok(Math.abs(result.cny - 1.05 / 0.15) < 1e-9, `cny ${result.cny}`)
    assert.equal(result.peakBuckets, 1)
    assert.equal(costOfBuckets({}, () => price), null, 'no buckets means no cost')

    // Official DeepSeek table: quoted in CNY, so no exchange rate is involved.
    const official = costOfBuckets(timeline, () => null, () => ({ hit: 0.02, miss: 1, out: 4 }))
    // off: 1M x 1 + 1M x 4 = 5 CNY; peak: 1M x 1 x 2 = 2 CNY
    assert.ok(Math.abs(official.cny - 7) < 1e-9, `cny ${official.cny}`)
    assert.equal(official.officialModels, 1)
  })

  check('usage and cost are reported per session', () => {
    const withUsage = body.sessions.filter(s => s.usage)
    assert.ok(withUsage.length > 0, 'expected at least one session with provider usage')
    for (const s of withUsage) {
      for (const key of ['uncached', 'cacheRead', 'cacheWrite', 'output']) {
        assert.equal(typeof s.usage[key], 'number', `${s.id} usage.${key}`)
      }
    }
    // Pricing needs the network, so the test disables it: the field must exist
    // and be null rather than missing or zero.
    for (const s of body.sessions) {
      assert.ok('costUsd' in s, `${s.id} has no costUsd field`)
      assert.ok(s.costUsd === null || typeof s.costUsd === 'number')
    }
    // A wrapped { ver, seq, val } projection must still yield usage — that is what
    // keeps cost working on a host without dsh-context.
    const wrapped = byId.get('session-wrapped')
    if (wrapped) {
      assert.ok(wrapped.usage, 'wrapped tokenUsage should produce usage')
      assert.equal(wrapped.usage.cacheRead, 300)
    }

    assert.equal(body.pricing.enabled, false, 'prices:false must reach the payload')
    assert.equal(body.pricing.ready, false)
  })

  check('subagent project resolves through the parent chain', () => {
    const sub = body.sessions.find(s => s.origin === 'subagent' && s.parentId)
    if (!sub) return
    const parent = byId.get(sub.parentId)
    if (!parent) return
    assert.equal(sub.project, parent.project,
      `subagent project ${sub.project} should match parent ${parent.project}`)
  })

  // The chip row must mirror the workspaces the user actually has. A session
  // outside every workspace path goes to the '' (unassigned) bucket instead of
  // inventing a project from its cwd.
  check('cwd near a workspace name folds into that workspace', () => {
    const folded = body.sessions.filter(s => /AIVde/i.test(s.cwd ?? ''))
    if (!folded.length) return
    for (const s of folded) assert.equal(s.project, 'AIVideo', `not folded: ${s.cwd}`)
    const titles = body.projects.map(p => p.title)
    assert.ok(!titles.includes('AIVdeio'), 'typo folder still listed as its own project')
  })

  check('projects cover every resolved session project', () => {
    const distinct = new Set(body.sessions.map(s => s.project))
    const listed = new Set(body.projects.map(p => p.title))
    for (const title of distinct) {
      assert.ok(listed.has(title), `project "${title}" appears on sessions but not in the list`)
    }
    // '' is the deliberate "belongs to no workspace" bucket.
    for (const p of body.projects) assert.equal(typeof p.title, 'string')
  })

  check('project counts sum to the session total', () => {
    const sum = body.projects.reduce((n, p) => n + p.count, 0)
    assert.equal(sum, body.sessions.length)
  })

  check('totals separate user and subagent sessions', () => {
    const t = body.totals
    assert.equal(t.all, body.sessions.length)
    assert.equal(t.user + t.subagent, t.all)
  })

  check('session without projections degrades to unknown, not zero', () => {
    const ghost = body.sessions.find(s => s.id.startsWith('session-00000000'))
    if (!ghost) return
    assert.equal(ghost.contextAvailable, false)
    assert.equal(ghost.ratio, null)
    assert.equal(ghost.risk, 'unknown')
    assert.equal(ghost.parts, null)
    assert.notEqual(ghost.total, 0, 'must not report 0 tokens for unknown context')
  })

  // ── 2. 上下文口径：provider 压力优先于逐事件估算 ──────────────────────────
  // Real numbers from one live session: the event estimate said 387,554 while
  // the provider reported a 665,491-token prompt. Getting this precedence wrong
  // makes the panel report ~37% for a session that DSH's own footer calls 63%.
  const pressureFixture = {
    records: [{
      header: { id: 'session-p', createdAt: 1, cwd: '/work/Alpha', isSeeded: false },
      live: true,
      persisted: true,
    }],
    workspaces: [{ id: 'w1', title: 'Alpha', path: '/work/Alpha', sessionIds: ['session-p'] }],
    projections: new Map([['session-p', {
      contextTimeline: {
        model: 'deepseek-flash',
        provider: 'deepseek-official',
        contextWindow: 1_048_576,
        maxOutputTokens: 256_000,
        turns: 55,
        steps: 406,
        last: { seq: 10, total: 387_554, prompt: 665_491 },
        current: {
          system: 3_249, tools: 15_281, user: 20_000, inject: 30_000,
          skill: 10_000, assistant: 120_000, tool: 189_000, total: 387_530,
        },
      },
      contextPressure: {
        pressureTokens: 665_491, projectedTokens: 665_767, contextWindow: 1_048_576,
      },
      contextBreakdown: { systemTokens: 3_249, toolsTokens: 15_281, messageTokens: 335_413 },
      // Turns/steps live on sessionStats, not on the timeline wire view.
      sessionStats: { turns: 55, steps: 406, llmMs: 1, toolMs: 1 },
      contextActivity: { days: { '2026-11-16': { tokens: 1000, requests: 3 } } },
      title: 'Pressure probe',
      sessionListMetadata: { blank: false, lastPromptAt: 5 },
    }]]),
  }
  const pressured = makeCtx(pressureFixture)
  apply(pressured.ctx, { prices: false })
  const pBody = (await hit(pressured.routes, '/api/session-matrix/overview')).body
  const p = pBody.sessions[0]

  check('provider-reported pressure beats the event estimate', () => {
    assert.equal(p.contextSource, 'projected')
    assert.equal(p.total, 665_767)
    assert.equal(p.estimatedTotal, 387_530)
    assert.ok(Math.abs(p.ratio - 665_767 / 1_048_576) < 1e-12)
    // 63.5% real, and that lands between the warn (55.5%) and crit (63.8%) lines.
    assert.equal(p.risk, 'warn')
    // Regression: turns/steps are not on the timeline wire view. Reading them
    // from there made every row show "— / —" while the footer said 55 轮 406 步.
    assert.equal(p.turns, 55)
    assert.equal(p.steps, 406)
  })

  check('composition sums to the measured total', () => {
    const sum = Object.values(p.parts).reduce((n, v) => n + v, 0)
    assert.ok(Math.abs(sum - p.total) <= 7, `parts sum ${sum} vs total ${p.total}`)
    assert.deepEqual(Object.keys(p.parts).sort(),
      ['assistant', 'inject', 'skill', 'system', 'tool', 'tools', 'user'])
  })

  const noPressure = {
    ...pressureFixture,
    projections: new Map([['session-p', {
      // No contextPressure / contextBreakdown, but the timeline still carries
      // the provider prompt of the last request.
      contextTimeline: pressureFixture.projections.get('session-p').contextTimeline,
      title: 'Prompt anchored',
      sessionListMetadata: { blank: false, lastPromptAt: 5 },
    }]]),
  }
  const estimateCtx = makeCtx(noPressure)
  apply(estimateCtx.ctx, { prices: false })
  const estBody = (await hit(estimateCtx.routes, '/api/session-matrix/overview')).body

  check('falls back to the last request prompt when pressure is missing', () => {
    const row = estBody.sessions[0]
    assert.equal(row.contextSource, 'prompt+delta')
    // 665_491 provider prompt + (387_530 - 387_554) heuristic delta.
    assert.equal(row.total, 665_467)
  })

  const bareTimeline = { ...noPressure, projections: new Map([['session-p', {
    contextTimeline: { ...noPressure.projections.get('session-p').contextTimeline, last: undefined },
    title: 'Estimate only',
    sessionListMetadata: { blank: false, lastPromptAt: 5 },
  }]]) }
  const bareCtx = makeCtx(bareTimeline)
  apply(bareCtx.ctx, { prices: false })
  const bareBody = (await hit(bareCtx.routes, '/api/session-matrix/overview')).body

  check('last resort is the event estimate, labelled as such', () => {
    const row = bareBody.sessions[0]
    assert.equal(row.contextSource, 'estimate')
    assert.equal(row.total, 387_530)
    assert.equal(row.estimatedTotal, 387_530)
  })

  // ── 3. Degradation without dsh-context ───────────────────────────────────
  const degraded = makeCtx(fixture, { withProjections: false })
  apply(degraded.ctx, { prices: false })
  const dCaps = await hit(degraded.routes, '/api/session-matrix/capabilities')
  check('capabilities reports missing projections', () => {
    assert.equal(dCaps.body.contextProjections, false)
    assert.deepEqual(dCaps.body.projectionKeys, [])
  })
  const dOverview = await hit(degraded.routes, '/api/session-matrix/overview')
  check('overview still answers without projections', () => {
    assert.equal(dOverview.status, 200)
    assert.equal(dOverview.body.sessions.length, fixture.records.length)
    const s = dOverview.body.sessions.find(x => x.total === null)
    assert.ok(s, 'expected sessions reported with null total')
    assert.equal(s.risk, 'unknown')
  })

  // A session with no title source must still read like a session, never like
  // the old placeholder string.
  check('untitled sessions fall back to a readable label', () => {
    for (const s of dOverview.body.sessions) {
      assert.ok(/^(子代理|未命名会话|新会话)/.test(s.title), `bad fallback: ${s.title}`)
    }
  })

  // ── 3. Degradation without workspaceRegistry ─────────────────────────────
  const noWs = makeCtx(fixture, { withWorkspaces: false })
  apply(noWs.ctx, { prices: false })
  const wOverview = await hit(noWs.routes, '/api/session-matrix/overview')
  check('without a registry every session is unassigned', () => {
    assert.equal(wOverview.status, 200)
    const withCwd = wOverview.body.sessions.find(s => s.cwd)
    assert.ok(withCwd, 'expected a session with cwd')
    // No registry means no workspace to attribute to: report the honest empty
    // bucket instead of turning each cwd into a fake project.
    assert.equal(withCwd.project, '')
  })

  // ── 4. Cache behavior ────────────────────────────────────────────────────
  const first = await hit(routes, '/api/session-matrix/overview')
  const second = await hit(routes, '/api/session-matrix/overview')
  check('repeat read is served from the snapshot', () => {
    assert.equal(first.body.generatedAt, second.body.generatedAt,
      'second read within TTL must reuse the collected snapshot')
  })
  const forced = await hit(routes, '/api/session-matrix/overview', 'refresh=1')
  check('refresh=1 recollects', () => {
    assert.ok(forced.body.generatedAt >= first.body.generatedAt)
  })

  // ── Report ───────────────────────────────────────────────────────────────
  console.log(`\nhost.test.mjs — ${pass.length} passed, ${fail.length} failed`)
  for (const label of pass) console.log(`  ✓ ${label}`)
  for (const label of fail) console.log(`  ✗ ${label}`)
  console.log(`\nfixture: ${fixture.records.length} sessions, ${fixture.workspaces.length} projects`)
  console.log(`sample totals: ${JSON.stringify(body.totals)}`)
  if (body.projects.length) {
    console.log('projects:', body.projects.map(p => `${p.title}(${p.count})`).join(', '))
  }
  if (fail.length > 0) process.exitCode = 1
}

main().catch(error => {
  console.error('FATAL', error)
  process.exitCode = 1
})
