# Changelog

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 组织，版本号遵循语义化。

## [0.15.3] — 2026-11-17

### 修复
- **Client 与 Host 各算一套压缩点。** Host 已改为 `window − output − 4096`，Client 还留着
  `COMPACT_RATIO = 0.8` / `COMPACT_HEADROOM = 65536`，于是图谱颜色、Tooltip 与 DTO 的
  `compactRatio` 对不上。现在 Client 只消费 `compactTokens` / `compactRatio` / `compactRetain` /
  `risk`，Host 新增 `compactRetain` 字段；旧公式与常量整段删除。
- 悬浮提示里「窗口×0.8 与 64K 余量取小」的说明改为「窗口 − 输出预留 − 4K 余量」，与
  `dsh-compaction-basic` 一致。
- `usage-split`：负数与 `NaN` 不再参与求和。

### 新增
- `test/usage-split.test.mjs`：10 条用例覆盖峰时边界（09:00 / 12:00 / 14:00 / 18:00、周末）、
  时间戳单位、多帧、截断帧、损坏帧、缺 usage、脏数据。`npm test` 现在跑两个文件。
- 用例锁死「Client 不得再定义压缩常量」，防止两份公式再次分叉。

### 变更
- 日志解析增加增长门槛：活跃会话在 60 秒内、增长不足 256KB 时不重新全量解压。
- 损坏帧不再中断整份日志，跳过该候选继续扫描后面的帧。

## [0.15.2] — 2026-11-17

### 文档
- 贡献者名单改用 all-contributors 规范（`.all-contributorsrc` + README 头像表），补上
  bowenliang123 / dsh-context 作为思路与数据口径来源。
- `llms.txt` 与 `locale/en.json` 里最后一处 `Agent Flow` 统一为 `Agent Graph`。

## [0.15.1] — 2026-11-17

### 修复
- 压缩点改为照搬 `dsh-compaction-basic`：`window − 预留输出 − headroomTokens(4096)`。
  原来的 `min(window × 80%, window − output − 64K)` 会提前预警，1M/256K 的会话从 69.3% 修正为 75.2%。
- 费用提示改为按来源区分：从日志分桶的显示金额，只有总量时显示 `≈` 前缀并在 tooltip 说明是估算。

### 变更
- 文件头与关键词清理：移除 `Agent Workspace` 旧名与 `agent-workspace` 关键词；
  `storages/agent-workspace/` 路径与 `aw.*` 键保持不变。
- 模块名「会话矩阵」改为「会话概览」，避免与产品名重名。
- 新增用例：压缩点必须等于 `window − maxOutput − 4096`。

## [0.15.0] — 2026-11-17

### 新增
- **从会话日志重建峰谷用量**。核心 `tokenUsage` 只有总量、没有时间轴；日志里每条 `assistant/message`
  都带 `time` 与 `usage`，插件逐帧解压（zstd 帧按魔数扫描）后按北京时间工作日 09:00–12:00、
  14:00–18:00 分桶。没装 dsh-context 时费用不再靠估算。
- 解析按预算分摊：每次采集最多 6 个文件 / 8MB，按文件大小升序；结果按 (mtime, size) 缓存，文件变化才重解析。
- 新增 `costSource` 字段（`projection` / `log` / `totals`），以及 `peakFromLogs`、`logBudget`、
  `logBudgetBytes` 配置。

### 验证
- 无 dsh-context 环境：33 个会话全部从 `totals` 收敛到 `log`，总额 ¥90.75 → ¥98.29；
  同环境装它时为 ¥100.80（差异来自归档会话）。
- 采集耗时：首屏 2.7s（冷投影），收敛期单次最高 1.5s，稳态 30ms。

## [0.14.6] — 2026-11-17

### 新增
- 配置项 `peakFactor`（默认 `1`）：没有峰谷分桶时用来调整费用估算，`1.5` 表示假设一半用量发生在峰时。有 dsh-context 的分桶时该值不生效。

## [0.14.5] — 2026-11-17

### 修复
- **不再依赖 dsh-context**。核心 `tokenUsage` 投影的值以 `{ver,seq,val}` 包装返回，之前没有解包，
  导致没装 dsh-context 时用量与费用全空。现在解包后四个 token 桶都能读，费用按谷时价估算；
  装了 dsh-context 仍走它的峰谷分桶，价格更准。
- 计价改用回退后的模型名（`modelSelection`），不再要求 `contextTimeline` 存在。

### 文档
- README 增加「贡献者」一节，写明 dsh-context 的参考价值；新增测试覆盖包装形状的投影值。

## [0.14.4] — 2026-11-17

### 修复
- 未安装 dsh-context 时，侧栏与脉络里所有会话的模型名都是空：现在回退到核心的 `modelSelection` 投影，并把该投影加入请求列表。

### 文档
- 说明费用数字依赖 dsh-context 的用量投影；没装它时费用为空，其余功能正常。

## [0.14.3] — 2026-11-17

### 新增
- `/api/session-matrix/capabilities` 返回 `pluginVersion`，安装后可直接从 HTTP 确认装的是哪个版本，issue 里也能对上号。

## [0.14.2] — 2026-11-17

### 文档
- README 改为按入口组织：入口与视图 → 工作区 → 智能体脉络 → 上下文监控 → 交接 → 费用，
  每个能力一个小节，配仓库内截图。
- 增加与 `dsh-context` 的关系说明：同一套人民币换算与峰时倍率，费用可对账；职责互补。
- 英文说明收进折叠块，中文为正文。
- 新增 `AGENTS.md`（给编码 Agent 的仓库约束）、`CONTRIBUTING.md`、`llms.txt`、Issue/PR 模板、CI。

### 修复
- 侧栏入口显示为 `agent-workspace`（缺 `label`）：现在显示「会话矩阵工作台」。
- 刷新按钮点击后无反馈：加入忙碌状态、图标旋转、请求期间禁用，并保底 420ms 可见。
- 交接弹窗中两段结论加粗并加左侧强调条。

### 变更
- 视图「运行图谱」更名为「智能体脉络」。
- **归档会话不再显示**，与原生侧栏一致；归档集合读自 `storages/workspace.json`。
- 包名 `agent-workspace` → `dsh-session-matrix`，路由前缀改为 `/api/session-matrix/*`；
  `aw.*` 持久化前缀保留，旧布局无需迁移。

### 修复（更早）
- 交接弹窗变量名错误导致整个主面板空白（已加错误边界）。
- 被删除的会话会把窗格永久卡在「选一个会话」。
- 单个会话异常会让整次采集失败、面板停止更新。

## [0.13.0] — 2026-11-16

### 新增
- 上下文构成、累计用量与费用、会话矩阵三块模块。
- 智能体脉络的矩形分层布局，节点按压缩风险着色。

## [0.12.0] — 2026-11-16

### 新增
- 1–4 格原生会话窗格、可拖动的分隔线、按会话记住的缩放。
- 通用交接提示词与 `HANDOFF-*.md` 协议 v1。
