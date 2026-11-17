# 30 · npm 发布准备审查

审查时间：2026-11-17 12:08–12:35
审查对象：`dsh-session-matrix`，仓库 HEAD `03cefe1`
本轮**未执行** `npm publish`，未改版本号 / 标签 / Release / 包名。

## 1. 结论速览

| 检查项 | 结果 |
|:--|:--|
| Registry | `https://registry.npmjs.org/`，`npm ping` 2460ms 通 |
| 登录状态 | ❌ `need auth` |
| 包名占用 | ✅ 未被占用（`npm view` 404，`npm search` 无同名条目） |
| `npm publish --dry-run` | ✅ 通过，14 文件 / 303.5 kB unpacked |
| 本地 tarball 安装 | ✅ 可装、可 import、`npm test` 在安装目录内跑通 |
| DSH 包名安装 | ⏳ 机制支持，未发布无法实测 |

## 2. 版本口径（需要你确认）

你说「当前版本 0.16.1」，但仓库实际是 **0.16.2**：

```
package.json  0.16.2
HEAD          03cefe1
tag v0.16.2   03cefe1
```

0.16.2 只改了 README 徽章、截图体积、加了一条测试，没有代码逻辑变更。发布前请确认以 **0.16.2** 为准；
若坚持 0.16.1，需要重打标签并回滚两处文档，我不擅自做。

## 3. package.json 现状

| 字段 | 值 | 评价 |
|:--|:--|:--|
| `name` | `dsh-session-matrix` | 非 scope 包，首次 `npm publish` 即可，无需 `--access public` |
| `version` | 0.16.2 | 同上待确认 |
| `main` / `exports["."]` | `./lib/index.js` | 与 `cordis.patch.yml` 的 `name` 解析一致 |
| `type` | `module` | 纯 ESM，无构建步骤 |
| `files` | lib, locale, icon.svg, README, LICENSE, cordis.patch.yml, test | 见下 |
| `engines.node` | `^22.19.0 \|\| >=24` | 依据：`zstdDecompressSync` 需 ≥22.15，取整到 22.19 |
| `engines.dsh` | `>=0.2.2-rc.1` | DSH 会读该字段（asar 里有 `engines.dsh` 解析） |
| `dsh.bundle.patch` | `./cordis.patch.yml` | 已在包内 |
| `repository.url` | `git+https://github.com/Wanqiu12345/dsh-session-matrix.git` | 与仓库一致 |

**建议新增（未执行，等你决定）**：

```json
"scripts": { "prepublishOnly": "npm test" }
```

理由：防止手滑发布未过测试的版本。代价是发布前会跑 40 秒测试。

## 4. tarball 内容（`npm pack --dry-run`）

```
1104    LICENSE
14678   README.md
263     cordis.patch.yml
751     icon.svg
165441  lib/client.js
3764    lib/handoff/v1.md      ← 交接协议，运行时按 URL 读取
57947   lib/index.js
6516    lib/usage-split.js
709     locale/en.json
685     locale/zh.json
1815    package.json
33822   test/host.test.mjs
12991   test/usage-split.test.mjs
2991    test/usage-vs-projection.test.mjs
```

- 运行时文件齐全：Host、Client、handoff 协议、locale、icon、manifest。
- 没有 `.env`、凭证、日志、`.workbuddy/`、`poc/`、`research/`。
- `test/` 是**有意包含**（约 50 KB）：让安装后能 `npm test` 自检。若想瘦身可去掉，但会失去这个能力。

## 5. 本地安装测试（临时目录）

```
npm install <tgz>  → added 1 package
import 'dsh-session-matrix' → exports: apply, costOfBuckets, inject, name
inject = webServer,sessionQuery,sessions,connection
lib/handoff/v1.md 存在；cordis.patch.yml 引用 ./lib/index.js 可解析
```

在**安装目录内**执行 `npm test`：

```
host.test.mjs 36 passed · usage-split 20 passed · 对账 37/37
```

说明发布包不依赖仓库里未发布的文件。

## 6. DSH 能否用 npm 包名安装

源码证据（asar 内 `packages/boot/plugin-manager/src/index.ts`）：

- 用法串：`dsh plugin --profile ${name} add <package>`；
- `pluginManager/installBundle` 的描述：*"Install a package using the same pnpm implementation as `dsh plugin`"*；
- 安装走 **pnpm + 配置的 registry**（`pluginManager/registries`，含 npm 与镜像回退）。

结论：**机制上支持 `dsh plugin add dsh-session-matrix`**，因为 pnpm 会从 npm registry 解析。
但必须区分三件事：

| 结论 | 状态 |
|:--|:--|
| npm 包能被 npm 安装 | ✅ 已实测（tarball） |
| DSH 能用包名安装 | ⏳ 机制支持，未发布无法实测 |
| DSH「插件发现」页能搜到 | ⏳ 无证据表明它查 npm search（asar 里没有 `/v1/search`），上架后再看 |

另一点：如果本机 DSH 配了国内镜像（`NPMMIRROR_*`），新包同步有延迟，`add` 可能先报 404。建议发布后等几分钟再用官方源试。

## 7. 首次发布需要你做的

```bash
npm login          # 需要 2FA / 符合 npm 当前发布验证要求
npm whoami         # 确认是 Wanqiu12345
npm publish        # 在仓库根目录执行
```

发布前请再确认一次版本号（见第 2 节）。**我不能代做**：这台机器没有登录态，且发布是不可逆的公开操作。

发布成功后我做三件事：
1. README 徽章换回 npm 版本徽章；
2. 仓库 Website 指回 `npmjs.com/package/dsh-session-matrix`；
3. 在 DSH 里实测 `dsh plugin add dsh-session-matrix`（卸载现有插件 → 从 npm 装 → 启动验证）。

## 8. 自动发布方案（发布成功后接入）

用 npm Trusted Publishing（OIDC），不用长期 token：

```yaml
# .github/workflows/publish.yml
name: publish
on:
  push:
    tags: ['v*']
permissions:
  contents: read
  id-token: write        # OIDC 换 npm 凭据
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          registry-url: https://registry.npmjs.org
      - run: npm test
      - name: version must match tag
        run: node -e "const v=require('./package.json').version;if('v'+v!==process.env.GITHUB_REF_NAME)process.exit(1)"
      - run: npm publish --provenance --access public
```

注意三点：
1. npm 侧 Trusted Publisher 的仓库名、workflow 文件名、大小写必须完全一致（`Wanqiu12345/dsh-session-matrix`、`publish.yml`）；
2. 首次发布必须先手工完成，之后才能绑定 Trusted Publisher；
3. `--provenance` 需要公开仓库（已是）。

## 9. 阻断项

| 级别 | 项 | 说明 |
|:--|:--|:--|
| **P0** | 未登录 npm | 唯一硬阻断，只能你来 |
| **P1** | 版本口径 0.16.1 vs 0.16.2 | 发布哪一版要先定，定错不能复用 name+version |
| P2 | 无 `prepublishOnly` | 建议加，防手滑 |
| P2 | 发布后徽章 / homepage 需切回 | 发布后我处理 |

没有发现包名冲突、缺文件、越界文件或敏感信息。
