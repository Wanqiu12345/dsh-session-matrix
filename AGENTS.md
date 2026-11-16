# AGENTS.md

Instructions for coding agents (and humans) working in this repository.

## Layout

```
lib/index.js        host half   — Cordis plugin, three JSON routes, projection reads, price book
lib/client.js       browser half — React panel (no JSX, uses React.createElement via `h`)
lib/handoff/v1.md   handoff protocol, shipped as data and read at request time
locale/{zh,en}.json plugin metadata for the plugin store
test/host.test.mjs  29 contract tests with a fake DSH context
docs/*.png          README screenshots
```

## Commands

```bash
npm test              # 29 contract tests, no network, ~1s
node --check lib/client.js
node --check lib/index.js
npm pack --dry-run    # expect 10 files, ~72 KB
```

There is no build step and no bundler. Editing `lib/client.js` is enough for DSH to hot-reload the panel.

## Hard rules

1. **No runtime dependencies.** The package ships two JS files. A dependency multiplies the install
   surface for every user.
2. **No `process.platform` branches.** Paths come from `new URL(import.meta.url)` or the host's
   `dshHomePath()`. Anything else breaks the other OS.
3. **Host does not render; client does not read files.** All data crosses three routes:
   `/api/session-matrix/overview`, `/capabilities`, `/handoff`.
4. **Do not rename persisted keys.** `localStorage` uses the `aw.*` prefix and the price cache lives in
   `storages/agent-workspace/`. Renaming either silently resets user layouts or orphans a cache.
5. **New user-facing strings go in both languages.** Inline `T` for the panel, `locale/*.json` for the
   store metadata.
6. **Numbers need a source.** If you touch cost or occupancy, name the projection field in the comment.

## Conventions

- The client builds elements with `h = React.createElement`; there is no JSX.
- Panes are keyed by session id, never by slot index.
- Any render error is caught by the `Boundary` class; keep it wrapping the modal and the workbench.
- Comments explain *why*, not *what*. If a line needs a "what" comment, rename things instead.

## When changing a capability

Update, in the same commit:

- `README.md` — the section that describes it
- `locale/zh.json` + `locale/en.json` — the store description if the capability list changed
- `llms.txt` — the fact list, including the "Not true / not claimed" section if a claim stops holding
- `docs/` — a screenshot if the UI changed

## Releases

`npm version patch|minor`, then tag `vX.Y.Z`, push, and create a GitHub release with notes that describe
the user-visible change in words (release pages are indexed too).
