/**
 * DSH Session Matrix — browser half.
 *
 * Two surfaces, and only two:
 *   workspace — one pane per session, showing that session's own transcript
 *               (read through the plugin's host route) plus the metrics that
 *               decide whether it needs attention. "Enter" hands over to the
 *               native conversation, which is where writing happens.
 *               Panes are NOT iframes: the desktop shell only runs preload in
 *               the main frame, so a framed copy of the app hangs forever on
 *               `__DSH_BOOT_READY__` before any plugin can load.
 *   cockpit   — rectangular layered session network + three context modules.
 *
 * All colour, radius and hairline values come from the host theme
 * (`--dsw-alias-*`, `--dsw-radius-*`, `--dsh-hairline-width`). No palette is
 * hardcoded, so light / dark / third-party themes all apply. No glow, no blur:
 * hierarchy comes from spacing, weight and hairlines.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-matrix',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = 'api/session-matrix'

    const T = {
      product: '会话矩阵工作台',
      viewWorkspace: '工作区',
      viewCockpit: '智能体脉络',
      all: '全部',
      search: '搜索会话、模型…',
      sessions: '会话',
      refresh: '刷新',
      previewRisk: '模拟预警',
      restore: '恢复真实值',
      openNative: '在原生界面打开',
      enter: '进入',
      newPane: '分栏',
      closePane: '关闭',
      pickSession: '从左侧选择一个会话',
      pickSessionHint: '点左侧任一会话，这里直接嵌入它的原生对话；同一个会话只占一个窗格，最多 4 栏',
      composition: '上下文构成',
      matrix: '会话概览',
      inspector: '会话详情',
      pickNode: '点击网络中的任一节点查看详情',
      noSession: '当前筛选下没有会话',
      used: '已用',
      capacity: '容量',
      usage: '占用',
      turnsSteps: '轮次 / 步',
      noDaily: '无按日统计',
      parts: '构成明细',
      noParts: '该会话暂无构成数据',
      cost: '预估费用',
      cacheHit: '缓存命中',
      usageTitle: '累计用量与费用',
      tokIn: '输入',
      tokOut: '输出',
      tokRead: '缓存读',
      tokWrite: '缓存写',
      requests: '请求',
      zoom: '缩放',
      scopeAll: '全部会话',
      scopePrefix: '范围',
      handoff: '通用交接提示词',
      handoffTitle: '通用交接提示词',
      handoffNote: '只复制，不发送、不改动任何会话',
      handoffTip: '点开看看、改改、复制走。不会替你发送，也不会动任何会话。',
      handoffTip2: '换模型、换 Agent、今天先收工，用得上就来复制。',
      whyTitle: '为什么建议交接',
      howTitle: '怎么用',
      targetTitle: '交接对象',
      scopeSub: '该子代理会话',
      edgesNote: (p, s, c) => `${p} 个项目 · ${s} 个会话 · ${c} 条父子链路 · 0 条跨分支关联（数据源无此关系，不绘制）`,
      levelOk: '正常',
      levelWarn: '注意',
      levelCrit: '临界',
      levelUnknown: '无数据',
      noRisk: '无风险',
      loadFail: '数据加载失败',
      loadFailHint: '请确认宿主半边已加载：GET /api/session-matrix/capabilities',
      main: '主会话',
      sub: '子代理',
      hub: '工作台',
      colProject: '项目',
      colSession: '会话',
      colSub: '子代理',
      noTitle: '未命名会话',
      ungrouped: '未归类',
    }

    const PARTS = [
      ['system', '系统提示', 'var(--dsw-alias-chart-system)'],
      ['tools', '工具定义', 'var(--dsw-alias-chart-tools)'],
      ['user', '用户输入', 'var(--dsw-alias-chart-messages)'],
      ['inject', '注入内容', 'var(--dsw-alias-state-done-primary)'],
      ['skill', '技能目录', 'var(--dsw-alias-state-warn-primary)'],
      ['assistant', '助手回复', 'var(--dsw-alias-state-success-primary)'],
      ['tool', '工具返回', 'var(--dsw-alias-label-tertiary)'],
    ]

    const LEVEL_VAR = {
      ok: 'var(--dsw-alias-label-tertiary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      crit: 'var(--dsw-alias-state-error-primary)',
      unknown: 'var(--dsw-alias-state-idle-primary)',
    }

    const fmt = n => (n == null ? '—'
      : n >= 1e9 ? (n / 1e9).toFixed(2) + 'G'
      : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e8 ? 0 : 2) + 'M'
        : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1) + 'k'
          : String(n))

    const pct = r => (r == null ? '—' : (r * 100).toFixed(1) + '%')

    function relTime(ms) {
      if (!ms) return '—'
      const d = (Date.now() - ms) / 1000
      if (d < 90) return '刚刚'
      if (d < 3600) return `${Math.floor(d / 60)} 分钟前`
      if (d < 86400) return `${Math.floor(d / 3600)} 小时前`
      return `${Math.floor(d / 86400)} 天前`
    }

    /** Live-ish pulse factor: recency decays, and each node gets its own phase
     *  so the network never blinks in unison. */
    function activityOf(session, t) {
      const hours = session.updatedAt ? (Date.now() - session.updatedAt) / 3600000 : 999
      const base = hours < 1 ? 1 : hours < 6 ? 0.8 : hours < 24 ? 0.55 : hours < 72 ? 0.32 : 0.14
      let hash = 0
      const id = String(session.id)
      for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 997
      return Math.max(0.08, Math.min(1, base * (0.78 + 0.22 * Math.sin(t / 2.1 + hash))))
    }

    const isActive = s => Boolean(s.updatedAt) && Date.now() - s.updatedAt < 2 * 3600000

    /** Threshold factors used only when the host sends none. */
    const DEFAULT_FACTORS = { warnFactor: 0.8, criticalFactor: 0.92 }

    const projName = p => p || T.ungrouped

    const levelOf = s => LEVEL_VAR[s.risk] ?? LEVEL_VAR.unknown

    const levelText = s => (s.risk === 'crit' ? T.levelCrit
      : s.risk === 'warn' ? T.levelWarn
        : s.risk === 'unknown' ? T.levelUnknown : T.levelOk)

    /**
     * Where auto-compaction fires, straight from the host.
     *
     * This used to be recomputed here from `window × 0.8` and a 64K headroom,
     * which drifted from the host the moment the host was corrected to mirror
     * `dsh-compaction-basic` (window − reserved output − 4096). Two copies of
     * one formula is a bug waiting for a release; the panel now renders what
     * the host computed and keeps only the threshold factors on this side.
     * @param session - wire DTO.
     * @returns `{ tokens, ratio, retain }` or null when the host sent none.
     */
    function compactPoint(session) {
      if (!(session?.compactTokens > 0)) return null
      return {
        tokens: session.compactTokens,
        ratio: session.compactRatio ?? session.compactTokens / session.contextWindow,
        retain: session.compactRetain ?? 0,
      }
    }

    /**
     * Pre-warning thresholds for one session: the host's factors applied to the
     * host's compaction point.
     * @param session - wire DTO.
     * @param cfg - `{ warnFactor, criticalFactor }` from the host (optional).
     * @returns `{ warn, crit, point }` — ratios; `point` is null when the
     *          window is unknown (then the documented defaults apply).
     */
    function thresholdsOf(session, cfg) {
      const point = compactPoint(session)
      const wf = cfg?.warnFactor ?? 0.8
      const cf = cfg?.criticalFactor ?? 0.92
      if (!point) return { warn: 0.7, crit: 0.85, point: null }
      return { warn: point.ratio * wf, crit: point.ratio * cf, point }
    }

    /**
     * Risk level as classified by the host, so the graph colour and the DTO
     * never disagree.
     * @param session - wire DTO.
     * @returns `'ok' | 'warn' | 'crit' | 'unknown'`.
     */
    function riskOf(session) {
      return session?.risk ?? 'unknown'
    }

    /**
     * Hover text for any context percentage. Every number is derived from the
     * shipped compressor's formula plus this session's own capacity, so the
     * tooltip never claims a percentage the product would not honour.
     * @param session - wire DTO.
     * @param cfg - thresholds config.
     * @returns multi-line tooltip text.
     */
    function contextHint(session, cfg) {
      const point = compactPoint(session)
      const t = thresholdsOf(session, cfg)
      const lines = [
        '上下文占用 = 已用 / 容量',
        session.contextWindow
          ? `已用 ${fmt(session.total)} / 容量 ${fmt(session.contextWindow)} tokens`
          : '该会话没有上下文数据',
      ]
      // Say where the number came from. The event estimate runs ~1.4× low on
      // Chinese-heavy logs, so a mismatch with DSH's own footer needs an
      // explanation here rather than a silent disagreement.
      if (session.contextSource && session.contextSource !== 'estimate') {
        lines.push('已用取服务端返回的实际 prompt（含缓存读写），与状态栏一致')
      } else if (session.contextSource === 'estimate') {
        lines.push('该会话还没有服务端用量样本，这里按事件估算，通常偏低')
      }
      if (session.estimatedTotal > 0 && session.total > 0
        && Math.abs(session.total - session.estimatedTotal) > session.total * 0.05) {
        lines.push(`逐事件估算为 ${fmt(session.estimatedTotal)}，比实际低约 `
          + `${Math.round((session.total / session.estimatedTotal - 1) * 100)}%`)
      }
      if (point) {
        lines.push(
          `DSH 会在约 ${pct(point.ratio)}（${fmt(point.tokens)} tokens）自动压缩历史：`
            + '窗口 − 输出预留 − 4K 余量（与 dsh-compaction-basic 一致）',
          `提醒线按这个点换算：注意 ≥${pct(t.warn)}（${fmt(Math.round(t.warn * session.contextWindow))}），`
            + `临界 ≥${pct(t.crit)}（${fmt(Math.round(t.crit * session.contextWindow))}）`,
          `压缩后只逐字保留最近约 ${fmt(Math.round(point.retain))} tokens，更早的内容换成摘要`,
        )
      }
      lines.push('越接近上限，可用的工作记忆越少；建议在临界线之前收尾或另开会话')
      return lines.join('\n')
    }

    /** Titles the host may already have replaced with its old placeholder. */
    const LEGACY_PLACEHOLDER = /^(untitled( session)?|未命名会话|新会话)$/i

    /**
     * Titles straight from the client session store.
     *
     * `SessionSummary.displayTitle` is documented as "durable title, project
     * basename, then session id" — the same string the native sidebar shows.
     * Reading it here means the panel is correct even when the host half is an
     * older build that still sends a placeholder.
     * @returns id → title map (empty when the service is unavailable).
     */
    function clientTitles() {
      const map = new Map()
      try {
        const c = window.__SESSION_MATRIX_CTX__
        const svc = c && (typeof c.get === 'function' ? c.get('sessions') : c.sessions)
        const list = svc && svc.list
        // `list` is an observable snapshot whose accessor is not part of any
        // documented plugin contract; accept the common shapes instead of
        // betting the feature on one method name.
        let snap = null
        if (list) {
          if (typeof list.getSnapshot === 'function') snap = list.getSnapshot()
          else if (typeof list.get === 'function') snap = list.get()
          else if (typeof list === 'function') snap = list()
          else if (typeof list === 'object' && 'value' in list) snap = list.value
        }
        const rows = snap?.sessions ?? snap?.entries ?? snap?.items
          ?? snap?.list ?? (Array.isArray(snap) ? snap : [])
        for (const row of rows) {
          const id = row?.id ?? row?.sessionId
          if (!id) continue
          const text = row.displayTitle || row.title
          if (typeof text === 'string' && text.trim()) map.set(String(id), text.trim())
        }
      } catch { /* the store is optional; fall back to host titles */ }
      return map
    }

    /**
     * Resolve one session's display title, preferring a real title over any
     * placeholder, and never repeating the same placeholder for every row.
     * @param session - wire DTO.
     * @param map - client title map.
     * @returns display title.
     */
    function titleOf(session, map) {
      const raw = String(session.title ?? '').trim()
      if (raw && !LEGACY_PLACEHOLDER.test(raw)) return raw
      const fromClient = map?.get(String(session.id))
      if (fromClient && !LEGACY_PLACEHOLDER.test(fromClient)) return fromClient
      const kind = session.origin === 'subagent' ? T.sub : T.sessions
      const tail = String(session.id).replace(/^session-/, '').slice(-4)
      return `${projName(session.project)} · ${kind} ${tail}`
    }

    async function fetchOverview(force) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller ? setTimeout(() => controller.abort(), 15000) : 0
      try {
        const res = await fetch(`${API}/overview${force ? '?refresh=1' : ''}`, {
          headers: { accept: 'application/json' },
          signal: controller ? controller.signal : undefined,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.json()
      } finally {
        if (timer) clearTimeout(timer)
      }
    }

    /* ══════════════════ graph layout ══════════════════
     * Rectangular layered layout, because the panel is wide and short: a radial
     * tree pushes 40 nodes onto one circle and leaves two-thirds of the width
     * empty. Columns are hierarchy depth (workbench → project → session →
     * subagent) and rows are real membership, so every link is a fact from the
     * session header — no "same project" links, no invented delegation edges.
     */

    const COL = { hub: 0.032, project: 0.20, main: 0.50, sub: 0.845 }

    /**
     * One session plus every session that descends from it.
     *
     * Used by the cockpit's scope: selecting a main session must make the
     * bottom-left panel talk about that session *and* the subagents it spawned,
     * otherwise the numbers look frozen when you click around the graph.
     * @param id - root session id.
     * @param sessions - all sessions in view.
     * @returns array of sessions (the root first, then descendants in order).
     */
    function subtreeOf(id, sessions) {
      const byId = new Map(sessions.map(s => [s.id, s]))
      const out = []
      for (const s of sessions) {
        let cursor = s.id
        for (let depth = 0; depth < 24 && cursor; depth += 1) {
          if (cursor === id) { out.push(s); break }
          cursor = byId.get(cursor)?.parentId ?? null
        }
      }
      return out
    }

    function computeGraph(data, filter, w, hgt) {
      const all = data?.sessions ?? []
      const q = String(filter.query ?? '').trim().toLowerCase()
      const hitQuery = s => !q
        || `${s.title ?? ''} ${s.project ?? ''} ${s.model ?? ''}`.toLowerCase().includes(q)
      const shown = all.filter(s => (filter.project === '__all' || s.project === filter.project) && hitQuery(s))

      const byId = new Map(all.map(s => [s.id, s]))
      const mains = shown.filter(s => s.origin !== 'subagent')
      const subs = shown.filter(s => s.origin === 'subagent')
      const mainIds = new Set(mains.map(s => s.id))

      // Attach every subagent to its nearest main ancestor inside the current
      // selection. A subagent whose chain leaves the set stays attached to its
      // project, never to a session it is not actually a child of.
      const childrenOf = new Map()
      for (const sub of subs) {
        let cur = sub.parentId
        let owner = null
        for (let guard = 0; cur && guard < 24; guard += 1) {
          if (mainIds.has(cur)) { owner = cur; break }
          cur = byId.get(cur)?.parentId ?? null
        }
        const key = owner ?? `p:${sub.project}`
        if (!childrenOf.has(key)) childrenOf.set(key, [])
        childrenOf.get(key).push(sub)
      }

      const groups = []
      const groupOf = new Map()
      for (const m of mains) {
        let g = groupOf.get(m.project)
        if (!g) {
          g = { name: m.project, mains: [] }
          groupOf.set(m.project, g)
          groups.push(g)
        }
        g.mains.push(m)
      }
      groups.sort((a, b) => b.mains.length - a.mains.length)
      for (const g of groups) g.mains.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1))

      // Shared vertical budget. Every node gets a weighted slot in one pass, so
      // a parent and its children stay adjacent without ever overlapping and
      // without leaving the far column empty.
      const top = 30
      const bottom = 16
      const innerH = Math.max(120, hgt - top - bottom)
      const W_MAIN = 1
      const W_SUB = 0.62
      const W_GROUP = 0.7

      const order = []
      for (let gi = 0; gi < groups.length; gi += 1) {
        const g = groups[gi]
        if (gi > 0) order.push({ kind: 'gap' })
        for (const m of g.mains) {
          order.push({ kind: 'main', session: m, project: g.name })
          for (const sub of childrenOf.get(m.id) ?? []) {
            order.push({ kind: 'sub', session: sub, parentId: m.id, project: g.name })
          }
        }
      }

      const units = order.reduce((sum, it) => sum
        + (it.kind === 'gap' ? W_GROUP : it.kind === 'sub' ? W_SUB : W_MAIN), 0)
      const unit = innerH / Math.max(units, 1)
      const unitMain = unit * W_MAIN

      const x = {
        hub: Math.max(20, w * COL.hub),
        project: Math.max(92, w * COL.project),
        main: Math.max(170, w * COL.main),
        sub: Math.min(w - 26, w * COL.sub),
      }

      const nodes = []
      const links = []
      const hub = { id: '__hub__', kind: 'hub', x: x.hub, y: hgt / 2, r: 6 }
      nodes.push(hub)

      const projectRows = new Map()
      let cursor = top
      let mainOrd = 0
      for (const item of order) {
        if (item.kind === 'gap') { cursor += unit * W_GROUP; continue }
        const weight = item.kind === 'sub' ? W_SUB : W_MAIN
        const y = cursor + (unit * weight) / 2
        cursor += unit * weight

        if (item.kind === 'main') {
          const m = item.session
          const node = {
            id: m.id,
            kind: 'main',
            session: m,
            project: item.project,
            ord: mainOrd++,
            x: x.main,
            y,
            r: 4.6 + 3.1 * Math.min(1, m.ratio ?? 0),
            activity: activityOf(m, 0),
            active: isActive(m),
            risk: m.risk,
          }
          nodes.push(node)
          if (!projectRows.has(item.project)) projectRows.set(item.project, [])
          projectRows.get(item.project).push(node)
        } else {
          const sub = item.session
          const node = {
            id: sub.id,
            kind: 'sub',
            session: sub,
            parentId: item.parentId,
            project: item.project,
            x: x.sub,
            y,
            r: 3.3 + 1.4 * Math.min(1, sub.ratio ?? 0),
            activity: activityOf(sub, 1.4),
            active: isActive(sub),
            risk: sub.risk,
          }
          nodes.push(node)
          links.push({
            from: item.parentId,
            to: sub.id,
            kind: 'child',
            activity: node.activity,
            active: node.active,
            risk: sub.risk,
          })
        }
      }

      for (const g of groups) {
        const rows = projectRows.get(g.name) ?? []
        if (!rows.length) continue
        const projectId = `__p__:${g.name}`
        const project = {
          id: projectId,
          kind: 'project',
          name: g.name,
          x: x.project,
          y: rows.reduce((sum, r) => sum + r.y, 0) / rows.length,
          r: 9.5,
          count: rows.length + rows.reduce((sum, r) => sum + (childrenOf.get(r.id)?.length ?? 0), 0),
          ratio: rows.reduce((sum, r) => sum + (r.session.ratio ?? 0), 0) / rows.length,
        }
        nodes.push(project)
        links.push({ from: hub.id, to: projectId, kind: 'root' })
        for (const r of rows) {
          links.push({
            from: projectId,
            to: r.id,
            kind: 'project',
            activity: r.activity,
            active: r.active,
            risk: r.risk,
          })
        }
      }

      // Subagents whose project has no main session in the current selection:
      // anchor them to the project itself rather than dropping them.
      for (const key of [...childrenOf.keys()].filter(k => k.startsWith('p:'))) {
        const name = key.slice(2)
        const projectId = `__p__:${name}`
        let project = nodes.find(nd => nd.id === projectId)
        const orphans = childrenOf.get(key) ?? []
        if (!project) {
          project = {
            id: projectId, kind: 'project', name, x: x.project,
            y: top + innerH / 2, r: 8, count: orphans.length, ratio: null,
          }
          nodes.push(project)
          links.push({ from: hub.id, to: projectId, kind: 'root' })
        }
        orphans.forEach((sub, i) => {
          const node = {
            id: sub.id,
            kind: 'sub',
            session: sub,
            parentId: projectId,
            project: name,
            x: x.sub,
            y: Math.max(top, Math.min(hgt - bottom, project.y + (i - (orphans.length - 1) / 2) * unit * W_SUB)),
            r: 2.4,
            activity: activityOf(sub, 2.1),
            active: isActive(sub),
            risk: sub.risk,
          }
          nodes.push(node)
          links.push({ from: projectId, to: sub.id, kind: 'child', activity: node.activity, active: node.active, risk: sub.risk })
        })
      }

      const nodeById = new Map(nodes.map(nd => [nd.id, nd]))
      return {
        w, hgt, x, nodes, links, nodeById, unitMain,
        projects: groups.length,
        sessions: shown.length,
        edges: links.length,
        parentChild: links.filter(l => l.kind === 'child').length,
      }
    }

    /** Cubic curve with horizontal tangents at both ends: every edge from one
     *  source leaves in the same direction, so siblings bundle visually. */
    function linkPath(a, b) {
      const dx = Math.max(26, Math.abs(b.x - a.x) * 0.42)
      return `M${a.x.toFixed(1)},${a.y.toFixed(1)}C${(a.x + dx).toFixed(1)},${a.y.toFixed(1)} ${(b.x - dx).toFixed(1)},${b.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`
    }

    /* ══════════════════ styles ══════════════════ */

    const CSS = `
.aw{
  position:relative;
  --aw-hair: var(--dsh-hairline-width, 0.5px);
  --aw-r: var(--dsw-radius-sm, 8px);
  --aw-r-lg: var(--dsw-radius-md, 12px);
  --aw-mono: var(--dsh-font-family-code, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  height:100%;display:flex;flex-direction:column;overflow:hidden;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:var(--dsh-font-family-text, -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif);
  font-size:13px;line-height:20px;-webkit-font-smoothing:antialiased;
}
.aw *{box-sizing:border-box}
.aw button{font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;border:0;background:none;color:inherit}
.aw input{font-family:inherit;font-size:13px;color:inherit}
.aw-hdr{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:10px 16px;
  border-bottom:var(--aw-hair) solid var(--dsw-alias-border-l2);min-height:52px;flex-wrap:nowrap;
  container-type:inline-size}
@container (max-width:1240px){.aw-hdr .opt{display:none}}
@container (max-width:1040px){.aw-hdr .aw-hbtn-k{display:none}}
.aw-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;white-space:nowrap}
.aw-title svg{width:16px;height:16px;flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.aw-sub{font-size:12.5px;font-weight:400;color:var(--dsw-alias-label-caption)}
.aw-seg{display:flex;gap:2px;padding:2px;border-radius:var(--aw-r);
  background:var(--dsw-alias-bg-layer-1);border:var(--aw-hair) solid var(--dsw-alias-border-l2)}
.aw-seg button{padding:3px 12px;border-radius:6px;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.aw-seg button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.aw-seg button[aria-selected="true"]{background:var(--dsw-alias-bg-layer-3);
  color:var(--dsw-alias-label-primary);font-weight:500}
.aw-grow{flex:1 1 auto;min-width:8px}
.aw-stat{display:flex;align-items:center;gap:12px;font-size:13px;
  color:var(--dsw-alias-label-secondary);white-space:nowrap}
.aw-stat b{font-family:var(--aw-mono);font-weight:500;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}
.aw-stat .risk{color:var(--dsw-alias-state-warn-label)}
.aw-field{display:flex;align-items:center;gap:6px;height:28px;padding:0 9px;
  border:var(--aw-hair) solid var(--dsw-alias-border-l3);border-radius:var(--aw-r);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:13px}
.aw-field:focus-within{border-color:var(--dsw-alias-border-selected)}
.aw-field input{border:0;outline:0;background:none;padding:0;min-width:0;flex:1;font-size:13px}
/* Sort cycle: one 34px pill instead of a dropdown the rail cannot fit. */
.aw-sort{flex:0 0 auto;height:20px;padding:0 6px;border-radius:10px;font-size:11px;
  background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);
  display:flex;align-items:center;gap:3px;white-space:nowrap}
.aw-sort:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.aw-field input::placeholder{color:var(--dsw-alias-label-caption)}
.aw-field svg{width:14px;height:14px;flex:0 0 auto}
.aw-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;
  border:var(--aw-hair) solid var(--dsw-alias-border-l3);border-radius:var(--aw-r);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);
  font-size:13px;white-space:nowrap}
.aw-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.aw-btn:active{background:var(--dsw-alias-interactive-bg-active)}
.aw-btn svg{width:14px;height:14px;flex:0 0 auto}
/* Emphasis without the brand pair: button-primary-fill resolves to the
   near-white brand colour in dark mode while label-on-color stays #fff, which
   renders white-on-white. A raised layer + primary label is theme-safe. */
.aw-btn.primary{background:var(--dsw-alias-bg-layer-3);
  border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}
.aw-btn.primary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.aw-btn.ghost{border-color:transparent;background:none}
.aw-btn.ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}
.aw-btn.on{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l4);
  color:var(--dsw-alias-label-primary)}
.aw-btn:disabled{opacity:.45;cursor:default}
.aw-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto}
.aw-main{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}

/* ── workspace: session rail + native panes ── */
.aw-ws{flex:1 1 auto;min-height:0;display:grid;
  grid-template-columns:var(--aw-rail,288px) 0 minmax(0,1fr)}
.aw-rail{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.aw-rail-h{flex:0 0 auto;display:flex;flex-direction:column;gap:8px;padding:10px 12px;
  border-bottom:var(--aw-hair) solid var(--dsw-alias-border-l1)}
.aw-chips{display:flex;gap:4px;flex-wrap:wrap}
.aw-chip{height:22px;padding:0 8px;border-radius:11px;font-size:12.5px;
  border:var(--aw-hair) solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);
  display:inline-flex;align-items:center;gap:4px;max-width:100%}
.aw-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.aw-chip[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-3);
  border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}
.aw-chip .n{font-family:var(--aw-mono);font-size:11px;color:var(--dsw-alias-label-caption)}
.aw-rail-list{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 0 12px}
.aw-rg{padding:8px 12px 2px;font-size:12.5px;color:var(--dsw-alias-label-caption);
  display:flex;align-items:center;gap:6px}
.aw-rg .line{flex:1;height:1px;background:var(--dsw-alias-border-l1)}
.aw-ri{display:flex;align-items:center;gap:7px;padding:3px 12px;cursor:pointer;min-width:0}
.aw-ri:hover{background:var(--dsw-alias-interactive-bg-hover)}
.aw-ri[aria-current="true"]{background:var(--dsw-alias-bg-multi-select)}
.aw-ri .st{width:6px;height:6px;border-radius:50%;flex:0 0 auto}
.aw-ri .body{flex:1;min-width:0}
.aw-ri .l1{display:flex;align-items:center;gap:6px;font-size:13px;line-height:16px;
  color:var(--dsw-alias-label-primary)}
.aw-ri .l1 .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aw-ri .l2{display:flex;align-items:center;gap:6px;font-size:11px;line-height:15px;
  color:var(--dsw-alias-label-caption)}
.aw-ri .l2 .bar{flex:0 0 44px;height:3px;border-radius:2px;margin-left:auto;
  background:var(--dsw-alias-border-l1);overflow:hidden}
.aw-ri .l2 .bar i{display:block;height:100%}
.aw-ri .pc{font-family:var(--aw-mono);font-size:11.5px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;flex:0 0 auto}
.aw-rnode{display:flex;flex-direction:column;min-width:0}
.aw-ri-sub{padding-left:26px;position:relative}
.aw-ri-sub::before{content:'';position:absolute;left:18px;top:0;bottom:0;width:1px;
  background:var(--dsw-alias-border-l1)}
.aw-ri-sub .l1{font-size:13px;color:var(--dsw-alias-label-secondary)}
.aw-rtoggle{display:flex;align-items:center;gap:6px;padding:1px 12px 5px 28px;
  font-size:12.5px;line-height:16px;color:var(--dsw-alias-label-caption);text-align:left}
.aw-rtoggle:hover{color:var(--dsw-alias-label-secondary)}
.aw-rtoggle .caret{width:0;height:0;display:inline-block;
  border-left:4px solid currentColor;border-top:3.5px solid transparent;
  border-bottom:3.5px solid transparent;transition:transform .14s}
.aw-rtoggle .caret.open{transform:rotate(90deg)}
.aw-grip{position:relative;z-index:3;cursor:col-resize;margin-left:-3px;width:6px;
  background:none;border:0;padding:0}
.aw-grip::after{content:'';position:absolute;inset:0 2px;background:var(--dsw-alias-border-l2);
  transition:background .15s}
.aw-grip:hover::after,.aw-grip[data-drag]{background:var(--dsw-alias-trajectory-accent)}
.aw-pane-wrap{display:flex;flex-direction:column;min-height:0;min-width:0}
.aw-pane-wrap>.aw-toolbar{padding:6px 12px;gap:6px}
.aw-panes{display:grid;flex:1 1 auto;min-height:0;min-width:0;
  grid-template-columns:1fr;gap:0;background:var(--dsw-alias-border-l2)}
/* Track sizes come from inline styles: the dividers are real grid items, so
   the drag ratio maps 1:1 onto the visible layout. */
.aw-pane-slot{min-width:0;min-height:0;display:flex;background:var(--dsw-alias-bg-base)}
.aw-pane-slot>.aw-pane{width:100%}
.aw-split{background:var(--dsw-alias-border-l2);transition:background .12s}
.aw-split[data-split="col"]{cursor:col-resize}
.aw-split[data-split="row"]{cursor:row-resize}
.aw-split:hover{background:var(--dsw-alias-trajectory-accent)}
.aw-pane{position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;
  background:var(--dsw-alias-bg-base)}
.aw-pane-h{position:relative;flex:0 0 auto;height:34px;display:flex;align-items:center;gap:8px;padding:0 10px;
  border-bottom:var(--aw-hair) solid var(--dsw-alias-border-l1);min-width:0;
  background:var(--dsw-alias-bg-layer-1);container-type:inline-size}
.aw-pane-h .t{flex:0 1 auto;min-width:0;max-width:30%;font-size:13px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aw-pane-h .ctx{flex:0 0 auto;font-size:11.5px;color:var(--dsw-alias-label-caption);
  white-space:nowrap;display:inline-flex;align-items:baseline;gap:4px}
.aw-pane-h .ctx .ctxv{font-family:var(--aw-mono);font-size:11.5px;
  color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.aw-pane-h .x{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;
  border-radius:4px;color:var(--dsw-alias-label-caption)}
.aw-pane-h .x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.aw-pane-b{flex:1 1 auto;min-height:0;min-width:0;position:relative;
  display:flex;flex-direction:column;overflow:hidden;
  background:var(--dsw-alias-bg-base)}
.aw-zoombox{flex:1 1 auto;min-height:0;min-width:0;overflow:hidden}
.aw-zoom-inner{display:flex;flex-direction:column;min-height:0}
.aw-native{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.aw-pane-fallback{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:6px;padding:20px;text-align:center;
  font-size:13px;line-height:18px;color:var(--dsw-alias-label-caption)}
.aw-pane-fallback .sub{font-size:12.5px;opacity:.8}
.aw-pane-h.warn{box-shadow: inset 2px 0 0 var(--dsw-alias-state-warn-primary)}
.aw-pane-h.crit{box-shadow: inset 2px 0 0 var(--dsw-alias-state-error-primary)}
.aw-risk{flex:0 0 auto;font-size:10.5px;line-height:15px;padding:0 5px;border-radius:3px;
  font-weight:600;letter-spacing:.02em}
.aw-risk.warn{color:var(--dsw-alias-state-warn-label);
  background:color-mix(in oklab, var(--dsw-alias-state-warn-primary) 18%, transparent)}
.aw-risk.crit{color:var(--dsw-alias-state-error-label);
  background:color-mix(in oklab, var(--dsw-alias-state-error-primary) 18%, transparent)}
.aw-ro{flex:0 0 auto;font-size:10.5px;line-height:15px;padding:0 5px;border-radius:3px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-caption);
  border:var(--aw-hair) solid var(--dsw-alias-border-l1)}
.aw-zoom{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  display:inline-flex;align-items:center;gap:5px;flex:0 0 auto}
.aw-zoom-k{font-size:11px;color:var(--dsw-alias-label-caption);white-space:nowrap}
.aw-zoom-range{-webkit-appearance:none;appearance:none;width:58px;height:14px;
  background:none;cursor:pointer;margin:0}
.aw-zoom-range::-webkit-slider-runnable-track{height:3px;border-radius:2px;
  background:var(--dsw-alias-border-l3)}
.aw-zoom-range::-webkit-slider-thumb{-webkit-appearance:none;width:10px;height:10px;
  margin-top:-3.5px;border-radius:50%;background:var(--dsw-alias-trajectory-accent);
  border:0;box-shadow:0 0 0 1px var(--dsw-alias-bg-base)}
.aw-zoom-range:hover::-webkit-slider-thumb{transform:scale(1.15)}
.aw-zoom-val{font-size:11px;line-height:14px;color:var(--dsw-alias-label-caption);
  font-variant-numeric:tabular-nums;min-width:28px;text-align:right}
/* Narrow panes: drop the words, keep the numbers. A 4-up pane is ~420px, and
   the labels are what push the zoom slider into the context figure. */
@container (max-width:520px){
  .aw-pane-h .ctxk{display:none}
  .aw-zoom-k{display:none}
  .aw-zoom-range{width:46px}
}
@container (max-width:430px){
  .aw-pane-h .t{max-width:24%}
  .aw-pane-h{gap:6px}
  .aw-zoom-val{display:none}
  .aw-zoom-range{width:40px}
}
.aw-veil{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:10px;padding:28px;text-align:center;
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:19px}
.aw-veil .big{font-size:13px;color:var(--dsw-alias-label-secondary)}
.aw-veil code{font-family:var(--aw-mono);font-size:12.5px;color:var(--dsw-alias-label-caption);word-break:break-all}
.aw-veil .row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}

/* ── handoff: top-bar entry, hover card, dialog ── */
.aw-hbtn{position:relative;flex:0 0 auto}
.aw-handoff{height:26px;gap:5px}
.aw-hbtn-dot{position:absolute;top:0;right:0;width:7px;height:7px;border-radius:50%;
  background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}
.aw-hbtn-dot.crit{background:var(--dsw-alias-state-error-primary)}
/* Hover explains, click opens. A delay keeps the pointer on its way to the
   refresh button from flashing a card. */
.aw-tip{position:absolute;top:calc(100% + 8px);right:0;width:268px;z-index:30;padding:9px 10px;
  border-radius:7px;border:var(--aw-hair) solid var(--dsw-alias-border-l3);
  background:var(--dsw-alias-bg-layer-2);box-shadow:0 8px 26px rgba(0,0,0,.2);
  font-size:12.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  opacity:0;pointer-events:none;transition:opacity .12s ease .2s;text-align:left}
.aw-hbtn:hover .aw-tip{opacity:1}
.aw-tip b{display:block;margin-bottom:4px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.aw-tip .sub{margin-top:4px;color:var(--dsw-alias-label-caption)}
/* Instant tooltips. Native title waits ~1s; these open on hover with no
   delay. Only used on elements whose ancestors do not clip overflow. */
[data-tip]{position:relative}
[data-tip]::after{content:attr(data-tip);position:absolute;z-index:60;top:calc(100% + 8px);left:0;
  width:max-content;max-width:320px;padding:8px 10px;border-radius:7px;white-space:pre-line;
  border:var(--aw-hair) solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);
  box-shadow:0 10px 28px rgba(0,0,0,.22);font-size:12.5px;line-height:16px;font-weight:400;
  color:var(--dsw-alias-label-tertiary);text-align:left;opacity:0;pointer-events:none;
  transition:opacity .08s ease}
[data-tip]:hover::after{opacity:1}
[data-tip].tip-r::after{left:auto;right:0}
/* Theme-dependent bits: dust specks and shadows. The rest of the panel uses
   --dsw-alias-* tokens, which already flip with the shell theme. */
.aw{--aw-dust:#ffffff}
.aw[data-theme="light"]{--aw-dust:#5b6472}
.aw[data-theme="light"] .aw-modal{background:rgba(15,23,42,.26)}
.aw[data-theme="light"] .aw-tip{box-shadow:0 10px 28px rgba(15,23,42,.14)}
.aw[data-theme="light"] .aw-modal-c{box-shadow:0 20px 64px rgba(15,23,42,.2)}
/* Narrow headers keep the icon and drop the words. */
@container (max-width:880px){ .aw-hbtn-k{display:none} }
.aw-ver{font-family:var(--aw-mono);font-size:11px;color:var(--dsw-alias-label-caption);
  padding:1px 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.aw-modal{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;
  padding:18px;background:rgba(0,0,0,.44);container-type:inline-size}
.aw-modal-c{display:flex;flex-direction:column;width:min(800px,100%);height:min(640px,100%);
  border-radius:10px;border:var(--aw-hair) solid var(--dsw-alias-border-l3);
  background:var(--dsw-alias-bg-layer-1);box-shadow:0 20px 64px rgba(0,0,0,.38);overflow:hidden}
.aw-modal-h{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:11px 14px;
  border-bottom:var(--aw-hair) solid var(--dsw-alias-border-l1)}
.aw-modal-h h2{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.aw-modal-h .x{margin-left:auto;width:24px;height:24px;border:0;border-radius:5px;cursor:pointer;
  background:none;color:var(--dsw-alias-label-caption);display:flex;align-items:center;justify-content:center}
.aw-modal-h .x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.aw-modal-b{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:296px minmax(0,1fr)}
.aw-modal-l{overflow:auto;padding:12px 14px;border-right:var(--aw-hair) solid var(--dsw-alias-border-l1)}
.aw-modal-r{display:flex;flex-direction:column;min-width:0;gap:6px;padding:12px 14px}
.aw-modal-r textarea{flex:1 1 auto;min-height:0;width:100%;box-sizing:border-box;resize:none;
  font-family:var(--aw-mono);font-size:12.5px;line-height:17px;padding:8px 10px;border-radius:6px;
  border:var(--aw-hair) solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-secondary)}
.aw-modal-r .lab{font-size:11.5px;color:var(--dsw-alias-label-caption)}
.aw-modal-f{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:10px 14px;
  border-top:var(--aw-hair) solid var(--dsw-alias-border-l1)}
.aw-fnote{margin-right:auto}
.aw-fnote>div{font-size:11.5px;line-height:15px;color:var(--dsw-alias-label-caption)}
.aw-fnote .sub{color:var(--dsw-alias-label-tertiary)}
.aw-hsec{margin:0 0 4px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.aw-hsec-sub{margin-left:6px;font-weight:400;font-size:11px;color:var(--dsw-alias-label-caption)}
.aw-hp{margin:0 0 10px;font-size:12.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}
.aw-hp b{color:var(--dsw-alias-label-secondary);font-weight:600}
.aw-hp>div{margin-bottom:5px}
.aw-hp>div:last-child{margin-bottom:0}
.aw-steps>div{margin-bottom:5px}
.aw-hp code{font-family:var(--aw-mono);font-size:11.5px;padding:0 3px;border-radius:3px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}
.aw-hcard{display:flex;flex-direction:column;gap:4px;width:100%;text-align:left;padding:8px 10px;
  margin-bottom:6px;border-radius:7px;
  border:var(--aw-hair) solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);cursor:pointer}
.aw-hcard:hover{border-color:var(--dsw-alias-border-l3)}
.aw-hcard[aria-pressed="true"]{border-color:var(--dsw-alias-trajectory-accent);background:var(--dsw-alias-bg-multi-select)}
.aw-hcard-h{display:flex;align-items:baseline;gap:6px;min-width:0}
.aw-hcard-h .t{flex:1 1 auto;min-width:0;font-size:13px;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aw-hcard .tag{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-trajectory-accent)}
/* One bar, two facts: the fill is current usage, the tick is where DSH compacts. */
.aw-hcard-bar{position:relative;display:block;height:3px;border-radius:2px;
  background:var(--dsw-alias-bg-layer-3);overflow:hidden}
.aw-hcard-bar i{position:absolute;left:0;top:0;bottom:0;border-radius:2px;opacity:.85}
.aw-hcard-bar em{position:absolute;top:-2px;bottom:-2px;width:1px;
  background:var(--dsw-alias-label-primary);opacity:.45}
.aw-hcard-r{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
  font-family:var(--aw-mono);font-size:11px;color:var(--dsw-alias-label-caption)}
.aw-hcard .d{font-size:11px;color:var(--dsw-alias-label-tertiary)}
/* The two sentences that explain the trade-off; bold + a left rule so they read
   as the conclusion rather than as more body copy. */
.aw-hp-strong{padding:7px 9px;border-radius:0 5px 5px 0;margin:2px 0 7px;
  border-left:2px solid var(--dsw-alias-trajectory-accent);
  background:var(--dsw-alias-bg-layer-2)}
.aw-hp-strong b{font-weight:600;color:var(--dsw-alias-label-primary)}
.aw-rot{display:inline-flex;animation:aw-rot .9s linear infinite}
@keyframes aw-rot{to{transform:rotate(360deg)}}
/* Mini spec sheet: the three lines the panel paints. */
.aw-tbl{display:flex;flex-direction:column;gap:0;margin:2px 0 4px;
  border:var(--aw-hair) solid var(--dsw-alias-border-l2);border-radius:6px;overflow:hidden}
.aw-tbl-h,.aw-tbl-r{display:grid;grid-template-columns:78px minmax(0,1fr);gap:8px;padding:5px 8px}
.aw-tbl-h{font-size:11px;color:var(--dsw-alias-label-caption);
  background:var(--dsw-alias-bg-layer-2);border-bottom:var(--aw-hair) solid var(--dsw-alias-border-l2)}
.aw-tbl-r{font-size:11.5px;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.aw-tbl-r + .aw-tbl-r{border-top:var(--aw-hair) solid var(--dsw-alias-border-l1)}
.aw-tbl-r .n{font-family:var(--aw-mono);color:var(--dsw-alias-label-secondary)}
.aw-tbl-note{margin-bottom:8px;font-size:11px;line-height:14px;color:var(--dsw-alias-label-caption)}
.aw-other{width:100%;margin-top:2px;padding:4px 6px;border-radius:5px;font-size:12.5px;
  border:var(--aw-hair) solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-secondary)}
@container (max-width:700px){
  .aw-modal-b{grid-template-columns:1fr;grid-template-rows:minmax(0,auto) minmax(0,1fr)}
  .aw-modal-l{border-right:0;border-bottom:var(--aw-hair) solid var(--dsw-alias-border-l1);max-height:44%}
}
@keyframes aw-flash{0%,100%{box-shadow:inset 0 0 0 0 transparent}50%{box-shadow:inset 0 0 0 2px var(--dsw-alias-trajectory-accent)}}
.aw-pane[data-flash="1"]{animation:aw-flash .78s ease-in-out 3}
@media (prefers-reduced-motion: reduce){.aw-pane[data-flash="1"]{animation:none;outline:1px solid var(--dsw-alias-trajectory-accent)}}

/* ── cockpit: canvas + modules ── */
.aw-toolbar{flex:0 0 auto;display:flex;align-items:center;gap:8px;
  padding:8px 16px;border-bottom:var(--aw-hair) solid var(--dsw-alias-border-l2);flex-wrap:wrap}
.aw-canvas{flex:1 1 auto;min-height:0;position:relative;overflow:hidden}
.aw-canvas svg{display:block;width:100%;height:100%}
.aw-node{cursor:pointer}
.aw-node:focus{outline:none}
.aw-breathe{animation:aw-breathe 3.8s ease-in-out infinite}
@keyframes aw-breathe{0%,100%{opacity:.14}50%{opacity:.4}}
.aw-risk-ring{transform-box:fill-box;transform-origin:center;
  animation:aw-risk 2.8s ease-out infinite}
@keyframes aw-risk{0%{transform:scale(1);opacity:.5}70%{transform:scale(2.2);opacity:0}100%{opacity:0}}
.aw-flow{animation:aw-flow linear infinite}
@keyframes aw-flow{to{stroke-dashoffset:-28}}
/* A label the density rules hid becomes readable while its node is hovered.
   Done in CSS on purpose: a React state change here meant re-rendering the
   whole graph (40 nodes, 58 animations) on every pointer move. */
.aw-node .aw-ml-hide{opacity:0}
.aw-node:hover .aw-ml-hide{opacity:1}
@media (prefers-reduced-motion: reduce){
  .aw-breathe,.aw-risk-ring,.aw-flow{animation:none}
}
.aw-legend{display:flex;align-items:center;gap:12px;font-size:12.5px;
  color:var(--dsw-alias-label-caption);white-space:nowrap}
.aw-legend span{display:inline-flex;align-items:center;gap:5px}
.aw-note{position:absolute;right:10px;bottom:10px;font-size:12.5px;padding:2px 6px;
  color:var(--dsw-alias-label-caption);pointer-events:none;text-align:right;max-width:60%;
  background:var(--dsw-alias-bg-base)}
.aw-bot{flex:0 0 auto;display:grid;grid-template-columns:var(--aw-b1,1fr) 8px var(--aw-b2,1.25fr) 8px var(--aw-b3,1.15fr);
  color:var(--dsw-alias-label-secondary);
  border-top:var(--aw-hair) solid var(--dsw-alias-border-l2);height:288px}
.aw-mod{min-width:0;min-height:0;display:flex;flex-direction:column;padding:10px 16px 8px;overflow:hidden}
.aw-mod+.aw-mod{border-left:var(--aw-hair) solid var(--dsw-alias-border-l2)}
.aw-mh{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
  margin-bottom:6px;flex:0 0 auto}
.aw-mh h3{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary);margin:0}
.aw-mh span{font-size:12.5px;color:var(--dsw-alias-label-caption);font-family:var(--aw-mono)}
.aw-scope{flex:0 0 auto;margin:-4px 0 6px;font-size:11.5px;line-height:14px;
  color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.aw-mb{flex:1 1 auto;min-height:0;overflow:auto;display:flex;flex-direction:column}
.aw-stack{display:flex;height:6px;border-radius:3px;overflow:hidden;margin-bottom:8px;
  background:var(--dsw-alias-bg-layer-2)}
.aw-stack i{height:100%;transition:width .3s}
.aw-bot-h{width:8px;cursor:col-resize;border-radius:3px}
.aw-bot-h:hover,.aw-bot-h.on{background:var(--dsw-alias-border-l2)}
.aw-comp{display:grid;grid-template-columns:1fr 1fr;gap:1px 12px;font-size:13px}
.aw-comp div{display:flex;align-items:center;gap:5px;min-width:0;line-height:16px}
.aw-comp .k{color:var(--dsw-alias-label-tertiary);flex:1;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.aw-comp .v{font-family:var(--aw-mono);font-size:12.5px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}
.aw-comp .sw{width:8px;height:8px;border-radius:2px;flex:0 0 auto}
.aw-ug{display:grid;grid-template-columns:1fr 1fr;gap:1px 12px;font-size:13px}
.aw-ug>div{display:flex;align-items:baseline;gap:6px;min-width:0;line-height:17px}
.aw-ug .k{color:var(--dsw-alias-label-tertiary);flex:1;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.aw-ug .v{font-family:var(--aw-mono);font-size:13px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}
.aw-mb>.aw-sec{display:flex;align-items:baseline;justify-content:space-between;gap:8px;
  margin:10px 0 5px}
.aw-sec-sum{font-family:var(--aw-mono);font-size:11px;color:var(--dsw-alias-label-caption)}
.aw-cap{font-size:12.5px;line-height:17px;color:var(--dsw-alias-label-caption);
  margin-top:auto;padding-top:8px}
.aw-cap b{font-weight:500;color:var(--dsw-alias-label-tertiary);font-family:var(--aw-mono)}
.aw-mx{flex:1;min-height:0;overflow:auto}
.aw-mxh,.aw-row{display:grid;grid-template-columns:minmax(0,1fr) 84px 74px 52px;
  gap:8px;align-items:center;padding:0 6px}
.aw-mxh{position:sticky;top:0;z-index:1;height:22px;font-size:12.5px;
  color:var(--dsw-alias-label-caption);background:var(--dsw-alias-bg-base);
  border-bottom:var(--aw-hair) solid var(--dsw-alias-border-l2);padding-bottom:4px;margin-bottom:2px}
.aw-row{height:26px;border-radius:5px;cursor:pointer;font-size:13px}
.aw-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.aw-row[aria-selected="true"]{background:var(--dsw-alias-bg-multi-select)}
.aw-row.dim{opacity:.4}
.aw-row .nm{display:flex;align-items:center;gap:5px;min-width:0;
  color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.aw-row .nm svg{width:12px;height:12px;flex:0 0 auto;color:var(--dsw-alias-label-caption)}
.aw-row .mdl{color:var(--dsw-alias-label-caption);font-family:var(--aw-mono);font-size:12.5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aw-row .bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.aw-row .bar i{display:block;height:100%}
.aw-row .pc{text-align:right;font-family:var(--aw-mono);font-size:12.5px;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.aw-insp{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:5px;padding-right:2px}
.aw-insp-empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:6px;font-size:13px;color:var(--dsw-alias-label-caption);text-align:center}
.aw-insp-empty svg{width:20px;height:20px;opacity:.5}
.aw-it{font-size:13.5px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary);flex:0 0 auto}
.aw-im{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:12.5px;
  line-height:15px;color:var(--dsw-alias-label-caption)}
.aw-ig{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2px 10px;flex:0 0 auto}
.aw-kv .k{font-size:12.5px;color:var(--dsw-alias-label-caption);line-height:16px}
.aw-kv .v{font-family:var(--aw-mono);font-size:13px;line-height:18px;
  color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.aw-kv .v small{font-size:12.5px;color:var(--dsw-alias-label-caption);margin-left:2px}
.aw-sec{font-size:12.5px;font-weight:600;line-height:15px;color:var(--dsw-alias-label-tertiary)}
.aw-muted{font-size:12.5px;color:var(--dsw-alias-label-caption)}
.aw-iact{flex:0 0 auto;display:flex;gap:8px;padding-top:4px}
.aw-iact .aw-btn{height:26px}
.aw-iact .aw-btn{flex:1;justify-content:center}
.aw-empty{display:flex;align-items:center;justify-content:center;height:100%;
  font-size:13px;color:var(--dsw-alias-label-caption)}
.aw-toast{position:absolute;left:50%;transform:translateX(-50%);bottom:18px;z-index:20;
  max-width:70%;padding:8px 14px;border-radius:var(--aw-r);
  border:var(--aw-hair) solid var(--dsw-alias-border-l3);
  background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);
  font-size:13px;line-height:18px;box-shadow:0 4px 16px rgba(0,0,0,.18);
  display:flex;align-items:center}
.aw-err{padding:16px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-warn-label)}
.aw-err code{font-family:var(--aw-mono);font-size:12.5px;color:var(--dsw-alias-label-tertiary);
  display:block;margin-top:6px}
@media (max-width:1180px){
  .aw-bot{grid-template-columns:1fr 1fr;height:190px}
  .aw-mod:last-child{display:none}
}
@media (max-width:920px){
  .aw-ws{grid-template-columns:1fr !important;grid-template-rows:minmax(0,38%) minmax(0,1fr)}
  .aw-grip{display:none}
  .aw-rail{border-right:0;border-bottom:var(--aw-hair) solid var(--dsw-alias-border-l2)}
  .aw-bot{grid-template-columns:1fr;height:172px}
  .aw-mod:nth-child(2){display:none}
  .aw-pane+.aw-pane{display:none}
}
`

    /* ══════════════════ icons ══════════════════ */

    function Icon({ name, size = 16 }) {
      const p = {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
      }
      switch (name) {
        case 'network':
          return h('svg', p, [
            h('circle', { key: 'a', cx: 3, cy: 8, r: 1.4, fill: 'currentColor', stroke: 'none' }),
            h('circle', { key: 'b', cx: 8, cy: 4, r: 1.2 }),
            h('circle', { key: 'c', cx: 8, cy: 12, r: 1.2 }),
            h('circle', { key: 'd', cx: 13, cy: 6, r: 1.1 }),
            h('circle', { key: 'e', cx: 13, cy: 11, r: 1.1 }),
            h('path', { key: 'f', d: 'M3 8l5-4M3 8l5 4M8 4l5 2M8 12l5-1' }),
          ])
        case 'chat':
          return h('svg', p, [
            h('path', { key: 'a', d: 'M2.6 3.4h10.8v7.2H7.4L4.4 13v-2.4H2.6z' }),
          ])
        case 'search':
          return h('svg', p, [
            h('circle', { key: 'a', cx: 7, cy: 7, r: 4 }),
            h('path', { key: 'b', d: 'M10 10l3.2 3.2' }),
          ])
        case 'refresh':
          return h('svg', p, [
            h('path', { key: 'a', d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
            h('path', { key: 'b', d: 'M13 2.6v2.6h-2.6' }),
          ])
        case 'enter':
          return h('svg', p, [
            h('path', { key: 'a', d: 'M6 3H3.6v10H6' }),
            h('path', { key: 'b', d: 'M9 5.6L12 8l-3 2.4M12 8H6' }),
          ])
        case 'close':
          return h('svg', p, [h('path', { key: 'a', d: 'M4 4l8 8M12 4l-8 8' })])
        case 'single':
          return h('svg', p, [h('rect', { key: 'a', x: 2.2, y: 3, width: 11.6, height: 10, rx: 1.6 })])
        case 'plus':
          return h('svg', p, h('path', { d: 'M8 3.4v9.2M3.4 8h9.2' }))
        case 'sub':
          return h('svg', p, [
            h('path', { key: 'a', d: 'M4 3v4.4a2 2 0 0 0 2 2h6' }),
            h('path', { key: 'b', d: 'M9.6 7l2.4 2.4L9.6 12' }),
          ])
        // A sheet with an arrow leaving it: "take this elsewhere".
        case 'handoff':
          return h('svg', p, [
            h('path', { key: 'a', d: 'M9.4 2.6H3.4v10.8h7.2V9.2' }),
            h('path', { key: 'b', d: 'M7.6 8.4l5-5M9 3.2h3.8v3.8' }),
          ])
        default:
          return h('svg', p, h('circle', { cx: 8, cy: 8, r: 5 }))
      }
    }

    /* ══════════════════ network ══════════════════ */

    /** Honour the OS "reduce motion" setting: particles are decoration. */
    const REDUCE_MOTION = (() => {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
    })()

    function Network({ graph, selected, onSelect, onProject, pinned }) {
      const pinnedSet = React.useMemo(() => new Set(pinned ?? []), [pinned])
      const subOrd = React.useMemo(() => {
        const map = new Map()
        const rows = (graph?.nodes ?? []).filter(nd => nd.kind === 'sub').sort((a, b) => a.y - b.y)
        rows.forEach((nd, i) => map.set(nd.id, i))
        return map
      }, [graph])
      if (!graph) return null
      if (!graph.sessions) {
        return h('div', { className: 'aw-canvas' },
          h('div', { className: 'aw-empty' }, T.noSession))
      }
      const { w, hgt, nodes, links, x } = graph
      const selNode = selected ? nodes.find(nd => nd.id === selected) : null
      const selPath = new Set()
      if (selNode) {
        selPath.add(selNode.id)
        let cur = selNode
        for (let i = 0; i < 4 && cur; i += 1) {
          const up = cur.kind === 'sub' ? cur.parentId
            : cur.kind === 'main' ? `__p__:${cur.session.project}`
              : cur.kind === 'project' ? '__hub__' : null
          if (!up) break
          selPath.add(up)
          cur = graph.nodeById.get(up)
        }
      }
      const dimmed = nd => Boolean(selNode) && !selPath.has(nd.id)
      // Selecting a main session also lights up its own subagents: that is the
      // one moment where their titles are guaranteed to fit, because the
      // density rules never hide a child of the selected node.
      const selKids = new Set()
      if (selNode?.kind === 'main') {
        for (const lk of links) {
          if (lk.kind === 'child' && lk.from === selNode.id) {
            selKids.add(lk.to)
            selPath.add(lk.to)
          }
        }
      }

      const guides = [
        { at: x.project, label: T.colProject, anchor: 'end' },
        { at: x.main, label: T.colSession, anchor: 'start' },
        { at: x.sub - 14, label: T.colSub, anchor: 'start' },
      ]

      return h('div', { className: 'aw-canvas' }, [
        h('svg', { key: 'svg', viewBox: `0 0 ${w} ${hgt}`, preserveAspectRatio: 'xMidYMid meet' }, [
          h('g', { key: 'grid' },
            guides.map((gd, i) => h('g', { key: i }, [
              h('line', {
                key: 'l',
                x1: gd.at, y1: 26, x2: gd.at, y2: hgt - 10,
                stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1, strokeDasharray: '2 6',
              }),
              h('text', {
                key: 't',
                x: gd.anchor === 'end' ? gd.at - 8 : gd.at + 8,
                y: 16,
                textAnchor: gd.anchor,
                fontSize: 10.5,
                fill: 'var(--dsw-alias-label-caption)',
                letterSpacing: '0.08em',
              }, gd.label),
            ])),
            h('text', {
              key: 'hub',
              x: x.hub, y: 16, fontSize: 10.5,
              fill: 'var(--dsw-alias-label-caption)', letterSpacing: '0.08em',
            }, T.hub),
          ),

          h('g', { key: 'links' },
            links.map((lk, i) => {
              const a = graph.nodeById.get(lk.from)
              const b = graph.nodeById.get(lk.to)
              if (!a || !b) return null
              const on = selPath.has(lk.from) && selPath.has(lk.to)
              const dim = Boolean(selNode) && !on
              const base = lk.kind === 'root' ? 0.34 : lk.kind === 'project' ? 0.24 : 0.2
              const width = lk.kind === 'root' ? 1.3 : lk.kind === 'project' ? 1 : 0.85
              const d = linkPath(a, b)
              // Particles ride only the links that end at a session currently
              // loaded in a workspace pane: the cockpit then shows "these are
              // the ones I am watching", not 40 identical animations.
              const traced = pinnedSet.has(lk.to)
              const pathId = `aw-lp-${i}`
              // Traffic, not decoration: the old 2.2–4.2s crawl read as a slow
              // drift. Four dots on a link the user is watching, two on a
              // subagent link, all at roughly twice the old speed.
              const speed = Math.max(0.95, 1.9 - (lk.activity ?? 0) * 0.9)
              const dots = lk.kind === 'child' ? 2 : 4
              const rDot = lk.kind === 'child' ? 1.8 : 2.6
              return h('g', { key: `${lk.from}>${lk.to}:${i}`, opacity: dim ? 0.18 : 1 }, [
                lk.kind !== 'child' ? h('path', {
                  key: 'glow',
                  d, fill: 'none',
                  stroke: on ? 'var(--dsw-alias-trajectory-accent)' : 'var(--dsw-alias-label-tertiary)',
                  strokeWidth: on ? 4.5 : 3.4,
                  strokeOpacity: on ? 0.16 : 0.07,
                  strokeLinecap: 'round',
                }) : null,
                h('path', {
                  key: 'p',
                  id: pathId,
                  d, fill: 'none',
                  stroke: on ? 'var(--dsw-alias-trajectory-accent)' : 'var(--dsw-alias-label-tertiary)',
                  strokeWidth: on ? 1.7 : width,
                  strokeOpacity: on ? 0.9 : base + (lk.activity ?? 0) * 0.22,
                  strokeLinecap: 'round',
                }),
                traced && !REDUCE_MOTION ? h('g', { key: 'pt' },
                  Array.from({ length: dots }, (_, d) => {
                    const tint = lk.risk === 'crit' ? 'var(--dsw-alias-state-error-primary)'
                      : lk.risk === 'warn' ? 'var(--dsw-alias-state-warn-primary)'
                        : 'var(--dsw-alias-trajectory-accent)'
                    return h('g', { key: `p${d}` }, [
                      // Halo + core: a 2.6px dot on a 1px line is easy to miss,
                      // a soft 6px glow travelling with it is not.
                      h('circle', { key: 'h', r: rDot * 2.4, fill: tint, opacity: 0.16 }),
                      h('circle', { key: 'c', r: rDot, fill: tint, opacity: on ? 1 : 0.85 }),
                      h('animateMotion', {
                        key: 'm',
                        dur: `${speed.toFixed(2)}s`,
                        begin: `${((d / dots) * speed).toFixed(2)}s`,
                        repeatCount: 'indefinite',
                        rotate: 'auto',
                      }, h('mpath', { key: 'mp', href: `#${pathId}`, xlinkHref: `#${pathId}` })),
                    ])
                  })) : null,
                !traced && !REDUCE_MOTION ? h('g', { key: 'dust' },
                  // Faint dust on every idle link. The graph sits on an empty
                  // background, so twenty dead grey curves read as a wireframe;
                  // a couple of slow white specks make it look alive without
                  // competing with the coloured traffic on the watched panes.
                  Array.from({ length: lk.kind === 'child' ? 1 : 2 }, (_, d) => {
                    const drift = 7.5 + ((i + d * 3) % 5) * 1.3
                    return h('g', { key: `d${d}` }, [
                      h('circle', { key: 'h', r: 2.4, fill: 'var(--aw-dust)', opacity: 0.14 }),
                      h('circle', { key: 'c', r: 1.15, fill: 'var(--aw-dust)', opacity: 0.5 }),
                      h('animateMotion', {
                        key: 'm',
                        dur: `${drift.toFixed(2)}s`,
                        begin: `${((d / 2) * drift + (i % 3) * 0.6).toFixed(2)}s`,
                        repeatCount: 'indefinite',
                      }, h('mpath', { key: 'mp', href: `#${pathId}`, xlinkHref: `#${pathId}` })),
                    ])
                  })) : null,
                // Flow only where the target session has real recent activity.
                lk.active && lk.kind !== 'root' ? h('path', {
                  key: 'f',
                  d, fill: 'none',
                  stroke: lk.risk === 'crit' ? 'var(--dsw-alias-state-error-primary)'
                    : lk.risk === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-trajectory-accent)',
                  strokeWidth: on ? 2 : 1.2,
                  strokeOpacity: on ? 0.85 : 0.55,
                  strokeLinecap: 'round',
                  strokeDasharray: '2 11',
                  className: 'aw-flow',
                  style: { animationDuration: `${(2.1 - (lk.activity ?? 0) * 0.9).toFixed(2)}s` },
                }) : null,
              ].filter(Boolean))
            }),
          ),

          h('g', { key: 'nodes' },
            nodes.map(nd => {
              const dim = dimmed(nd)
              const isSel = selected === nd.id
              const isHub = nd.kind === 'hub'
              const isProject = nd.kind === 'project'
              const color = isHub || isProject
                ? 'var(--dsw-alias-label-secondary)'
                : levelOf(nd.session)
              const riskVar = nd.risk === 'crit' ? 'var(--dsw-alias-state-error-primary)'
                : nd.risk === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : null
              const label = nd.session?.title || T.noTitle
              // Vertical room decides how many titles fit: a subagent row is
              // 0.62 of a main one, so the two columns get separate budgets.
              // 1 = every row, 2 = every other row, 0 = only on demand.
              const rowH = graph.unitMain ?? 20
              const subH = rowH * 0.62
              const dense = rowH < 13
              const subBudget = subOrd.size <= 8 || subH >= 20 ? 1 : subH >= 9 ? 2 : 0
              const staggered = (subOrd.get(nd.id) ?? 0) % 2 === 0
              // When a main session is selected its subagents are the subject,
              // so they take priority over the rest of the column.
              const focus = selKids.size > 0
              const subLabel = focus
                ? selKids.has(nd.id) && (subBudget === 1 || staggered || isSel)
                : subBudget === 1 || (subBudget === 2 && staggered) || isSel
              const showLabel = isProject
                || (nd.kind === 'main'
                  && (!dense || isSel || nd.risk !== 'ok' || (nd.ord ?? 0) % 2 === 0))
                // A subagent title is the only thing that explains that
                // column, so show it whenever it fits and on demand (hover /
                // select) when it does not. Risk deliberately does not force it
                // here: at 10px rows the forced labels collide, and the red
                // ring already says it.
                || (nd.kind === 'sub' && subLabel)
              const maxChars = nd.kind === 'sub' ? 12 : 17

              const clickable = Boolean(nd.session) || isHub || isProject
              return h('g', {
                key: nd.id,
                className: 'aw-node',
                role: clickable ? 'button' : undefined,
                tabIndex: clickable ? 0 : undefined,
                style: clickable ? { cursor: 'pointer' } : undefined,
                'aria-label': nd.session ? `${label} · ${pct(nd.session.ratio)}`
                  : isHub ? '工作台：显示全部项目' : `${nd.name}：只看该项目`,
                opacity: dim ? 0.34 : 1,
                onClick: () => {
                  if (nd.session) { onSelect(isSel ? null : nd.session.id); return }
                  if (isHub) { onSelect(null); onProject('__all'); return }
                  if (isProject) { onSelect(null); onProject(nd.name) }
                },
                onKeyDown: ev => {
                  if (!nd.session && !isHub && !isProject) return
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault()
                    if (nd.session) onSelect(isSel ? null : nd.session.id)
                    else if (isHub) { onSelect(null); onProject('__all') }
                    else { onSelect(null); onProject(nd.name) }
                  }
                },
              }, [
                !isHub && !isProject ? h('circle', {
                  key: 'soft',
                  cx: nd.x, cy: nd.y, r: nd.r * 2.9,
                  fill: levelOf(nd.session),
                  fillOpacity: 0.07 + (nd.active ? 0.05 : 0),
                }) : null,

                nd.active && !isHub ? h('circle', {
                  key: 'halo',
                  cx: nd.x, cy: nd.y, r: nd.r * 2.6,
                  fill: riskVar ?? 'var(--dsw-alias-trajectory-accent)',
                  className: 'aw-breathe',
                  style: { animationDelay: `${((nd.x + nd.y) % 24) / 10}s` },
                }) : null,

                riskVar ? h('circle', {
                  key: 'risk',
                  cx: nd.x, cy: nd.y, r: nd.r,
                  fill: 'none', stroke: riskVar, strokeWidth: 1.2,
                  className: 'aw-risk-ring',
                }) : null,

                h('circle', {
                  key: 'core',
                  cx: nd.x, cy: nd.y, r: isSel ? nd.r + 2.5 : nd.r,
                  fill: isProject ? 'var(--dsw-alias-bg-layer-3)' : (riskVar ? 'var(--dsw-alias-bg-base)' : color),
                  fillOpacity: isProject ? 1 : (riskVar ? 0.95 : (isHub ? 1 : 0.88 + 0.12 * (nd.activity ?? 0.4))),
                  stroke: isSel ? 'var(--dsw-alias-trajectory-accent)'
                    : isProject ? 'var(--dsw-alias-border-l4)' : (riskVar ?? 'none'),
                  strokeWidth: isSel ? 2 : (isProject ? 1.2 : 1),
                }),

                isProject ? h('text', {
                  key: 'pl',
                  x: nd.x - nd.r - 10, y: nd.y,
                  textAnchor: 'end', dominantBaseline: 'middle',
                  fontSize: 12, fontWeight: 600,
                  fill: isSel ? 'var(--dsw-alias-trajectory-accent)' : 'var(--dsw-alias-label-primary)',
                  stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 3,
                  paintOrder: 'stroke', strokeLinejoin: 'round',
                }, nd.name) : null,

                isProject ? h('text', {
                  key: 'pn',
                  x: nd.x - nd.r - 10, y: nd.y + 14,
                  textAnchor: 'end', fontSize: 10.5,
                  fill: 'var(--dsw-alias-label-caption)',
                  stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 3,
                  paintOrder: 'stroke', strokeLinejoin: 'round',
                }, `${nd.count} 个会话`) : null,

                // Usage ring: the percentage is a ring around the dot, so the
                // label stays one line and 16 rows still fit without touching.
                nd.kind === 'main' && nd.session.ratio != null ? (() => {
                  const c = 2 * Math.PI * (nd.r + 3)
                  return h('circle', {
                    key: 'ring',
                    cx: nd.x, cy: nd.y, r: nd.r + 3,
                    fill: 'none',
                    stroke: levelOf(nd.session),
                    strokeWidth: 1.3,
                    strokeDasharray: `${(Math.min(1, nd.session.ratio) * c).toFixed(2)} ${c.toFixed(2)}`,
                    strokeLinecap: 'round',
                    transform: `rotate(-90 ${nd.x} ${nd.y})`,
                    opacity: 0.9,
                  })
                })() : null,

                // Rendered even when the density rules hide it: a hover that
                // toggled React state used to re-render all 40 nodes and 58
                // SMIL animations on every pointer move, which is what made the
                // cockpit feel sticky. CSS does the reveal now.
                !isProject ? h('g', {
                  key: 'ml',
                  className: showLabel ? 'aw-ml' : 'aw-ml aw-ml-hide',
                }, [
                  h('text', {
                    key: 't',
                    x: nd.x - nd.r - (nd.kind === 'sub' ? 6 : 8), y: nd.y,
                    textAnchor: 'end', dominantBaseline: 'middle',
                    fontSize: nd.kind === 'sub' ? 10.5 : 11.5,
                    fill: isSel ? 'var(--dsw-alias-trajectory-accent)'
                      : dim ? 'var(--dsw-alias-label-caption)'
                        : nd.kind === 'sub' ? 'var(--dsw-alias-label-tertiary)'
                          : 'var(--dsw-alias-label-secondary)',
                    stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 3,
                    paintOrder: 'stroke', strokeLinejoin: 'round',
                  }, label.length > maxChars ? label.slice(0, maxChars) + '…' : label),
                  // The percentage sits to the right of the dot, where the
                  // subagent column has no room left.
                  isSel && nd.kind !== 'sub' ? h('text', {
                    key: 'p',
                    x: nd.x + nd.r + 8, y: nd.y,
                    textAnchor: 'start', dominantBaseline: 'middle',
                    fontSize: 10.5,
                    fontFamily: 'var(--aw-mono)',
                    fill: levelOf(nd.session),
                    stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 3,
                    paintOrder: 'stroke', strokeLinejoin: 'round',
                  }, pct(nd.session.ratio)) : null,
                ].filter(Boolean)) : null,

                isHub ? h('title', { key: 'tt' }, '工作台 · 点击显示全部项目') : null,
                isProject ? h('title', { key: 'tt' },
                  `${nd.name} · ${nd.count} 个会话 · 点击只看该项目`) : null,
                nd.session ? h('title', { key: 'tt' },
                  `${label}\n${nd.session.project} · ${nd.session.origin === 'subagent' ? T.sub : T.main}`
                  + `\n${nd.session.model ?? '模型未知'} · 占用 ${pct(nd.session.ratio)}`
                  + `\n${fmt(nd.session.total)} / ${nd.session.contextWindow ? fmt(nd.session.contextWindow) : '未知'} tok`
                  + `\n最近活动 ${relTime(nd.session.updatedAt)}`) : null,
              ].filter(Boolean))
            }),
          ),
        ]),

        h('div', {
          key: 'nt',
          className: 'aw-note',
          title: T.edgesNote(graph.projects, graph.sessions, graph.parentChild),
        }, `${graph.sessions} 会话 · ${graph.parentChild} 条父子链路 · 0 条跨分支关联`),
      ])
    }

    /**
     * The graph is the most expensive thing in the panel — ~40 nodes and ~60 SMIL
     * animations. Re-rendering it on unrelated state (a toast, a poll) restarts
     * those animations and drops frames, so skip the render unless the layout,
     * the selection or the pinned panes actually changed.
     */
    const NetworkMemo = React.memo(Network, (a, b) => a.graph === b.graph
      && a.selected === b.selected
      && a.pinned.length === b.pinned.length
      && a.pinned.every((v, i) => v === b.pinned[i]))

    /* ══════════════════ bottom modules ══════════════════ */

    /** Sum one numeric field across a session's daily activity rows. */
    function activitySum(session, field) {
      let sum = 0
      for (const day of Object.values(session.activityDays ?? {})) {
        const v = day?.[field]
        if (typeof v === 'number' && Number.isFinite(v)) sum += v
      }
      return sum
    }

    /** `$0.0042` — small amounts need more decimals than a total. */
    /**
     * Friendly model names.
     *
     * `deepseek-flash` is the **current** API id and serves V4.1-Flash;
     * `deepseek-v4-flash` is the old name of the same model (still accepted, and
     * priced identically), so both read as V4.1 Flash. The raw id stays in the
     * tooltip for anyone who needs to check.
     */
    const MODEL_LABEL = {
      'deepseek-flash': 'V4.1 Flash',
      'deepseek-v4-flash': 'V4.1 Flash 旧名',
      'deepseek-v4.1-flash': 'V4.1 Flash',
      'deepseek-v4-pro': 'V4 Pro',
      'deepseek-chat': 'V3.2 Chat',
      'deepseek-reasoner': 'V3.2 Reasoner',
    }
    // Grouping key: the old id belongs to the same model, so the caption adds
    // them up instead of listing the same model twice.
    const MODEL_KEY = { 'deepseek-v4-flash': 'deepseek-flash', 'deepseek-v4.1-flash': 'deepseek-flash' }
    /** Sort modes for the session rail, in cycle order. */
    const SORT = [
      ['ratio', '占用'],
      ['recent', '最近'],
      ['cost', '费用'],
    ]
    const sortLabel = key => SORT.find(x => x[0] === key)?.[1] ?? '占用'

    const modelKey = m => (m == null ? '—' : (MODEL_KEY[m] ?? m))
    const modelLabel = m => (m == null ? '—' : (MODEL_LABEL[m] ?? String(m).replace(/^deepseek-/, '')))

    /**
     * Money in CNY.
     *
     * The host prices DeepSeek's own models from the official CNY list and only
     * falls back to models.dev (USD) for third-party routes, so this is the same
     * number the official pricing page implies — dollars here made the panel
     * disagree with every other DSH cost readout by 6.7×.
     */
    const cny = v => (v == null || !Number.isFinite(v) ? '—'
      : v >= 100 ? `¥${v.toFixed(0)}`
        : v >= 1 ? `¥${v.toFixed(2)}`
          : v >= 0.01 ? `¥${v.toFixed(3)}`
            : `¥${v.toFixed(4)}`)

    /**
     * Prompt-cache hit rate: cached reads over every input token billed.
     * @param session - wire DTO.
     * @returns ratio in [0,1], or null when the host sent no usage.
     */
    function hitRateOf(session) {
      const u = session?.usage
      if (!u) return null
      const side = (u.uncached ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
      return side > 0 ? (u.cacheRead ?? 0) / side : null
    }

    /**
     * Bottom-left module: what the context is made of, and what it has cost.
     *
     * The part breakdown comes from `contextTimeline.current`; the usage and
     * cost numbers come from the provider's own token accounting
     * (`tokenUsage` / `contextActivity.cost`), priced at models.dev list rates.
     * Nothing here is inferred from message counts.
     */
    function Composition({ sessions, pricing, scopeLabel }) {
      const totals = {}
      let sum = 0
      for (const s of sessions) {
        if (!s.parts) continue
        for (const [k] of PARTS) {
          const v = s.parts[k] ?? 0
          totals[k] = (totals[k] ?? 0) + v
          sum += v
        }
      }
      const caps = new Map()
      for (const s of sessions) {
        if (!s.contextWindow) continue
        const key = modelLabel(modelKey(s.model))
        const prev = caps.get(key) ?? { count: 0, cap: s.contextWindow }
        caps.set(key, { count: prev.count + 1, cap: s.contextWindow })
      }
      const unknown = sessions.filter(s => s.ratio == null).length

      // Provider token accounting, aggregated over the current selection.
      const usage = { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
      let usageSessions = 0
      let costSum = 0
      let costSessions = 0
      let peakBuckets = 0
      for (const s of sessions) {
        if (s.usage) {
          usageSessions += 1
          usage.uncached += s.usage.uncached ?? 0
          usage.cacheRead += s.usage.cacheRead ?? 0
          usage.cacheWrite += s.usage.cacheWrite ?? 0
          usage.output += s.usage.output ?? 0
        }
        if (Number.isFinite(s.costCny)) {
          costSum += s.costCny
          costSessions += 1
        }
        peakBuckets += s.costPeakBuckets ?? 0
      }
      const inputSide = usage.uncached + usage.cacheRead + usage.cacheWrite
      const hitRate = inputSide > 0 ? usage.cacheRead / inputSide : null
      const requests = sessions.reduce((n, s) => n + activitySum(s, 'requests'), 0)

      const cell = (key, k, v, title) => h('div', { key, title },
        h('span', { key: 'k', className: 'k' }, k),
        h('span', { key: 'v', className: 'v' }, v))

      return h('section', { className: 'aw-mod' }, [
        h('div', { className: 'aw-mh', key: 'h' }, [
          h('h3', { key: 't' }, T.composition),
          h('span', {
            key: 's',
            title: '当前上下文快照：把所有选中会话此刻占用的 prompt 加起来。'
              + '它不是累计消耗——累计在下面的「累计用量与费用」里。'
              + '容量按模型分别统计，不混算成单一百分比',
          }, sum ? fmt(sum) + ' tok · 当前' : '—'),
        ]),
        // Which sessions this panel is talking about. Without it, a project
        // click and a session click look identical: both just show numbers.
        scopeLabel ? h('div', {
          key: 'scope',
          className: 'aw-scope',
          title: '面板统计范围：跟着驾驶舱里选中的节点走',
        }, scopeLabel) : null,
        h('div', { className: 'aw-mb', key: 'b' }, [
          h('div', {
            className: 'aw-stack',
            key: 'st',
            title: '构成比例由事件逐条估算；总量按服务端返回的 prompt 校准，所以各项之和等于顶部那个数',
          },
            PARTS.map(([k, , color]) => (totals[k]
              ? h('i', {
                key: k,
                style: { width: `${(totals[k] / sum) * 100}%`, background: color },
                title: `${k} ${fmt(totals[k])}`,
              })
              : null)).filter(Boolean)),
          h('div', { className: 'aw-comp', key: 'cp' },
            PARTS.map(([k, label, color]) => h('div', { key: k }, [
              h('span', { key: 's', className: 'sw', style: { background: color } }),
              h('span', { key: 'k', className: 'k' }, label),
              h('span', { key: 'v', className: 'v' },
                sum ? ((totals[k] ?? 0) / sum * 100).toFixed(1) + '%' : '—'),
            ]))),

          h('div', {
            className: 'aw-sec',
            key: 's2',
            title: '会话开始至今的累计计费 token，与上面「当前上下文」不是同一口径：'
              + '上面是此刻占着多少，这里是历史上一共读过多少',
          }, [
            h('span', { key: 't' }, T.usageTitle),
            // "这个项目一共烧了多少" is the sum of all four billing buckets —
            // a different number from the current context above.
            h('span', { key: 's', className: 'aw-sec-sum' },
              usageSessions
                ? `合计 ${fmt(usage.uncached + usage.cacheRead + usage.cacheWrite + usage.output)} tok`
                : ''),
          ]),
          h('div', { className: 'aw-ug', key: 'ug' }, [
            cell('cost', T.cost, cny(costSessions ? costSum : null),
              costSessions
                ? 'DeepSeek 官方人民币价：谷时价，峰时（北京时间工作日 '
                  + '09:00–12:00、14:00–18:00）按 2 倍计；第三方路由按 models.dev 美元价折算\n'
                  + '不含折扣与订阅优惠'
                  + `\n覆盖 ${costSessions} / ${sessions.length} 个会话`
                  + (peakBuckets ? `，其中 ${peakBuckets} 个峰时桶` : '')
                  + (pricing?.ready ? '' : '\n价格表尚未取到，下次刷新会重试')
                : `暂无价格数据${pricing?.ready ? '（这些会话的模型不在价格表里）' : '（价格表未取到，无法联网时会一直为空）'}`),
            cell('hit', T.cacheHit, hitRate == null ? '—' : (hitRate * 100).toFixed(1) + '%',
              `命中缓存的输入 token / 全部输入 token（含缓存写）`
                + `\n${fmt(usage.cacheRead)} / ${fmt(inputSide)} tok`
                + '\n越高越省钱：未命中的输入按全价计费'),
            cell('in', T.tokIn, usageSessions ? fmt(usage.uncached) : '—',
              `未命中缓存的输入 token，按全价计费\n合计 ${fmt(inputSide)} 输入 token`),
            cell('out', T.tokOut, usageSessions ? fmt(usage.output) : '—',
              '模型生成的输出 token'),
            cell('read', T.tokRead, usageSessions ? fmt(usage.cacheRead) : '—',
              '从服务端提示缓存命中的输入 token'),
            cell('write', T.tokWrite, usageSessions ? fmt(usage.cacheWrite) : '—',
              '写入提示缓存的输入 token（通常按输入价计费）'),
            cell('rq', T.requests, requests ? fmt(requests) : '—',
              '按会话按日累计的模型请求次数（来自 host 的活动统计）'),
            cell('ss', T.sessions, String(sessions.length),
              `当前统计范围内的会话数；费用与用量覆盖其中 `
                + `${usageSessions} 个有 token 记账的会话`),
          ]),
        ].filter(Boolean)),
        h('div', { className: 'aw-cap', key: 'c' }, [
          // The currency needs a word next to it: a bare "$" in a Chinese UI
          // reads as a rendering mistake, and we have no CNY price source.
          h('div', { key: 'm' }, '费用按人民币 · 峰时 2 倍 · 官方价目表'),
          h('div', { key: 'b' },
            [...caps.entries()].map(([m, v]) => `${m} × ${v.count}`).join(' · ')),
          unknown ? h('div', { key: 'c' },
            `${unknown} 个会话缺少上下文数据，显示为未知而非 0`) : null,
        ].filter(Boolean)),
      ])
    }

    function Matrix({ sessions, selected, onSelect, th }) {
      return h('section', { className: 'aw-mod' }, [
        h('div', { className: 'aw-mh', key: 'h' }, [
          h('h3', { key: 't' }, T.matrix),
          h('span', { key: 's' }, `${sessions.length}`),
        ]),
        h('div', { className: 'aw-mb', key: 'b' }, [
          // Every column names its own unit: a bare "%" next to "占用" reads as
          // decoration, and nobody can tell which of the two columns is which.
          h('div', {
            className: 'aw-mxh',
            key: 'h',
            title: '上下文占用 = 已用 / 容量（与服务端状态栏同口径）；'
              + '条形上的竖线刻度是该会话的压缩点，越过它 DSH 就会压缩历史',
          }, [
            h('span', { key: 'a' }, '会话'),
            h('span', { key: 'b' }, '模型'),
            h('span', { key: 'c' }, '上下文占用'),
            h('span', { key: 'd', style: { textAlign: 'right' } }, '占用率'),
          ]),
          h('div', { className: 'aw-mx', key: 'l', role: 'listbox', 'aria-label': T.matrix },
            sessions.map(s => {
              const point = compactPoint(s)
              return h('div', {
                key: s.id,
                className: 'aw-row',
                role: 'option',
                tabIndex: 0,
                'aria-selected': selected === s.id,
                title: contextHint(s, th),
                onKeyDown: ev => {
                  if (ev.key !== 'Enter' && ev.key !== ' ') return
                  ev.preventDefault()
                  onSelect(selected === s.id ? null : s.id)
                },
                onClick: () => onSelect(selected === s.id ? null : s.id),
              }, [
                h('span', { key: 'n', className: 'nm' }, [
                  h(Icon, { key: 'i', name: s.origin === 'subagent' ? 'sub' : 'chat', size: 12 }),
                  h('span', {
                    key: 't',
                    style: { overflow: 'hidden', textOverflow: 'ellipsis' },
                  }, s.title || T.noTitle),
                ]),
                h('span', { key: 'm', className: 'mdl' }, modelLabel(s.model)),
                h('span', { key: 'b', className: 'bar' }, [
                  h('i', {
                    key: 'f',
                    style: {
                      width: `${Math.min(100, (s.ratio ?? 0) * 100)}%`,
                      background: levelOf(s),
                    },
                  }),
                  // The mark is the point where compaction actually fires for
                  // this session; a full bar is not the danger line.
                  point ? h('b', {
                    key: 'k',
                    style: { left: `${Math.min(100, point.ratio * 100)}%` },
                    title: `压缩点 ${pct(point.ratio)}`,
                  }) : null,
                ]),
                h('span', { key: 'p', className: 'pc' }, pct(s.ratio)),
              ])
            })),
        ]),
      ])
    }

    function Inspector({ session, onOpen, th }) {
      if (!session) {
        return h('section', { className: 'aw-mod' }, [
          h('div', { className: 'aw-mh', key: 'h' }, [h('h3', { key: 't' }, T.inspector)]),
          h('div', { className: 'aw-insp', key: 'e' }, h('div', { className: 'aw-insp-empty' }, [
            h(Icon, { key: 'i', name: 'network', size: 20 }),
            h('span', { key: 's' }, T.pickNode),
          ])),
        ])
      }
      const days = Object.keys(session.activityDays ?? {}).sort()
      const vals = days.map(d => session.activityDays[d]?.tokens ?? 0)
      const mx = Math.max(1, ...vals)
      let spark
      if (vals.length >= 3) {
        spark = vals.map((v, i) => h('i', {
          key: i,
          style: { height: `${Math.max(6, (v / mx) * 100)}%`, background: levelOf(session) },
        }))
      } else if (vals.length > 0) {
        spark = h('div', { className: 'aw-muted', key: 'one' },
          `${fmt(vals[vals.length - 1])} tok · ${days[days.length - 1]} · 仅 ${vals.length} 天数据`)
      } else {
        spark = h('div', { className: 'aw-muted', key: 'none' }, T.noDaily)
      }
      const partsTotal = session.parts
        ? PARTS.reduce((sum, [k]) => sum + (session.parts[k] ?? 0), 0) : 0

      return h('section', { className: 'aw-mod' }, [
        h('div', { className: 'aw-mh', key: 'h' }, [
          h('h3', { key: 't' }, T.inspector),
          h('span', { key: 's', style: { color: levelOf(session) } }, levelText(session)),
        ]),
        h('div', { className: 'aw-insp', key: 'b' }, [
          h('div', { key: 't', className: 'aw-it' }, session.title || T.noTitle),
          h('div', { key: 'm', className: 'aw-im' }, [
            h('span', { key: 'p' }, session.project),
            h('span', { key: 'd' }, '·'),
            h('span', { key: 'o' }, session.origin === 'subagent' ? T.sub : T.main),
            h('span', { key: 'd2' }, '·'),
            h('span', { key: 'mo', title: session.model ?? '' }, modelLabel(session.model)),
            h('span', { key: 'd3' }, '·'),
            h('span', { key: 't2' }, relTime(session.updatedAt)),
            vals.length ? h('span', { key: 't3' },
              `· 近 ${vals.length} 天 ${fmt(vals.reduce((a, b) => a + b, 0))} tok`) : null,
          ].filter(Boolean)),
          h('div', { key: 'g', className: 'aw-ig' }, [
            h('div', { key: 'a', className: 'aw-kv' }, [
              h('div', { key: 'k', className: 'k' }, T.used),
              h('div', { key: 'v', className: 'v' }, fmt(session.total)),
            ]),
            h('div', { key: 'b', className: 'aw-kv' }, [
              h('div', { key: 'k', className: 'k' }, T.capacity),
              h('div', { key: 'v', className: 'v' }, fmt(session.contextWindow)),
            ]),
            h('div', { key: 'c', className: 'aw-kv', title: contextHint(session, th) }, [
              h('div', { key: 'k', className: 'k' }, T.usage),
              h('div', { key: 'v', className: 'v', style: { color: levelOf(session) } },
                pct(session.ratio)),
            ]),
            h('div', { key: 'd', className: 'aw-kv' }, [
              h('div', { key: 'k', className: 'k' }, T.turnsSteps),
              h('div', { key: 'v', className: 'v' },
                `${session.turns ?? '—'} / ${session.steps ?? '—'}`),
            ]),
            h('div', {
              key: 'e',
              className: 'aw-kv',
              title: session.costSource === 'totals'
                ? '按谷时价估算：没读到请求时间，仅供比较，不是账单金额'
                : session.costSource === 'log'
                  ? '按 DeepSeek 官方价目表计价，峰谷按会话日志里的请求时间分桶'
                  : '按 DeepSeek 官方价目表计价，峰时按 2× 计',
            }, [
              h('div', { key: 'k', className: 'k' }, T.cost),
              h('div', { key: 'v', className: 'v' },
                session.costSource === 'totals' && session.costCny != null
                  ? `≈${cny(session.costCny)}`
                  : cny(session.costCny)),
            ]),
            h('div', {
              key: 'f',
              className: 'aw-kv',
              title: session.usage
                ? `命中缓存的输入 token / 全部输入 token`
                  + `\n${fmt(session.usage.cacheRead)} / `
                  + `${fmt((session.usage.uncached ?? 0) + (session.usage.cacheRead ?? 0) + (session.usage.cacheWrite ?? 0))} tok`
                : '该会话还没有取到 token 用量',
            }, [
              h('div', { key: 'k', className: 'k' }, T.cacheHit),
              h('div', { key: 'v', className: 'v' }, pct(hitRateOf(session))),
            ]),
          ]),
          h('div', { key: 's2', className: 'aw-sec' }, T.parts),
          session.parts ? h('div', { key: 'pt' }, [
            h('div', { key: 'bar', className: 'aw-stack', style: { marginBottom: 6 } },
              PARTS.map(([k, , color]) => (session.parts[k]
                ? h('i', {
                  key: k,
                  style: {
                    width: `${partsTotal ? (session.parts[k] / partsTotal) * 100 : 0}%`,
                    background: color,
                  },
                })
                : null)).filter(Boolean)),
            h('div', { key: 'lg', className: 'aw-comp' },
              PARTS.map(([k, label, color]) => h('div', { key: k }, [
                h('span', { key: 's', className: 'sw', style: { background: color } }),
                h('span', { key: 'k', className: 'k' }, label),
                h('span', { key: 'v', className: 'v' },
                  partsTotal ? ((session.parts[k] / partsTotal) * 100).toFixed(0) + '%' : '—'),
              ]))),
          ]) : h('div', { key: 'np', className: 'aw-muted' }, T.noParts),
        ]),
        h('div', { className: 'aw-iact', key: 'act' },
          h('button', {
            className: 'aw-btn primary',
            onClick: () => onOpen(session.id),
          }, [h(Icon, { key: 'i', name: 'enter', size: 14 }), T.openNative])),
      ])
    }

    /* ══════════════════ workspace: native panes ══════════════════ */

        /** Zoom levels offered in each pane header. */
    const ZOOM_STEPS = [1, 0.85, 0.7, 0.55]
    /** Slider order: small on the left, 100% on the right. */
    const ZOOM_LADDER = [0.55, 0.7, 0.85, 1]

    /**
     * One pane = one **native** conversation.
     *
     * The shipped `conversation.content` factory is hosted here, wrapped in the
     * `SessionProvider` the renderer hands our registration. That is the whole
     * reason the panel declares a session-scoped child slot: it is what makes
     * `standardKit()` inject `SessionProvider` + `renderFactorySlot`.
     *
     * Not an iframe: the desktop shell runs preload only in the main frame, so a
     * framed copy of the app never boots. Not a re-implementation either — this
     * is the same component the shipped Conversation panel renders, so tool
     * rows, approvals and Chat/Trajectory tabs come for free.
     *
     * Zoom renders the conversation at `1/zoom` of the pane and scales it back
     * down, so 70% shows ~1.4x more content at 70% size.
     */
    function NativePane({ session, kit, index, total, onClose, onOpenNative, th, flash }) {
      const ctx = React.useRef(window.__SESSION_MATRIX_CTX__).current
      const [reference, setReference] = React.useState(null)
      const [ready, setReady] = React.useState(false)
      const [retainError, setRetainError] = React.useState(null)
      // Zoom is per session, not global: a value set in one pane must not make
      // every newly opened pane start zoomed out.
      const [zoom, setZoom] = React.useState(() => {
        try {
          const v = Number(localStorage.getItem(`aw.zoom.${session.id}`))
          return ZOOM_STEPS.includes(v) ? v : 1
        } catch { return 1 }
      })
      const id = session.id

      // Retain for exactly as long as this pane shows the session. The signal is
      // the backstop for unmounts that skip cleanup (fast refresh, error
      // boundary); release() runs in the cleanup path either way.
      React.useEffect(() => {
        if (!id || typeof ctx?.sessions?.retain !== 'function') return undefined
        const controller = new AbortController()
        let ref = null
        try {
          ref = ctx.sessions.retain(id, { source: 'dsh-session-matrix', signal: controller.signal })
          setRetainError(null)
          // The reference is a handle, not an opened session: rendering the
          // factory before `ready` settles makes the conversation paint its
          // "会话不可用" state, which then sticks.
          Promise.resolve(ref.ready).then(() => {
            if (!controller.signal.aborted) {
              setReference(ref)
              setReady(true)
            }
          }, error => {
            if (!controller.signal.aborted) setRetainError(error)
          })
        } catch (error) {
          setRetainError(error)
        }
        return () => {
          controller.abort()
          try { ref?.release?.() } catch { /* already released */ }
          setReference(null)
          setReady(false)
        }
      }, [id, ctx])

      const applyZoom = next => {
        setZoom(next)
        try { localStorage.setItem(`aw.zoom.${id}`, String(next)) } catch { /* private mode */ }
      }

      const { SessionProvider, renderFactorySlot } = kit ?? {}
      // Verified against the shipped panel: it derives the factory phase from
      // shellPhase, openState and the session-list blank flag.
      //
      //   settling = shellPhase === blank && openState === loading
      //   hero     = blank === true || (shellPhase === blank && openState === open)
      //
      // The pane slot injects neither a session id nor the conversation store,
      // and the one status hook it does inject (useSessionStatus) carries run
      // state only: { running, pendingInteraction, completionUnread }. There is
      // no settling/hero signal to read here. Every session this panel lists is
      // already open and non-blank, which is exactly the active case, so the
      // constant is correct rather than lazy.
      const phase = 'active'

      const scaled = zoom < 0.999
      const canRender = typeof SessionProvider === 'function' && typeof renderFactorySlot === 'function'

      const risk = session.risk === 'crit' ? 'crit' : session.risk === 'warn' ? 'warn' : null
      const zoomIdx = Math.max(0, ZOOM_LADDER.indexOf(zoom))

      return h('div', {
        className: 'aw-pane',
        'data-pane': id,
        'data-risk': risk ?? 'ok',
        'data-flash': flash ? '1' : undefined,
        'data-phase': phase,
      }, [
        h('div', { className: `aw-pane-h${risk ? ` ${risk}` : ''}`, key: 'h' }, [
          h('span', { key: 'dot', className: 'aw-dot', style: { background: levelOf(session) } }),
          h('span', { key: 't', className: 't', title: session.title }, session.title || T.noTitle),
          // A subagent session cannot be prompted directly, so its composer
          // reports "会话不可用". Say so up front instead of letting it look
          // like a broken pane.
          session.origin === 'subagent' ? h('span', {
            key: 'ro',
            className: 'aw-ro',
            title: '子代理会话：可以查看，但不能在这里直接发消息',
          }, '只读 · 子代理') : null,
          // Zoom is pinned to the optical centre of the header, on purpose:
          // while it sat next to the context figure it read as "the slider that
          // controls context". It only changes the display size.
          h('span', {
            key: 'zoom',
            className: 'aw-zoom',
            title: `内容缩放 ${Math.round(zoom * 100)}%（只改变显示大小，不影响会话）`,
          }, [
            h('span', { key: 'k', className: 'aw-zoom-k' }, T.zoom),
            h('input', {
              key: 'r',
              type: 'range',
              className: 'aw-zoom-range',
              min: 0,
              max: ZOOM_LADDER.length - 1,
              step: 1,
              value: zoomIdx,
              'aria-label': `内容缩放，当前 ${Math.round(zoom * 100)}%`,
              onChange: ev => applyZoom(ZOOM_LADDER[Number(ev.target.value)] ?? 1),
            }),
            h('span', { key: 'v', className: 'aw-zoom-val' }, `${Math.round(zoom * 100)}%`),
          ]),
          h('span', { key: 'sp', className: 'aw-grow' }),
          // data-tip instead of title: the native tooltip waits ~1s, and this is
          // the number people hover most often.
          h('span', { key: 'm', className: 'ctx tip-r', 'data-tip': contextHint(session, th) }, [
            h('span', { key: 'k', className: 'ctxk' }, '上下文占用'),
            h('span', { key: 'v', className: 'ctxv' }, pct(session.ratio)),
          ]),
          risk ? h('span', {
            key: 'rk',
            className: `aw-risk ${risk} tip-r`,
            'data-tip': session.firstApproach
              ? `首次接近临界线（压缩点 × ${Math.round((th?.criticalFactor ?? DEFAULT_FACTORS.criticalFactor) * 100)}%）：还没有压缩过，历史完整可用；建议收尾当前这一步后观察`
              : risk === 'crit'
                ? `已到临界线，建议交接${typeof session.compactions === 'number' && session.compactions > 0
                  ? `（已压缩 ${session.compactions} 次，细节损失叠加）` : ''}`
                : `接近压缩点（压缩点 × ${Math.round((th?.warnFactor ?? DEFAULT_FACTORS.warnFactor) * 100)}%）${typeof session.compactions === 'number' && session.compactions > 0
                  ? `，已压缩 ${session.compactions} 次` : ''}：再增长一段就会触发自动压缩`,
          }, risk === 'crit' ? T.levelCrit : T.levelWarn) : null,
          h('button', {
            key: 'open',
            className: 'aw-btn ghost',
            style: { height: 22, padding: '0 8px' },
            title: T.openNative,
            onClick: () => onOpenNative(id),
          }, [h(Icon, { key: 'i', name: 'enter', size: 13 }), T.enter]),
          total > 1 ? h('button', {
            key: 'x',
            className: 'x',
            title: T.closePane,
            onClick: () => onClose(index),
          }, h(Icon, { name: 'close', size: 13 })) : null,
        ].filter(Boolean)),

        h('div', { key: 'b', className: 'aw-pane-b' }, [
          !canRender
            ? h('div', { key: 'nc', className: 'aw-pane-fallback' }, [
              h('div', { key: 'a' }, '当前 DSH 版本没有向插件面板注入会话渲染入口'),
              h('div', { key: 'b', className: 'sub' },
                'fallback 生效：可以点「进入」在原生界面查看该会话'),
            ])
            : retainError
              ? h('div', { key: 're', className: 'aw-pane-fallback' },
                `会话引用失败：${retainError.message ?? retainError}`)
              : reference && ready
                ? h('div', {
                  key: 'box',
                  className: 'aw-zoombox',
                  'data-zoom': zoom,
                }, h('div', {
                  className: 'aw-zoom-inner',
                  style: scaled ? {
                    width: `${(100 / zoom).toFixed(2)}%`,
                    height: `${(100 / zoom).toFixed(2)}%`,
                    transform: `scale(${zoom})`,
                    transformOrigin: '0 0',
                  } : { width: '100%', height: '100%' },
                }, h(SessionProvider, { session: reference },
                  h('div', { className: 'aw-native', 'data-native': id },
                    renderFactorySlot('conversation.content', {
                      variant: 'embedded',
                      phase,
                      hero: phase === 'hero',
                    })))))
                : h('div', { key: 'w', className: 'aw-pane-fallback' }, '正在接管会话…'),
        ]),
      ])
    }

    const MAX_PANES = 4
    /**
     * First-run layout: the full 2×2 grid with every cell empty.
     *
     * The panel's job on entry is to let you choose; auto-opening a session
     * also made "four empty cells" unreachable, because any all-empty row was
     * immediately snapped back to a filled one.
     */
    const EMPTY_PANES = [null, null]

    function WorkspaceView({
      sessions, allSessions, projects, filter, setFilter, panes, setPanes, onOpenNative, railW, onRailW, kit, th, flashId,
    }) {
      // Pane pruning must judge against EVERY live session, not the filtered
      // view: pruning on the filtered list would close a pane whenever its
      // session merely fell outside the current search/scope.
      const knownSessions = allSessions ?? sessions
      const openIds = new Set(panes.filter(Boolean))
      const full = panes.length >= MAX_PANES

      // Split ratios live in (0,1); the grid turns them into `fr` tracks so both
      // sides stay proportional when the window or the rail resizes.
      const [col, setCol] = React.useState(() => {
        try {
          const v = Number(localStorage.getItem('aw.splitCol'))
          return v > 0.1 && v < 0.9 ? v : 0.5
        } catch { return 0.5 }
      })
      const [rowRatio, setRowRatio] = React.useState(() => {
        try {
          const v = Number(localStorage.getItem('aw.splitRow'))
          return v > 0.1 && v < 0.9 ? v : 0.5
        } catch { return 0.5 }
      })
      const gridRef = React.useRef(null)

      /** Drag one axis; ratio is measured against the grid box, clamped. */
      const startDrag = axis => ev => {
        ev.preventDefault()
        const box = gridRef.current
        if (!box) return
        const rect = box.getBoundingClientRect()
        const move = e => {
          const raw = axis === 'col'
            ? (e.clientX - rect.left) / rect.width
            : (e.clientY - rect.top) / rect.height
          const next = Math.min(0.85, Math.max(0.15, raw))
          if (axis === 'col') {
            setCol(next)
            try { localStorage.setItem('aw.splitCol', String(next)) } catch { /* ignore */ }
          } else {
            setRowRatio(next)
            try { localStorage.setItem('aw.splitRow', String(next)) } catch { /* ignore */ }
          }
        }
        const up = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up, { once: true })
      }

      // `twoCols` adds the vertical divider, `twoRows` the horizontal one, so
      // 3–4 panes are a grid and 1–2 panes a single row.
      const twoCols = panes.length > 1
      const twoRows = panes.length > 2
      // 3 panes: the third spans the full bottom row. 4 panes: a plain 2x2.
      const areaOf = i => {
        if (i === 0) return '1 / 1 / 2 / 2'
        if (i === 1) return '1 / 3 / 2 / 4'
        if (i === 2) return panes.length === 3 ? '3 / 1 / 4 / 4' : '3 / 1 / 4 / 2'
        return '3 / 3 / 4 / 4'
      }

      // Subagents are folded under their nearest main session by default: a
      // flat list of 42 rows (24 of them children) buries the sessions you
      // actually start. Expanded state is per main session.
      const byId = new Map(sessions.map(s => [s.id, s]))
      const mainIds = new Set(sessions.filter(s => s.origin !== 'subagent').map(s => s.id))
      const ownerCache = new Map()
      const ownerOf = sub => {
        if (ownerCache.has(sub.id)) return ownerCache.get(sub.id)
        let cur = sub.parentId
        let owner = null
        for (let guard = 0; cur && guard < 24; guard += 1) {
          if (mainIds.has(cur)) { owner = cur; break }
          cur = byId.get(cur)?.parentId ?? null
        }
        ownerCache.set(sub.id, owner)
        return owner
      }

      const kidsOf = new Map()
      const groups = []
      const byProject = new Map()
      for (const s of sessions) {
        const nested = s.origin === 'subagent' && ownerOf(s)
        if (nested) {
          const owner = ownerOf(s)
          if (!kidsOf.has(owner)) kidsOf.set(owner, [])
          kidsOf.get(owner).push(s)
          continue
        }
        let g = byProject.get(s.project)
        if (!g) { g = { name: s.project, rows: [] }; byProject.set(s.project, g); groups.push(g) }
        g.rows.push(s)
      }
      for (const arr of kidsOf.values()) arr.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

      // Which main sessions have their subagents unfolded. Persisted, because
      // a collapsed tree that re-collapses on every visit is a small annoyance
      // that adds up when you check the same session ten times an hour.
      //
      // Sort mode sits next to it: a preference, not a filter — it survives
      // reloads and never hides a session.
      const [sort, setSort] = usePersisted('aw.sort', 'ratio',
        v => v === 'ratio' || v === 'recent' || v === 'cost')
      const [expandedIds, setExpandedIds] = usePersisted(
        'aw.expanded', [],
        v => Array.isArray(v) && v.every(x => typeof x === 'string'),
      )

      // One comparator drives both levels, so a subagent list is never in a
      // different order than the list it sits in.
      const order = {
        ratio: (a, b) => (b.ratio ?? -1) - (a.ratio ?? -1),
        recent: (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
        cost: (a, b) => (b.costCny ?? -1) - (a.costCny ?? -1),
      }[sort]
      for (const g of groups) g.rows.sort(order)
      for (const arr of kidsOf.values()) arr.sort(order)

      // Panes are persisted by id, so a session deleted in another window
      // leaves a slot that can never resolve and sits on "pick a session"
      // forever. Clear those ids once the list has loaded; never prune while
      // the list is empty (that is a failed poll, not an empty workspace).
      React.useEffect(() => {
        if (!knownSessions.length) return
        const known = new Set(knownSessions.map(s => s.id))
        setPanes(prev => {
          const next = prev.map(v => (v && !known.has(v) ? null : v))
          return next.some((v, i) => v !== prev[i]) ? next : prev
        })
      }, [knownSessions, setPanes])
      const expanded = React.useMemo(() => new Set(expandedIds), [expandedIds])
      // A subagent opened in a pane must be visible even while collapsed.
      const forced = new Set()
      for (const id of openIds) {
        const s = byId.get(id)
        if (s && s.origin === 'subagent') {
          const owner = ownerOf(s)
          if (owner) forced.add(owner)
        }
      }
      const isExpanded = id => expanded.has(id) || forced.has(id)
      const toggle = id => setExpandedIds(prev => (prev.includes(id)
        ? prev.filter(x => x !== id)
        : [...prev, id]))

      // Drag the divider: pointer capture keeps the drag alive outside the
      // grip, and the width is persisted so the layout survives a reload.
      const dragRef = React.useRef(null)
      const [dragging, setDragging] = React.useState(false)

      const onPointerDown = ev => {
        ev.preventDefault()
        dragRef.current = { startX: ev.clientX, startW: railW }
        setDragging(true)
        ev.currentTarget.setPointerCapture?.(ev.pointerId)
      }
      const onPointerMove = ev => {
        const d = dragRef.current
        if (!d) return
        const next = Math.max(200, Math.min(560, d.startW + (ev.clientX - d.startX)))
        onRailW(next)
      }
      const onPointerUp = ev => {
        if (!dragRef.current) return
        dragRef.current = null
        setDragging(false)
        ev.currentTarget.releasePointerCapture?.(ev.pointerId)
      }

      return h('div', { className: 'aw-ws', style: { '--aw-rail': `${railW}px` } }, [
        h('aside', { className: 'aw-rail', key: 'rail' }, [
          h('div', { className: 'aw-rail-h', key: 'h' }, [
            h('div', { className: 'aw-field', key: 's' }, [
              h(Icon, { key: 'i', name: 'search', size: 14 }),
              h('input', {
                key: 'in',
                value: filter.query,
                placeholder: T.search,
                onChange: ev => setFilter({ ...filter, query: ev.target.value }),
              }),
              h('button', {
                key: 'so',
                className: 'aw-sort',
                type: 'button',
                title: `排序：${sortLabel(sort)}（点击换一种）`,
                onClick: () => {
                  const at = SORT.findIndex(x => x[0] === sort)
                  setSort(SORT[(at + 1) % SORT.length][0])
                },
              }, sortLabel(sort)),
            ]),
            h('div', { className: 'aw-chips', key: 'c' }, [
              h('button', {
                key: '__all',
                className: 'aw-chip',
                'aria-pressed': filter.project === '__all',
                onClick: () => setFilter({ ...filter, project: '__all' }),
              }, [h('span', { key: 't' }, T.all), h('span', { key: 'n', className: 'n' }, sessions.length)]),
              projects.map(p => h('button', {
                key: p.title || '__ungrouped',
                className: 'aw-chip',
                title: p.title ? undefined : '这些会话的目录不属于任何工作空间',
                'aria-pressed': filter.project === p.title,
                onClick: () => setFilter({ ...filter, project: p.title }),
              }, [h('span', { key: 't' }, projName(p.title)),
                h('span', { key: 'n', className: 'n' }, p.count)])),
            ]),
          ]),
          h('div', { className: 'aw-rail-list', key: 'l' },
            groups.length ? groups.map(g => h('div', { key: g.name }, [
              h('div', { key: 'g', className: 'aw-rg' }, [
                h('span', { key: 't' }, projName(g.name)),
                h('span', { key: 'l', className: 'line' }),
                h('span', { key: 'c' }, g.rows.length),
              ]),
              g.rows.map(s => {
                const kids = kidsOf.get(s.id) ?? []
                const open = isExpanded(s.id)
                const row = (item, depth) => h('div', {
                  key: item.id,
                  className: `aw-ri${depth ? ' aw-ri-sub' : ''}`,
                  'data-id': item.id,
                  role: 'button',
                  tabIndex: 0,
                  'aria-current': openIds.has(item.id),
                  title: item.title,
                  onKeyDown: ev => {
                    if (ev.key !== 'Enter' && ev.key !== ' ') return
                    ev.preventDefault()
                    ev.currentTarget.click()
                  },
                  onClick: () => {
                    if (openIds.has(item.id)) return
                    setPanes(prev => {
                      const idx = prev.findIndex(p => p === null || p === undefined)
                      const next = [...prev]
                      if (idx >= 0) next[idx] = item.id
                      else next[next.length - 1] = item.id
                      return next
                    })
                  },
                }, [
                  h('span', { key: 'd', className: 'st', style: { background: levelOf(item) } }),
                  h('span', { key: 'b', className: 'body' }, [
                    h('span', { key: 'l1', className: 'l1' }, [
                      item.origin === 'subagent' ? h(Icon, { key: 'i', name: 'sub', size: 11 }) : null,
                      h('span', { key: 't', className: 't' }, item.title),
                    ].filter(Boolean)),
                    h('span', { key: 'l2', className: 'l2' }, [
                      h('span', { key: 'm', style: { flex: '0 0 auto' } },
                        modelLabel(item.model)),
                      h('span', { key: 'bar', className: 'bar' },
                        h('i', {
                          style: {
                            width: `${Math.min(100, (item.ratio ?? 0) * 100)}%`,
                            background: levelOf(item),
                          },
                        })),
                    ]),
                  ]),
                  h('span', { key: 'p', className: 'pc' }, pct(item.ratio)),
                ])

                return h('div', { key: s.id, className: 'aw-rnode' }, [
                  row(s, 0),
                  kids.length ? h('button', {
                    key: 'tg',
                    className: 'aw-rtoggle',
                    'aria-expanded': open,
                    title: open ? '折叠子代理' : '展开子代理',
                    onClick: ev => { ev.stopPropagation(); toggle(s.id) },
                  }, [
                    h('span', { key: 'c', className: `caret${open ? ' open' : ''}` }),
                    `${kids.length} 个子代理`,
                  ]) : null,
                  open ? kids.map(k => row(k, 1)) : null,
                ].filter(Boolean))
              }),
            ])) : h('div', { key: 'e', className: 'aw-empty' }, T.noSession)),
        ]),

        h('button', {
          key: 'grip',
          className: 'aw-grip',
          'data-drag': dragging ? '' : undefined,
          'aria-label': '调整列表宽度',
          title: '拖动调整列表宽度',
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
        }),

        h('div', { className: 'aw-pane-wrap', key: 'wrap' }, [
          h('div', { className: 'aw-toolbar', key: 'tb' }, [
            h('span', { key: 'l', className: 'aw-muted' },
              `${panes.filter(Boolean).length} / ${panes.length} 栏`),
            h('div', { className: 'aw-grow', key: 'g' }),
            h('button', {
              key: 'add',
              className: 'aw-btn',
              disabled: full,
              title: full ? `最多 ${MAX_PANES} 栏` : '增加一栏',
              onClick: () => setPanes(prev => (prev.length >= MAX_PANES ? prev : [...prev, null])),
            }, [h(Icon, { key: 'i', name: 'plus', size: 14 }), T.newPane]),
            panes.length > 1 ? h('button', {
              key: 'rm',
              className: 'aw-btn ghost',
              title: '减少一栏',
              onClick: () => setPanes(prev => (prev.length > 1 ? prev.slice(0, -1) : prev)),
            }, [
              h(Icon, { key: 'i', name: 'single', size: 14 }),
              h('span', { key: 't' }, '减少一栏'),
            ]) : null,
          ].filter(Boolean)),
          h('div', {
            className: 'aw-panes',
            key: 'panes',
            ref: gridRef,
            'data-n': panes.length,
            style: {
              gridTemplateColumns: twoCols ? `${col}fr 5px ${1 - col}fr` : '1fr',
              gridTemplateRows: twoRows ? `${rowRatio}fr 5px ${1 - rowRatio}fr` : '1fr',
            },
          }, [
            ...panes.map((id, i) => {
              const session = sessions.find(s => s.id === id) ?? null
              return h('div', {
                key: `slot${i}`,
                className: 'aw-pane-slot',
                style: { gridArea: areaOf(i) },
              }, session
                ? h(NativePane, {
                  // Keyed by session, not by slot: retain/release follows the
                  // session, and switching the session in a pane must rebind.
                  key: id,
                  session,
                  kit,
                  th,
                  flash: flashId === id,
                  index: i,
                  total: panes.length,
                  onOpenNative,
                  onClose: idx => setPanes(prev => {
                    const next = prev.filter((_, j) => j !== idx)
                    return next.length ? next : [null]
                  }),
                })
                : h('div', { className: 'aw-pane' }, [
                  h('div', { className: 'aw-veil', key: 'v' }, [
                    h(Icon, { key: 'i', name: 'chat', size: 22 }),
                    h('div', { key: 't', className: 'big' }, T.pickSession),
                    h('div', { key: 'h' }, T.pickSessionHint),
                  ]),
                ]))
            }),
            twoCols ? h('div', {
              key: 'vsplit',
              className: 'aw-split',
              'data-split': 'col',
              title: '拖动调整左右宽度',
              onPointerDown: startDrag('col'),
              style: { gridColumn: '2', gridRow: '1 / -1' },
            }) : null,
            twoRows ? h('div', {
              key: 'hsplit',
              className: 'aw-split',
              'data-split': 'row',
              title: '拖动调整上下高度',
              onPointerDown: startDrag('row'),
              style: { gridRow: '2', gridColumn: '1 / -1' },
            }) : null,
          ]),
        ]),
      ])
    }

    /* ══════════════════ handoff ══════════════════ */

    /** File-name stamp for a handoff: 20261117-0145 (local time). */
    function handoffStamp(when) {
      const pad = n => String(n).padStart(2, '0')
      return `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`
        + `-${pad(when.getHours())}${pad(when.getMinutes())}`
    }

    /**
     * How far this session is from the point where DSH rewrites its history.
     * @param session - wire DTO.
     * @returns one line of plain text.
     */
    function distanceText(session) {
      const point = compactPoint(session)
      if (!point || session.ratio == null) return '缺少上下文数据'
      const left = Math.round((point.ratio - session.ratio) * session.contextWindow)
      return left >= 0
        ? `距压缩点 ${fmt(left)} tokens`
        : `已越过压缩点 ${fmt(-left)} tokens`
    }

    /**
     * Copy text with two fallbacks.
     *
     * A clipboard write can be refused by the shell's permission handler, and a
     * button that appears to do nothing is worse than no button at all. The last
     * resort leaves the text selected and tells the user to press Ctrl+C.
     * @param text - what to put on the clipboard.
     * @returns `'clipboard' | 'exec' | 'manual'`.
     */
    async function copyToClipboard(text) {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text)
          return 'clipboard'
        }
      } catch { /* fall through */ }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand?.('copy')
        document.body.removeChild(area)
        if (ok) return 'exec'
      } catch { /* fall through */ }
      return 'manual'
    }

    /**
     * The handoff dialog: why, how, which session, and the prompt itself.
     *
     * Deliberately does nothing but copy. It never sends a message, never opens
     * a session, never touches a file — the old agent does the work after the
     * user pastes the prompt, and the user stays in control of every step.
     * @param props - sessions, preset id, pane ids, thresholds, close/copied.
     */
    /**
     * Last line of defence.
     *
     * A throw inside one component took the whole main slot down with
     * `SlotAssemblyError` — the user saw a blank area and no way back. A
     * boundary turns that into a small retry card; the rest of the app keeps
     * running.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) { return { error } }

      componentDidCatch(error) { console.error('dsh-session-matrix: render failed', error) }

      render() {
        if (!this.state.error) return this.props.children
        return h('div', { className: 'aw-err', key: 'b', style: { margin: 16 } }, [
          h('div', { key: 'a' }, '这一块渲染失败了，其他面板不受影响'),
          h('code', { key: 'b' }, String(this.state.error?.message ?? this.state.error)),
          h('div', { key: 'c', className: 'row' }, [
            h('button', {
              key: 'r',
              className: 'aw-btn',
              type: 'button',
              onClick: () => this.setState({ error: null }),
            }, '重试'),
          ]),
        ])
      }
    }

    function HandoffModal({ sessions, preset, paneIds, th, onClose, onCopied }) {
      const ranked = React.useMemo(
        () => [...sessions].sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1)),
        [sessions],
      )
      const top = ranked.slice(0, 3)
      const [targetId, setTargetId] = React.useState(() => preset || top[0]?.id || null)
      const [raw, setRaw] = React.useState(null)
      const [meta, setMeta] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [text, setText] = React.useState('')
      const [hint, setHint] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const edited = React.useRef(false)
      const areaRef = React.useRef(null)
      const target = sessions.find(s => s.id === targetId) ?? null
      const mark = target ? compactPoint(target) : null
      const warnAt = mark ? mark.ratio * th.warnFactor : null
      const critAt = mark ? mark.ratio * th.criticalFactor : null

      // Fetch at open time, so an edited prompt file takes effect without a
      // rebuild of the browser half.
      React.useEffect(() => {
        let alive = true
        fetch('/api/session-matrix/handoff', { credentials: 'same-origin' })
          .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
          .then(json => {
            if (!alive) return
            setRaw(json.text)
            setMeta(json)
          })
          .catch(err => { if (alive) setError(String(err?.message ?? err)) })
        return () => { alive = false }
      }, [])

      const rendered = React.useMemo(() => {
        if (!raw) return ''
        const when = new Date()
        return raw
          .replaceAll('{{SESSION_TITLE}}', target?.title ?? '')
          .replaceAll('{{HANDOFF_ID}}', handoffStamp(when))
          .replaceAll('{{DATE}}', when.toLocaleString('zh-CN', { hour12: false }))
      }, [raw, target])

      React.useEffect(() => {
        edited.current = false
        setText(rendered)
      }, [rendered])

      React.useEffect(() => {
        const onKey = ev => { if (ev.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const commit = async () => {
        if (busy || !text.trim()) return
        setBusy(true)
        const how = await copyToClipboard(text)
        setBusy(false)
        if (how === 'manual') {
          setHint('剪贴板不可用：文本已全选，按 Ctrl+C 复制')
          const area = areaRef.current
          if (area) { area.focus(); area.select() }
          return
        }
        onCopied(targetId)
      }

      const card = s => {
        const point = compactPoint(s)
        const risk = s.risk === 'crit' ? 'var(--dsw-alias-state-error-primary)'
          : s.risk === 'warn' ? 'var(--dsw-alias-state-warn-primary)'
            : 'var(--dsw-alias-label-tertiary)'
        const used = Math.min(100, (s.ratio ?? 0) * 100)
        const at = point ? Math.min(100, point.ratio * 100) : null
        return h('button', {
          key: s.id,
          className: 'aw-hcard',
          type: 'button',
          'aria-pressed': s.id === targetId,
          title: contextHint(s, th),
          onClick: () => setTargetId(s.id),
        }, [
          h('span', { key: 'h', className: 'aw-hcard-h' }, [
            h('span', { key: 't', className: 't' }, s.title || T.noTitle),
            paneIds.includes(s.id) ? h('span', { key: 'g', className: 'tag' }, '已载入') : null,
            s.firstApproach ? h('span', { key: 'fa', className: 'tag' }, '首次接近 · 未压缩') : null,
            typeof s.compactions === 'number' && s.compactions > 0
              ? h('span', { key: 'k', className: 'tag' }, `已压缩 ${s.compactions} 次`)
              : null,
          ].filter(Boolean)),
          // One bar, two facts: how full it is, and where DSH would compact.
          h('span', { key: 'bar', className: 'aw-hcard-bar' }, [
            h('i', { key: 'f', style: { width: `${used}%`, background: risk } }),
            at == null ? null : h('em', { key: 't', style: { left: `${at}%` } }),
          ].filter(Boolean)),
          h('span', { key: 'r', className: 'aw-hcard-r' }, [
            h('span', { key: 'u', style: { color: risk } }, `已用 ${pct(s.ratio)}`),
            h('span', { key: 'c' }, point ? `压缩点 ${pct(point.ratio)}` : '压缩点未知'),
          ]),
          h('span', { key: 'd', className: 'd' }, distanceText(s)),
        ])
      }

      return h('div', {
        className: 'aw-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '通用交接提示词',
        onMouseDown: ev => { if (ev.target === ev.currentTarget) onClose() },
      }, h('div', { className: 'aw-modal-c' }, [
        h('div', { className: 'aw-modal-h', key: 'h' }, [
          h(Icon, { key: 'i', name: 'handoff', size: 15 }),
          h('h2', { key: 't' }, T.handoffTitle),
          meta ? h('span', { key: 'v', className: 'aw-ver' }, `协议 ${meta.version} · ${meta.hash}`) : null,
          h('button', {
            key: 'x', className: 'x', type: 'button', title: '关闭', onClick: onClose,
          }, h(Icon, { name: 'close', size: 13 })),
        ]),
        h('div', { className: 'aw-modal-b', key: 'b' }, [
          h('div', { className: 'aw-modal-l', key: 'l' }, [
            h('p', { className: 'aw-hsec', key: 'w1' }, T.whyTitle),
            h('div', { className: 'aw-hp', key: 'w2' }, [
              h('div', { key: 'a' },
                'Agent 干活的时候，上下文会被不断压缩：早期对话换成摘要，路径、命令、报错最先丢。'
                + '压缩了多少次，面板已经帮你数出来了——就是卡片上的「已压缩 N 次」。'),
              h('div', { key: 'b' },
                '我们调研了 Claude Code 社区的经验：同一个会话压缩到第 2 次，'
                + '就说明任务已经超过一个会话该装的量；压到 3 次以上，模型开始忘掉早期的要求和约束，'
                + '硬撑下去会越做越差，甚至反复返工。'),
              h('div', { key: 'c' },
                '所以面板的提示是两条线一起看的：占用率到临界线 = 该收尾当前这一步；'
                + '压缩过 2 次以上再到临界 = 该交接了，开个新会话接着干。'),
              h('div', { key: 'd' },
                '从没压缩过的新会话第一次到临界线不用慌——历史还完整，继续干活就行。'
                + '刚压缩完 10 分钟内摘要最新鲜，提示也会自动放宽。'),
            ]),
            // The three lines the panel paints, computed for the session that is
            // about to receive the prompt — a different model means different
            // numbers, and a hard-coded table would be wrong for half of them.
            h('div', { className: 'aw-tbl', key: 'tbl' }, [
              h('div', { key: 'h', className: 'aw-tbl-h' }, [
                h('span', { key: 'a' }, '阈值'),
                h('span', { key: 'b' }, '含义'),
              ]),
              h('div', { key: 'w', className: 'aw-tbl-r' }, [
                h('span', { key: 'a', className: 'n' }, warnAt ? pct(warnAt) : '压缩点 × 80%'),
                h('span', { key: 'b' }, '标「注意」，还能撑一次较长的回复'),
              ]),
              h('div', { key: 'c', className: 'aw-tbl-r' }, [
                h('span', { key: 'a', className: 'n' }, critAt ? pct(critAt) : '压缩点 × 92%'),
                h('span', { key: 'b' }, '标「临界」，下一次大请求就可能触发压缩'),
              ]),
              h('div', { key: 'p', className: 'aw-tbl-r' }, [
                h('span', { key: 'a', className: 'n' }, mark ? pct(mark.ratio) : '压缩点'),
                h('span', { key: 'b' }, 'DSH 开始把早期对话替换成摘要'),
              ]),
            ]),
            h('div', { className: 'aw-tbl-note', key: 'tn' },
              mark
                ? `按《${target?.title || T.noTitle}》的模型算（${fmt(target?.contextWindow)} 窗口 / `
                  + `${fmt(target?.maxOutputTokens)} 输出预留），换模型数值会变`
                : '这些比例固定，具体数值随模型的窗口和输出预留变化'),
            h('div', { className: 'aw-hp aw-hp-strong', key: 'w3' }, [
              h('div', { key: 'a' },
                h('b', { key: 'b' },
                  '压缩之后，早期的对话只剩摘要，路径、命令、报错这些细节一般留不下来。'
                  + '接手的人要接着做，只能重新找。')),
              h('div', { key: 'b' },
                h('b', { key: 'b' },
                  '交接是在压缩之前，把目标、进度、关键文件、已否决的方案写成文件，'
                  + '新会话读文件接着做。')),
            ]),
            h('p', { className: 'aw-hsec', key: 'o1' }, [
              T.targetTitle,
              h('span', { key: 's', className: 'aw-hsec-sub' }, '离压缩线最近的会话'),
            ]),
            top.map(card),
            ranked.length > top.length ? h('select', {
              key: 'other',
              className: 'aw-other',
              value: top.some(s => s.id === targetId) ? '' : (targetId ?? ''),
              title: '换模型、把活交给别的 Agent、或者今天收工——都可以选任意会话',
              onChange: ev => { if (ev.target.value) setTargetId(ev.target.value) },
            }, [
              h('option', { key: 'p', value: '' },
                top.some(s => s.id === targetId) ? '其他会话…' : (target?.title ?? '其他会话…')),
              ranked.filter(s => !top.includes(s)).map(s => h('option', {
                key: s.id, value: s.id,
              }, `${s.title || T.noTitle} · ${pct(s.ratio)}`)),
            ]) : null,
          ].filter(Boolean)),
          h('div', { className: 'aw-modal-r', key: 'r' }, [
            h('div', { className: 'lab', key: 'l' }, '提示词（可编辑，改完再复制）'),
            error
              ? h('div', { className: 'aw-hp', key: 'e' }, `读取提示词失败：${error}`)
              : h('textarea', {
                key: 't',
                ref: areaRef,
                value: text,
                spellCheck: false,
                'aria-label': '交接提示词',
                onChange: ev => { edited.current = true; setText(ev.target.value) },
              }),
          ]),
        ]),
        h('div', { className: 'aw-modal-f', key: 'f' }, [
          h('div', { className: 'aw-fnote', key: 'n' }, [
            h('div', { key: 'a' }, hint || T.handoffNote),
            hint ? null : h('div', { key: 'b', className: 'sub' },
              '复制 → 回本会话发送 → 它给出接管消息 → 新会话粘贴'),
          ].filter(Boolean)),
          h('button', { key: 'c', className: 'aw-btn ghost', type: 'button', onClick: onClose }, '关闭'),
          h('button', {
            key: 'p',
            className: 'aw-btn primary',
            type: 'button',
            disabled: busy || !text.trim(),
            onClick: commit,
          }, busy ? '复制中…' : '复制'),
        ]),
      ]))
    }

    /* ══════════════════ workbench shell ══════════════════ */

    /**
     * State that has to survive the panel being unmounted.
     *
     * DSH unmounts a panel when you switch to another one, so plain `useState`
     * drops the active view and the selected node — which is why coming back
     * from anywhere reset the cockpit to the workspace with nothing selected.
     * localStorage is per machine, already used for panes / rail width / zoom.
     * @param key - storage key.
     * @param initial - value (or factory) when nothing usable is stored.
     * @param valid - predicate that rejects stale or hand-edited values.
     * @returns `[value, setValue]`, same shape as `useState`.
     */
    function usePersisted(key, initial, valid) {
      const [value, setValue] = React.useState(() => {
        try {
          const raw = localStorage.getItem(key)
          if (raw != null) {
            const parsed = JSON.parse(raw)
            if (!valid || valid(parsed)) return parsed
          }
        } catch { /* private mode, or a value written by an older build */ }
        return typeof initial === 'function' ? initial() : initial
      })
      const live = React.useRef(value)
      live.current = value
      const set = React.useCallback(next => {
        const resolved = typeof next === 'function' ? next(live.current) : next
        live.current = resolved
        setValue(resolved)
        try { localStorage.setItem(key, JSON.stringify(resolved)) } catch { /* private mode */ }
      }, [key])
      return [value, set]
    }

    const isView = v => v === 'workspace' || v === 'cockpit'
    const isFilter = v => Boolean(v) && typeof v.project === 'string' && typeof v.query === 'string'
    const isSelected = v => v === null || typeof v === 'string'

    function Workbench(kit) {
      // The shell themes itself by swapping CSS variables, not by a class we can
      // read. Sampling the background colour is the one signal that works for
      // every skin, and the observer catches a live theme switch.
      const [theme, setTheme] = React.useState('dark')
      React.useEffect(() => {
        /** @returns `[r, g, b]` from `#rrggbb` or `rgb()`/`rgba()`, else null. */
        const parseColor = raw => {
          const text = String(raw ?? '').trim()
          const hex = /^#([0-9a-f]{6})$/i.exec(text)
          if (hex) {
            const n = parseInt(hex[1], 16)
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
          }
          const m = /(\d{1,3})\D+(\d{1,3})\D+(\d{1,3})/.exec(text)
          return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
        }
        const read = () => {
          const rootStyle = getComputedStyle(document.documentElement)
          const bodyStyle = getComputedStyle(document.body)
          // The token may live on :root or on the app shell, and a third-party
          // skin may only paint the body background — try all three.
          const rgb = parseColor(rootStyle.getPropertyValue('--dsw-alias-bg-base'))
            ?? parseColor(bodyStyle.getPropertyValue('--dsw-alias-bg-base'))
            ?? parseColor(bodyStyle.backgroundColor)
          if (!rgb) return
          const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255
          setTheme(lum > 0.55 ? 'light' : 'dark')
        }
        read()
        const observer = new MutationObserver(read)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
        return () => observer.disconnect()
      }, [])

      const [data, setData] = React.useState(null)
      // 三个底部模块（构成/概览/详情）的列宽比例，可拖拽分隔条调整
      const [botCols, setBotCols] = usePersisted('aw.botCols', [1, 1.25, 1.15],
        v => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && x >= 0.12 && x <= 6))
      const botDrag = React.useRef(null)
      const botHandleDown = (i) => (ev) => {
        const total = (ev.currentTarget.parentElement?.getBoundingClientRect().width) || 1
        botDrag.current = { i, startX: ev.clientX, cols: [...botCols], total }
        ev.currentTarget.setPointerCapture(ev.pointerId)
        ev.preventDefault()
      }
      const botHandleMove = (ev) => {
        const d = botDrag.current
        if (!d) return
        const dx = (ev.clientX - d.startX) / d.total
        const min = 0.15
        const a = Math.max(min, d.cols[d.i] + dx)
        const b = Math.max(min, d.cols[d.i + 1] - dx)
        if (a <= min || b <= min) return
        const next = [...d.cols]
        next[d.i] = a
        next[d.i + 1] = b
        setBotCols(next)
      }
      const botHandleUp = () => { botDrag.current = null }
      const [error, setError] = React.useState(null)
      // View, selection and filter are persisted: leaving the panel and coming
      // back must not restart the workbench at its first screen.
      const [view, setView] = usePersisted('aw.view', 'workspace', isView)
      const [selected, setSelected] = usePersisted('aw.selected', null, isSelected)
      const [demo, setDemo] = React.useState(false)
      const [size, setSize] = React.useState({ w: 1000, hgt: 380 })
      const [filter, setFilter] = usePersisted('aw.filter', { project: '__all', query: '' }, isFilter)
      // Panes survive leaving the panel (e.g. "进入" opens the native view, then
      // the user comes back). Without this the whole layout resets to one empty
      // pane, which reads as data loss.
      const [panes, setPanes] = React.useState(() => {
        try {
          const raw = JSON.parse(localStorage.getItem('aw.panes') || '[]')
          if (!Array.isArray(raw)) return EMPTY_PANES
          const kept = []
          for (const v of raw) {
            if (v === null) { kept.push(null); continue }
            if (typeof v !== 'string') continue
            // One session, one pane: a duplicate would retain the same session
            // twice and show the same transcript in two cells.
            if (kept.includes(v)) continue
            kept.push(v)
          }
          return kept.slice(0, MAX_PANES).length ? kept.slice(0, MAX_PANES) : EMPTY_PANES
        } catch { return EMPTY_PANES }
      })

      React.useEffect(() => {
        try { localStorage.setItem('aw.panes', JSON.stringify(panes)) } catch { /* private mode */ }
      }, [panes])
      const stageRef = React.useRef(null)
      const [tick, setTick] = React.useState(0)
      const [notice, setNotice] = React.useState(null)
      const [handoffOpen, setHandoffOpen] = React.useState(false)
      // Which pane should flash after a handoff copy. `at` makes a repeat copy
      // of the same session restart the animation instead of being ignored.
      const [flash, setFlash] = React.useState(null)
      const [railW, setRailW] = React.useState(() => {
        try {
          const v = Number(localStorage.getItem('aw.railWidth'))
          return v >= 200 && v <= 560 ? v : 288
        } catch { return 288 }
      })
      React.useEffect(() => {
        if (!notice) return undefined
        const t = setTimeout(() => setNotice(null), notice?.action ? 9000 : 5000)
        return () => clearTimeout(t)
      }, [notice])

      const setRail = React.useCallback(w => {
        setRailW(w)
        try { localStorage.setItem('aw.railWidth', String(w)) } catch { /* private mode */ }
      }, [])

      // A manual refresh used to be invisible: the payload is identical, so
      // nothing on screen moved. Track the request itself and spin the icon.
      const [busy, setBusy] = React.useState(false)
      const load = React.useCallback(async force => {
        const startedAt = Date.now()
        if (force) setBusy(true)
        try {
          const next = await fetchOverview(force)
          // The host caches for 45s, so a 15s poll usually returns the very
          // same snapshot. Keeping the previous object skips a re-render of
          // every native pane for a payload that did not change.
          setData(prev => (prev && next?.generatedAt === prev.generatedAt ? prev : next))
          setError(null)
        } catch (e) { setError(e) } finally {
          if (force) {
            // A cached overview can answer in under one frame, which would make
            // the spinner a no-op. Keep it up long enough to be seen.
            const wait = Math.max(0, 420 - (Date.now() - startedAt))
            setTimeout(() => setBusy(false), wait)
          }
        }
      }, [])

      React.useEffect(() => { load(false) }, [load])

      // Relative times ("3 分钟前") only need a slow clock; the graph layout
      // must not be rebuilt every couple of seconds.
      React.useEffect(() => {
        const id = setInterval(() => setTick(x => (x + 1) % 100000), 30_000)
        return () => clearInterval(id)
      }, [])

      // The refresh button's tooltip promises a background refresh, so there is
      // one. Paused while the window is hidden: a panel nobody is looking at
      // should not keep waking the host.
      React.useEffect(() => {
        const id = setInterval(() => { if (!document.hidden) load(false) }, 15_000)
        return () => clearInterval(id)
      }, [load])

      React.useEffect(() => {
        if (view !== 'cockpit') return undefined
        const el = stageRef.current
        if (!el) return undefined
        const measure = () => {
          const r = el.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) setSize({ w: r.width, hgt: r.height })
        }
        measure()
        if (typeof ResizeObserver === 'function') {
          const ro = new ResizeObserver(measure)
          ro.observe(el)
          return () => ro.disconnect()
        }
        window.addEventListener('resize', measure)
        return () => window.removeEventListener('resize', measure)
      }, [view])

      // Titles come from the client session store too: the native sidebar shows
      // real names even when the host half is older and still sends a
      // placeholder for every row.
      const display = React.useMemo(() => {
        if (!data) return null
        const titles = clientTitles()
        const factors = data.thresholds ?? DEFAULT_FACTORS
        const base = demo
          ? data.sessions.map(s => {
            if (s.ratio == null) return s
            const r = Math.min(0.995, s.ratio * 3.2 + 0.02)
            return { ...s, ratio: r }
          })
          : data.sessions
        // A session created but never used is a stub, not a conversation — the
        // native sidebar does not list it either. The host filters these too,
        // but the client must not depend on the host half having been reloaded
        // (it is a long-lived module: an old build keeps sending stubs).
        const real = base.filter(s => !(s.blank === true && (s.turns ?? 0) === 0))
        const kept = new Set(real.map(s => s.project))
        // Rebuild the chip counts from the sessions that survived, so a project
        // that only ever held a stub disappears instead of showing "… 1".
        const byProject = new Map()
        for (const s of real) byProject.set(s.project, (byProject.get(s.project) ?? 0) + 1)
        const projects = data.projects
          .filter(p => kept.has(p.title))
          .map(p => ({ ...p, count: byProject.get(p.title) ?? p.count }))
        return {
          ...data,
          projects,
          // Risk is recomputed here, not trusted from the wire: the thresholds
          // are derived per session from its own compaction point, so a host
          // half that still ships flat 70/85 numbers cannot mis-colour a pane.
          sessions: real.map(s => ({
            ...s, title: titleOf(s, titles), risk: riskOf(s, factors),
          })),
        }
      }, [data, demo])

      const sessions = display?.sessions ?? []
      const projects = display?.projects ?? []
      // Threshold *factors*: the absolute percentage is per session, because
      // the compaction point depends on that session's own window and output
      // reservation.
      const th = display?.thresholds ?? DEFAULT_FACTORS
      const pricing = display?.pricing ?? null

      // Open the busiest session on first load, and drop pane ids that no
      // longer exist (deleted or archived session) instead of leaving a pane
      // stuck on "从左侧选择一个会话" that can never be filled.
      React.useEffect(() => {
        if (!sessions.length) return
        const ids = new Set(sessions.map(s => s.id))
        setPanes(prev => {
          const pruned = prev.map(id => (id && ids.has(id) ? id : null))
          // An all-empty row is a legitimate state now: the user walks in,
          // sees the grid, and picks. Auto-filling the busiest session made
          // "four empty cells" unreachable — adding panes always snapped the
          // first one to a session.
          const same = pruned.length === prev.length && pruned.every((v, i) => v === prev[i])
          return same ? prev : pruned
        })
      }, [sessions, setPanes])

      const graph = React.useMemo(
        () => (display ? computeGraph(display, filter, size.w, size.hgt) : null),
        [display, filter, size],
      )

      // A saved filter can name a project that no longer exists (renamed
      // workspace, sessions deleted). Reset instead of showing an empty list
      // with no highlighted chip to click off.
      React.useEffect(() => {
        if (!display || filter.project === '__all') return
        if (projects.some(p => p.title === filter.project)) return
        setFilter(prev => ({ ...prev, project: '__all' }))
      }, [display, projects, filter.project, setFilter])

      const selectedSession = selected ? sessions.find(s => s.id === selected) ?? null : null
      const filtered = React.useMemo(() => {
        const q = filter.query.trim().toLowerCase()
        return sessions.filter(s => (filter.project === '__all' || s.project === filter.project)
          && (!q || `${s.title} ${s.project} ${s.model ?? ''}`.toLowerCase().includes(q)))
      }, [sessions, filter])

      // What the bottom-left panel aggregates. It follows the selected node:
      // click a session and you get that session plus its subagents, click a
      // subagent and you get just it, click nothing and you get the filter.
      // (Project / hub clicks clear the selection and move the chip filter, so
      // they land on the third branch.)
      const scope = React.useMemo(() => {
        const node = selected && graph ? graph.nodeById.get(selected) : null
        if (node?.kind === 'sub' && node.session) {
          return {
            sessions: [node.session],
            label: `${T.scopePrefix} · ${T.scopeSub}：${node.session.title || T.noTitle}`,
          }
        }
        if (node?.kind === 'main' && node.session) {
          const tree = subtreeOf(node.id, sessions)
          const kids = Math.max(0, tree.length - 1)
          return {
            sessions: tree,
            label: `${T.scopePrefix} · ${node.session.title || T.noTitle}`
              + (kids ? ` 及 ${kids} 个子代理` : ''),
          }
        }
        if (filter.project !== '__all') {
          return {
            sessions: filtered,
            label: `${T.scopePrefix} · ${projName(filter.project)} · ${filtered.length} 个会话`,
          }
        }
        return { sessions: filtered, label: `${T.scopePrefix} · ${T.scopeAll} · ${filtered.length} 个` }
      }, [selected, graph, sessions, filtered, filter.project])

      const risky = sessions.filter(s => s.risk === 'warn' || s.risk === 'crit').length
      const critical = sessions.filter(s => s.risk === 'crit').length
      const active = sessions.filter(isActive).length
      const known = sessions.filter(s => s.ratio != null)
      const avg = known.length ? known.reduce((sum, s) => sum + s.ratio, 0) / known.length : null

      /**
       * After the prompt is on the clipboard: say where to paste it, and point
       * at the pane when that session happens to be on screen.
       * @param id - the session the prompt was written for.
       */
      function handoffCopied(id) {
        setHandoffOpen(false)
        const session = sessions.find(s => s.id === id)
        const title = session?.title || T.noTitle
        setFlash(id ? { id, at: Date.now() } : null)
        const slot = panes.indexOf(id)
        if (slot >= 0) {
          setNotice(`交接提示词已复制 · 请到第 ${slot + 1} 格《${title}》里粘贴发送`)
          return
        }
        // Not on screen. Say it in plain words ("not open in a pane"), because
        // "不在工作区" reads like the DSH workspace/project, which is a
        // different thing entirely.
        setNotice({
          text: `交接提示词已复制 · 《${title}》没有在窗格里打开`,
          action: {
            label: '载入窗格',
            run: () => {
              setPanes(prev => {
                const at = prev.findIndex(v => v === null)
                if (at >= 0) {
                  const next = [...prev]
                  next[at] = id
                  return next
                }
                return [...prev.slice(0, MAX_PANES - 1), id]
              })
              setView('workspace')
              setFlash({ id, at: Date.now() })
            },
          },
        })
      }

      // The flash is a three-beat animation; clear the flag once it has played.
      React.useEffect(() => {
        if (!flash) return undefined
        const timer = setTimeout(() => setFlash(null), 2600)
        return () => clearTimeout(timer)
      }, [flash])

      function openNative(id) {
        const c = window.__SESSION_MATRIX_CTX__
        const face = c && (typeof c.get === 'function' ? c.get('uiWorkspace') : c.uiWorkspace)
        try {
          if (face && typeof face.openSession === 'function') {
            face.openSession(id)
            return
          }
          // No silent failure: a click that does nothing is indistinguishable
          // from a click that worked, so say which one it was.
          setNotice('当前环境没有 uiWorkspace.openSession，无法跳转到原生会话')
        } catch (error) {
          setNotice(`打开会话失败：${error?.message ?? error}`)
        }
      }

      return h('div', { className: 'aw', 'data-theme': theme }, [
        h('style', { key: 'css' }, CSS),

        h('header', { className: 'aw-hdr', key: 'hdr' }, [
          h('div', { className: 'aw-title', key: 't' }, [
            h(Icon, { key: 'i', name: 'network', size: 16 }),
            h('span', { key: 's' }, T.product),
            h('span', { key: 'sub', className: 'aw-sub' },
              `· ${filter.project === '__all' ? T.all : projName(filter.project)}`),
          ]),
          h('div', { className: 'aw-seg', key: 'v', role: 'tablist' }, [
            h('button', {
              key: 'w',
              role: 'tab',
              'aria-selected': view === 'workspace',
              onClick: () => setView('workspace'),
            }, T.viewWorkspace),
            h('button', {
              key: 'c',
              role: 'tab',
              'aria-selected': view === 'cockpit',
              onClick: () => setView('cockpit'),
            }, T.viewCockpit),
          ]),
          h('div', { className: 'aw-grow', key: 'g' }),
          view === 'cockpit' ? h('div', { className: 'aw-field', key: 'q', style: { width: 196 } }, [
            h(Icon, { key: 'i', name: 'search', size: 14 }),
            h('input', {
              key: 'in',
              value: filter.query,
              placeholder: T.search,
              onChange: ev => setFilter({ ...filter, query: ev.target.value }),
            }),
          ]) : null,
          h('div', { className: 'aw-stat', key: 'st' }, [
            h('span', {
              key: 'a',
              title: '当前筛选下的会话数（创建后从未使用过的空壳会话不计）',
            }, [h('b', { key: 'b' }, sessions.length), ' 会话']),
            h('span', {
              key: 'b',
              className: 'opt',
              title: '最近 2 小时内有过更新的会话数；休眠会话仍会统计在左侧总数里',
            }, [h('b', { key: 'b' }, active), ' 活跃']),
            h('span', {
              key: 'c',
              className: 'opt',
              title: '所有会话上下文占用的平均值。不同模型容量不同，所以总和不会混算成一个百分比',
            }, [h('b', { key: 'b' }, pct(avg)), ' 平均占用']),
            display?.capabilities?.coldPending ? h('span', {
              key: 'e',
              title: '还有冷会话的投影没读完，下一轮刷新补齐；已读部分照常显示',
            }, [h('b', { key: 'b' }, display.capabilities.coldPending), ' 读取中']) : null,
            h('span', {
              key: 'd',
              className: risky ? 'risk' : undefined,
              title: risky
                ? `${risky} 个会话已进入提醒区：注意 = 该会话压缩点 × ${Math.round(th.warnFactor * 100)}%，`
                  + `预警 = 压缩点 × ${Math.round(th.criticalFactor * 100)}%。压缩点按各自模型容量换算，`
                  + '不是固定的 70% / 85%'
                : `没有会话进入提醒区（注意 = 压缩点 × ${Math.round(th.warnFactor * 100)}%，`
                  + `预警 = 压缩点 × ${Math.round(th.criticalFactor * 100)}%）`,
            }, risky ? `${risky} 需注意` : T.noRisk),
          ]),
          // Handoff entry. Always available, because a handoff is not only for a
          // full context: changing model, handing the work to another agent, or
          // picking it up tomorrow all need the same prompt.
          h('span', { key: 'ho', className: 'aw-hbtn' }, [
            h('button', {
              key: 'b',
              className: 'aw-btn ghost aw-handoff',
              type: 'button',
              'aria-haspopup': 'dialog',
              title: T.handoffTitle,
              onClick: () => setHandoffOpen(true),
            }, [
              h(Icon, { key: 'i', name: 'handoff', size: 14 }),
              h('span', { key: 'k', className: 'aw-hbtn-k' }, T.handoff),
            ]),
            // A dot, not a red button: a whole warning-coloured button in the
            // toolbar shouts, and this is an offer, not an alarm.
            risky ? h('span', {
              key: 'd',
              className: `aw-hbtn-dot${critical ? ' crit' : ''}`,
              title: critical
                ? `${critical} 个会话已到临界线`
                : `${risky} 个会话进入注意区`,
            }) : null,
            h('span', { key: 't', className: 'aw-tip', role: 'tooltip' }, [
              h('b', { key: 'a' }, T.handoffTitle),
              h('div', { key: 'b' }, T.handoffTip),
              h('div', { key: 'c', className: 'sub' }, T.handoffTip2),
            ]),
          ]),
          h('button', {
            key: 'rf',
            className: 'aw-btn ghost',
            title: '立即从宿主重新读取一次（跳过 45 秒缓存）。面板开着的这期间每 15 秒自动刷新，'
              + '窗口隐藏时暂停，一般不需要手动点',
            onClick: () => { if (!busy) load(true) },
            disabled: busy,
            'aria-busy': busy ? 'true' : 'false',
          }, h('span', { key: 'i', className: busy ? 'aw-rot' : undefined },
            h(Icon, { name: 'refresh', size: 14 }))),
        ].filter(Boolean)),

        // The toast floats over whatever sits at the bottom of the current
        // view: the native composer in the workspace, the three modules in the
        // cockpit. Clear both instead of covering the input box.
        notice ? h('div', {
          key: 'toast',
          className: 'aw-toast',
          role: 'status',
          // 136px clears the native composer (~120px) in the workspace; 296px
          // clears the three bottom modules in the cockpit.
          style: { bottom: view === 'cockpit' ? 296 : 136 },
        }, [
          h('span', { key: 't' }, typeof notice === 'string' ? notice : notice.text),
          notice?.action ? h('button', {
            key: 'a',
            className: 'aw-btn ghost',
            style: { height: 22, marginLeft: 10, padding: '0 8px' },
            type: 'button',
            onClick: () => { notice.action.run(); setNotice(null) },
          }, notice.action.label) : null,
        ].filter(Boolean)) : null,

        handoffOpen ? h(Boundary, { key: 'hb' }, h(HandoffModal, {
          key: 'handoff',
          sessions,
          // Preselect what the user is actually looking at: in the workspace
          // that is the pane on screen, in the cockpit it is the selected node.
          // (A stale persisted selection used to win here, so the dialog could
          // preselect a session that is nowhere on screen.)
          preset: view === 'workspace'
            ? (panes.find(Boolean) ?? selected)
            : (selected ?? panes.find(Boolean)),
          paneIds: panes.filter(Boolean),
          th,
          onClose: () => setHandoffOpen(false),
          onCopied: handoffCopied,
        })) : null,

        error ? h('div', { className: 'aw-err', key: 'err' }, [
          h('div', { key: 'a' }, T.loadFail),
          h('code', { key: 'b' }, String(error.message ?? error)),
          h('div', { key: 'c' }, T.loadFailHint),
        ]) : view === 'workspace'
          ? h(WorkspaceView, {
            key: 'ws',
            sessions: filtered,
            allSessions: sessions,
            projects,
            filter,
            setFilter,
            panes,
            setPanes,
            onOpenNative: openNative,
            railW,
            onRailW: setRail,
            kit,
            th,
            flashId: flash?.id ?? null,
          })
          : h('div', { className: 'aw-main', key: 'ck' }, [
            h('div', { className: 'aw-toolbar', key: 'tb' }, [
              h('button', {
                key: '__all',
                className: 'aw-chip',
                'aria-pressed': filter.project === '__all',
                onClick: () => setFilter({ ...filter, project: '__all' }),
              }, [h('span', { key: 't' }, T.all), h('span', { key: 'n', className: 'n' }, sessions.length)]),
              projects.map(p => h('button', {
                key: p.title || '__ungrouped',
                className: 'aw-chip',
                title: p.title ? undefined : '这些会话的目录不属于任何工作空间',
                'aria-pressed': filter.project === p.title,
                onClick: () => setFilter({ ...filter, project: p.title }),
              }, [h('span', { key: 't' }, projName(p.title)),
                h('span', { key: 'n', className: 'n' }, p.count)])),
              h('div', { className: 'aw-grow', key: 'g' }),
              h('button', {
                key: 'demo',
                className: `aw-btn${demo ? ' on' : ''}`,
                title: '把占用率放大以预览预警配色（仅影响显示）',
                onClick: () => setDemo(!demo),
              }, demo ? T.restore : T.previewRisk),
              h('div', { className: 'aw-legend', key: 'lg' }, [
                h('span', { key: 'a', title: '主会话：你自己开的会话' }, [
                  h('i', { key: 'd', className: 'aw-dot', style: { background: 'var(--dsw-alias-label-secondary)' } }),
                  T.main,
                ]),
                h('span', { key: 'b', title: '子代理会话：由主会话派生，可查看但不能直接对话' }, [
                  h('i', { key: 'd', className: 'aw-dot', style: { background: 'var(--dsw-alias-label-tertiary)' } }),
                  T.sub,
                ]),
                h('span', {
                  key: 'c',
                  title: `注意：占用达到该会话压缩点的 ${Math.round(th.warnFactor * 100)}%。`
                    + '压缩点按各自模型的窗口与输出预留换算（常见 1M 窗口约 56%–69%），'
                    + '所以这里不写死一个百分比',
                }, [
                  h('i', { key: 'd', className: 'aw-dot', style: { background: 'var(--dsw-alias-state-warn-primary)' } }),
                  T.levelWarn,
                ]),
                h('span', {
                  key: 'd',
                  title: `预警：占用达到压缩点的 ${Math.round(th.criticalFactor * 100)}%，`
                    + '再往下就会真的触发自动压缩（历史被摘要替换）',
                }, [
                  h('i', { key: 'd', className: 'aw-dot', style: { background: 'var(--dsw-alias-state-error-primary)' } }),
                  T.levelCrit,
                ]),
              ]),
            ]),
            h('div', { className: 'aw-canvas', key: 'cv', ref: stageRef },
              h(NetworkMemo, {
                graph,
                selected,
                onSelect: setSelected,
                onProject: name => setFilter({ ...filter, project: name }),
                // Only the sessions the user is actually watching get flow.
                pinned: panes.filter(Boolean),
              })),
            h('div', {
              className: 'aw-bot', key: 'bot',
              style: { gridTemplateColumns: botCols[0] + 'fr 8px ' + botCols[1] + 'fr 8px ' + botCols[2] + 'fr' },
            }, [
              h(Composition, { key: 'c', sessions: scope.sessions, pricing, scopeLabel: scope.label }),
              h('div', {
                key: 'h1', className: 'aw-bot-h',
                onPointerDown: botHandleDown(0), onPointerMove: botHandleMove, onPointerUp: botHandleUp,
              }),
              h(Matrix, { key: 'm', sessions: filtered, selected, onSelect: setSelected, th }),
              h('div', {
                key: 'h2', className: 'aw-bot-h',
                onPointerDown: botHandleDown(1), onPointerMove: botHandleMove, onPointerUp: botHandleUp,
              }),
              h(Inspector, { key: 'i', session: selectedSession, onOpen: openNative, th }),
            ]),
          ]),
      ])
    }

    /* ══════════════════ registration ══════════════════ */

    function SidebarIcon(props) {
      const size = props?.size ?? 16
      const active = props?.active === true
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        style: { opacity: active ? 1 : 0.75 },
      }, [
        h('circle', { key: 'a', cx: 2.6, cy: 8, r: 1.3, fill: 'currentColor', stroke: 'none' }),
        h('circle', { key: 'b', cx: 8, cy: 4, r: 1.1 }),
        h('circle', { key: 'c', cx: 8, cy: 12, r: 1.1 }),
        h('circle', { key: 'd', cx: 13.4, cy: 6, r: 1.1 }),
        h('circle', { key: 'e', cx: 13.4, cy: 11, r: 1.1 }),
        h('path', { key: 'f', d: 'M2.6 8L8 4M2.6 8L8 12M8 4l5.4 2M8 12l5.4-1' }),
      ])
    }

    return {
      inject: ['slots', 'sessions', 'locale'],
      apply(ctx) {
        window.__SESSION_MATRIX_CTX__ = ctx

        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.effect(() => ctx.locale.register('sessionMatrix', {
            zh: { title: '会话矩阵工作台' },
            en: { title: 'Session Matrix' },
          }), 'dsh-session-matrix: locale')
        }

        // The session-scoped child slot is what makes the renderer inject
        // `SessionProvider` + `renderFactorySlot` into this panel. Registration
        // is guarded: if the Host lacks the session scope adapter (a trimmed
        // profile) the entry would throw SlotAssemblyError and the whole main
        // area would go blank, so we fall back to a panel without children.
        try {
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'dsh-session-matrix',
            locale: 'sessionMatrix',
            children: {
              'dsh-session-matrix.pane': { kind: 'single', scope: 'session' },
            },
          }, props => h(Boundary, null, h(Workbench, props))))
        } catch (error) {
          console.error('dsh-session-matrix: native registration failed, falling back', error)
          try {
            ctx.slots.inject('main', () => ctx.slots.register({
              name: 'main',
              key: 'dsh-session-matrix',
              locale: 'sessionMatrix',
            }, props => h(Boundary, null, h(Workbench, props))))
          } catch (second) {
            console.error('dsh-session-matrix: fallback registration failed', second)
          }
        }

        try {
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'dsh-session-matrix',
            order: 40,
            // Without `label` the sidebar falls back to the raw entry id —
            // which is why this panel used to read the raw entry id.
            label: () => '会话矩阵工作台',
            locale: 'sessionMatrix',
          }, SidebarIcon))
        } catch (error) {
          console.error('dsh-session-matrix: sidebar entry registration failed', error)
        }
      },
    }
  },
})
