# 30 · 收录到 awesome-dsh-plugin（DSH Market）

调研时间：2026-11-17 21:30
来源：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md

## 提交方式

不是 issue，也不是改 README。**一个 PR，只加一个文件**：

```
data/plugins/<owner>__<repo>.yml
→ data/plugins/Wanqiu12345__dsh-session-matrix.yml
```

README 由脚本从 `data/plugins/*.yml` 生成，手工改 README 会被拒。

## 条目内容（已按我们的实际情况起草）

```yaml
url: https://github.com/Wanqiu12345/dsh-session-matrix
name: Wanqiu12345/dsh-session-matrix
category: session
description:
  en: Run up to four native sessions side by side, trace how subagents connect, and hand work over before context compaction.
  zh: 最多四栏原生会话并排运行，梳理子代理关系，在上下文自行压缩前把工作交接出去。
icon: https://raw.githubusercontent.com/Wanqiu12345/dsh-session-matrix/main/assets/icon-180.png
```

- `category: session` —— 分类要贴合实际功能。我们做的是多会话并行、关系图、上下文监控与交接，
  属会话管理；`ui` 是界面增强，不是我们。
- 描述里每个断言都能在代码里找到对应：四栏（`MAX_PANES = 4`）、子代理关系（`parentSession`）、
  压缩前交接（handoff 协议）。**评审会核对描述与代码是否一致，夸大是主要打回原因。**
- 描述是一条事实陈述，不带最高级、不带营销词，以句号结尾。
- `zh` 可选，写了更完整。

## 我们逐条的达标情况

| 要求 | 状态 |
|:--|:--|
| `package.json` 声明 `dsh.bundle` | ✅ `dsh.bundle.patch = ./cordis.patch.yml` |
| 仓库加 `dsh-plugin` topic | ✅ 已在 topics 中 |
| 仓库年龄 ≥ 1 天 | ⏳ **17 小时，差 7 小时**（20:34 UTC 建仓，次日 04:34 北京时间后可提交） |
| 描述属实、无营销词 | ✅ |
| 分类贴合 | ✅ session |
| 每个 PR 最多 3 条 | ✅ 我们只有 1 条 |
| 官方 `@deepseek-ai/*` 用 peerDependencies | ✅ 我们没有运行时依赖 |
| npm 包 `repository` 指回本仓库 | ✅ 与收录地址一致 |
| 图标为 GitHub 托管的位图 | ✅ 新增 `assets/icon-180.png`（180×180、透明底） |

npm 发布是**可选**的，只影响市场里的下载量显示；我们已发布，属于加分项。

## 时间窗口

CI 会检查仓库创建时间，门槛 1 天。我们的仓库 `created_at = 2026-11-16T20:34Z`，
即 **2026-11-18 04:34（北京时间）之后**提交才不会被 CI 拦。

提前提交的结果是「年龄不达标」而失败——文档说可以修好后重推同一个 PR，但没必要先撞一次。

## 提交步骤（等窗口到了再做）

1. fork `awesome-dsh-plugin/awesome-dsh-plugin`
2. 新建分支，加 `data/plugins/Wanqiu12345__dsh-session-matrix.yml`
3. 提 PR，标题形如 `Add Wanqiu12345/dsh-session-matrix`
4. CI 依次检查：条目数 → `dsh.bundle` → 仓库年龄 → awesome-lint 与站点构建
5. 维护者会读代码核对描述；需要改时打 `held: author` 标签，改完重推即可

## 备注

- 仓库若自己声明 `screenshots.json` 才会在列表里显示截图，属可选，本轮不做。
- 收录不代表质量背书，文档自己也这么写；不通过不影响 npm 安装。
