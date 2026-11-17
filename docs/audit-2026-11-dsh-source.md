# 28 · 基于 DSH 源码的专项审查（0.16.0）

基准：`deepseek-ai/deepseek-harness` @ `dsh-v0.2.2-rc.1`（项目声明的最低版本），实机 DSH `0.2.2-rc.x`。
方法：读该 tag 的源码 → 对照插件实现 → 隔离 profile 实测 → 回归。

---

## P0-1 · Host API 认证绕过｜已修复并测试

### DSH 实际机制（`packages/client/connection/src/`）

`index.ts` 把 `{ kind:'prefix', path:'/api' }` 注册到 web server，handler 先 `connection.admit(req)`：

```js
const admission = connection.admit(req)
if ('rejection' in admission) { res.writeHead(admission.rejection); ... }
await bridge(req, res, fetchHandler, admission.peer, ...)
```

`rpc-host.ts` 的 `createSharedFetchHandler('/api')` 里，exact fetch 路由命中后还有一道：

```js
if (peer.principal.kind !== 'owner') return Promise.resolve(new Response('forbidden', { status: 403 }))
```

### 插件原实现

`ctx.webServer.register({ kind:'exact', path, resource })` —— exact 路由优先于 `/api` 前缀匹配，
**根本不经过 `admit()`**。这就是无 token 返回 200 的底层原因。

### 修复

```js
connection.fetch.register({
  path: '/api/session-matrix/overview',   // 必须带 /api 前缀
  methods: ['GET', 'HEAD'],
  requestBody: 'buffered',
  fetch: async request => handler(request),
})
```

三处要点：

1. `assertFetchRoute` 用 `endpointFromPath(API_PATH, route.path)` 校验，**path 是完整 `/api/...`**，
   不是相对路径（这一点与任务描述不同，以源码为准）。
2. `inject` 增加 `connection`。`ctx.get()` 对未注入的服务会抛 `cannot get property`，
   第一次实现忘了加，三个路由静默不注册。
3. 删除无鉴权回退：`connection` 缺失时 `logger.error` 并返回空 disposer。

### 实测矩阵（三条路由逐一，同一实例）

| 场景 | overview | capabilities | handoff |
|:--|:--|:--|:--|
| 无 token | 401 | 401 | 401 |
| 错误 token | 401 | 401 | 401 |
| 带 cookie（`/?token=` 换取） | 200 | 200 | 200 |
| `Host: evil.example` | 403 | — | — |
| `Origin: https://evil.example` | 403 | — | — |
| 卸载插件后 | 404 | 404 | 404 |

注意：`?token=` 只对首页换 cookie 有效，`/api/*` 认的是 cookie。第一轮我用 `?token=` 测出「good=401」，
那是测法错误，不是产品缺陷——已改用 cookie jar 复测。

---

## P0-2 · usage-split 漏算｜已修复并测试

### DSH 实际机制（`packages/core/session/src/types.ts`）

```ts
'assistant/message': { turn, step, message, stream: AssistantStreamRecord[], usage?: TokenUsage }
'assistant/attempt': { turn, step, stream: AssistantStreamRecord[] }   // 无顶层 usage
```

流内 usage 分片：`{ type:'chunk', time, chunk:{ type:'usage', usage:{...} } }`，`time` 与事件时间可差数毫秒。

### 修复

- 两类事件都处理；顶层 `usage` 优先，缺失时才从 `stream` 取，一次 settlement 只记一次。
- 峰谷用 **usage 分片自己的 `time`**，不是事件时间。
- `reasoningTokens` 已含在 `outputTokens`，不重复加。
- 负数 / `NaN` 不计入（之前会把总量算小甚至是负的）。

### 验证

新增 `test/usage-vs-projection.test.mjs`：把解析结果与 DSH 自己算的 `tokenUsage.totals` 对账。

```
usage-vs-projection.test.mjs — 37/37 sessions match exactly
```

真实日志里两个 `assistant/attempt` 都是 transport failure（无 usage），所以这条对账证明的是「不漏」，
不能证明「attempt 带 usage 时一定取到」——那部分由合成用例覆盖（16 条中的 4 条）。

---

## P1 · 持久化读取｜已修改并部分实测

### 接口（`packages/session/session-persistence/src/`）

`stat(id) → { revision, sizeBytes, eventCount? }`；`open(id,'read') → handle.read() → { events }`，
事件已解析。`revision` 是官方声明的变更令牌。

### 实现

`splitFromPersistence(id)`：`stat` 拿 revision → 命中缓存直接返回 → 否则 `open('read')`、
`read()` 取事件、`splitUsageEvents()` 计算、`finally` 关闭句柄。失败或无服务时回退到文件扫描。

实测（无 dsh-context 环境）：两条路径最终都收敛到 **¥98.29**，逐轮金额一致（90.75 → 91.12 → …）。

### 未做

- 增量读取：`read(offset, length)` 支持，但我们的缓存粒度是整份会话，暂按整份读。
- 活跃会话的未落盘数据：仍以持久化结果为准，可能有秒级延迟；未接 `session/event` 实时流。

---

## P1 · Zstd 帧解析｜保留自研，理由如下

官方 `scanZstdFrames()` 会走完整的描述符 / 块头 / checksum / `tornStart`，比只扫魔数严谨得多。
但它**不构成可依赖的公开 API**：

- `packages/session/session-persistence-jsonl/package.json` 的 `files` 只含 `locale/`、`lib/index.js`、
  `lib/worker.cjs`、`lib/types/**`；`src/zstd.ts` 不在发布物里。
- `exports` 里的 `"./src/*"` 指向这些未发布的文件，安装后 import 会失败。

所以：**持久化路径下完全不碰 zstd**（拿的是事件）；自研扫描器只作为回退。回退路径已加固：
失败时跳过该候选继续扫，而不是中断整份日志。

---

## P1 · Session 引用与生命周期｜已核对，待人工实测

源码要点：

- `conversation.content` Factory 不接受独立 Session，靠 `SessionProvider` 提供 scope（asar 文档明确）。
- `phase` 由 `shellPhase + openState + blank` 决定，但 pane 插槽只注入 `useSessionStatus`
  （运行态 `{running, pendingInteraction, completionUnread}`），拿不到 shellPhase —— 上一轮已确认。

现有 `NativePane`：每个 pane 独立 retain、`AbortController` 覆盖异步、cleanup 里 `release()` 一次。
**未做**：2/4 个 pane 并发、StrictMode 双挂载、跨 generation 的实测。需要真实发消息，不能靠静态审查代替。

---

## P1 · 性能与缓存｜部分改善

| 问题 | 现状 |
|:--|:--|
| revision 缓存 | ✅ 持久化路径已用 |
| 文件缩小/重建 | ✅ revision 变化即重读；文件路径仍看 size/mtime |
| 活跃会话重复解析 | ✅ 60 秒内且增长 < 256KB 不重算 |
| 单文件超预算 | ⚠️ 首个超大文件仍会整读（按大小升序，它排最后） |
| 并发重复任务 | ⚠️ 未加锁；靠每轮预算串行，理论上两次 collect 可能重叠 |
| 卸载时清理 | ✅ 路由有 disposer；读取任务无长驻句柄 |

---

## 测试与版本

```
host.test.mjs                31 passed
usage-split.test.mjs         16 passed
usage-vs-projection.test.mjs 37/37 exact
npm pack                     11 files / 79.1 kB
```

版本链条：`package.json` / CHANGELOG / tag / GitHub Release 均为 **0.16.0**；npm 仍**未发布**（`npm view` 404）。

## 仍需宿主环境验证

1. 多 Pane 并发与 StrictMode（人工，20 分钟）。
2. `assistant/attempt` 带 usage 的**真实**样本：现有日志里两次都是 transport failure。
3. 远程访问场景（反代 / 隧道）下 cookie 的 `Secure` 与 authority 判定。
4. macOS / Linux。
