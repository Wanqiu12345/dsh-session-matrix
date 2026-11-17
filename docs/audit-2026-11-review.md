# 29 · 0.16.x 全量复核报告

审查对象：`Wanqiu12345/dsh-session-matrix`
审查时间：2026-11-17 11:46–13:10（北京时间）
基准：DSH `dsh-v0.2.2-rc.1` 源码 + 本机 `0.2.2-rc.x`

## 0. 版本与分支的真实现状（先回答「为什么不一致」）

用 GitHub API 直接读 refs，而不是看页面缓存：

| 位置 | SHA | package.json |
|:--|:--|:--|
| 默认分支 `main` | `902a34b` | **0.16.0** |
| 标签 `v0.16.0`（复核前） | `7c494a8` | 0.16.0 |
| 标签 `v0.16.0`（复核后） | `902a34b` | 0.16.0 |
| Release `v0.16.0` | 指向 `main` | — |

**「main 是 0.15.2」不成立**：`GET /repos/.../contents/package.json?ref=main` 返回 0.16.0，
`GET /branches` 只有一个 `main@902a34b`。页面上的 0.15.2 是浏览器/CDN 缓存——上一次 Contributors
重复也是同一类现象。

**但确实存在一处不一致**：`v0.16.0` 原标签 `7c494a8` **不含** `docs/audit-2026-11-dsh-source.md`。
原因是我先打标签、后提交报告，顺序错了。

处理：把 `v0.16.0` 前移到 `902a34b`（强制更新，npm 从未发布过该版本，无下游依赖），
现在 main / tag / Release 三者同 SHA，且都含报告。

## 1. 审查范围

```
lib/index.js          1,468 行（Host）
lib/client.js         2,9xx 行（Client）
lib/usage-split.js      约 200 行
test/host.test.mjs      35 条
test/usage-split.test.mjs 20 条
test/usage-vs-projection.test.mjs 37/37 对账
package.json / cordis.patch.yml / README / CHANGELOG
```

## 2. 问题清单

### P0-1 · usage 时间戳与报告描述不符｜已修复并测试

`usageOfEvent()` 在顶层 `data.usage` 存在时直接返回 `event.time`，而报告写的是「用分片时间」。
代码与文档不一致，且会算错边界分钟。

修复：数值仍取顶层 `usage`，时间戳**始终优先分片 `record.time`**，无分片才回退 `event.time`。

证据（真实日志 5,456 个结算事件）：usage 分片数量只出现 0 或 1，从无多个。
因此规则定为「取唯一分片；若将来出现多个，取最后一个（结算快照），不累加」。

新增 4 条边界测试：08:59:59.999→09:00:00.001、11:59:59.999→12:00:00.001、
顶层 usage + 分片时间、无分片回退；另有「多分片取最后一个不累加」。

### P0-2 · revision 缓存语义错误｜已修复并测试

旧实现：revision 变了，但若增长 < 256 KB 且距上次 < 60 秒，仍返回旧缓存。这违背 revision 的用途。

修复：revision 相同直接命中；revision 不同必须重读；删除该节流。
成本控制改由三处承担：每轮 `logBudget` 预算、`inflightSplits` 并发合并（同 `id|revision` 共享一次读取）、
缓存按 revision 键。

新增 3 条用例（含预热循环，避免把「预算推进」误判为「缓存未命中」）：
相同 revision 不重开 handle；revision 变 1 KB 也必须重读；两个并发 collect 对同一 revision 的
handle 数不超过预算。

### P0-3 · Persistence 未真正独立于 Zstd 和文件索引｜已修复并测试

旧实现：先 `import('node:zlib')`、先 `indexSessionLogs()`，再对「有文件」的会话调用 persistence。
zstd 不可用或索引失败时，persistence 根本不会被调用。

修复：拆成两阶段。阶段 1 只走 `stat/open/read`，不碰 zlib、不建索引；阶段 2 才检查 zstd、建索引、读文件。

测试：假宿主把 `dshHomePath` 指向**没有 sessions 目录**的路径，persistence 仍能算出峰谷，
用例名 `persistence answers without a log-file index or zstd`。

### P1-1 · 回退路径的帧扫描限制｜已记录，未彻底解决

- 压缩体内出现魔数：会误切；成功率靠「失败后跳过候选继续扫」兜底，可能丢该帧头部。
- 截断帧：Node 的 `zstdDecompressSync` **不抛错**，返回部分数据；已用「可解析则用、不可解析则跳过」处理。
- 无法确认完整性的帧：不参与统计（解析失败即整帧丢弃）。

官方 `scanZstdFrames()` 能正确区分完整/损坏/截断，但**不可依赖**：`session-persistence-jsonl`
的 `files` 不含 `src/`，`exports` 的 `./src/*` 指向未发布文件。
结论：持久化路径不碰 zstd；回退路径保留并标注为「尽力而为」。

### P1-2 · 单文件超预算｜已知限制

预算在加入前判断，因此首个超大文件仍会整读（按大小升序它排最后）。未改，因为禁掉会让大会话永不精确。

### P1-3 · 并发 collect 无全局锁｜部分缓解

同一 revision 的读取已合并；但两次 collect 仍可能各自遍历不同会话。当前每轮有预算，
最坏情况是多读一轮，不影响正确性。

### P1-4 · Host/Client 边界｜静态审查通过

Client 只消费 DTO（`compactTokens/compactRatio/compactRetain/risk/costSource`），不再本地推导；
`riskOf` 直接返回 DTO 的 `risk`。三条路由均走 `connection.fetch`，无鉴权回退。

### P2-1 · 发布包缺 test/｜已修复

`files` 白名单原为 `lib, locale, icon.svg, README, LICENSE, cordis.patch.yml`，
而 `npm test` 引用 `test/`。已加入 `test/`，`npm pack` 现 14 个文件、约 112 KB。

`test/usage-vs-projection.test.mjs` 在没有本地 DSH 数据时会 **skip 并返回 0**，不会在用户机器上误报失败。

### P2-2 · npm 未发布｜确认

`npm view dsh-session-matrix version` → 404。发布包与仓库同源，但未上架。

## 3. 测试结果（本次重跑，非引用旧报告）

```
host.test.mjs                 35 passed / 0 failed
usage-split.test.mjs          20 passed / 0 failed
usage-vs-projection.test.mjs  37/37 sessions match exactly
npm pack                      14 files
```

DSH 隔离环境实测（无 dsh-context，走 persistence）：

| 项 | 结果 |
|:--|:--|
| overview 无 cookie | 401 |
| overview 带 cookie | 200 |
| capabilities / handoff 同上 | 401 / 200 |
| 费用收敛 | 33 会话全部 `log`，¥98.29 |
| 接口错误字段 | 无 |

## 4. 人工实测清单（未执行，需真实交互）

以下项目**没有**被静态审查或单测覆盖，标记为未验证：

1. 单 Pane 发消息。2. 双 Pane 同时运行。3. 四 Pane。4. 主会话与子代理同屏。
5. 关闭/重开/快速切换 Pane。6. StrictMode 双挂载。7. 工具调用与审批。8. 卸载后重载。

## 5. 一致性结论

| 入口 | 拿到的是否同一份代码 |
|:--|:--|
| 默认分支 `main` | ✅ `902a34b` |
| 标签 `v0.16.0` | ✅ `902a34b` |
| Release `v0.16.0` | ✅ 指向同一 commit |
| npm | ❌ 未发布（404） |

## 6. 仍未解决

1. 多 Pane / StrictMode：需人工。
2. `assistant/attempt` 带 usage 的真实样本：现有两次均为 transport failure。
3. 帧扫描的魔数误切：概率低、有兜底、未彻底消除。
4. 远程反代下的 cookie `Secure` 与 authority 判定。
5. macOS / Linux。
