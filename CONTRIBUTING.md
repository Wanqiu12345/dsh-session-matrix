# Contributing to DSH Session Matrix

Thanks for taking a look. This is a small plugin (two plain-JavaScript files, no build step), so the
contribution loop is short.

## Before you open an issue

1. Check `Plugins → Discover` shows the same version you are running.
2. Run `curl -s http://127.0.0.1:<port>/api/session-matrix/capabilities` (port is in the DSH URL) and
   paste the JSON. It tells us whether projections are available and which keys the host exposes.
3. Note your DSH version and OS. The panel is tested on DSH `0.2.2-rc.x` / Windows 11; macOS and Linux
   reports are especially useful.

## Reporting a bug

A good report has: what you did, what you expected, what happened, a screenshot, and the capability
JSON above. If the panel is blank, also paste the browser console — a render error is caught by the
panel's error boundary and logged there instead of blanking the window.

## Sending a change

```bash
npm test                 # 29 contract tests, no network needed
node --check lib/client.js
node --check lib/index.js
npm pack --dry-run       # should stay around 10 files
```

Guidelines:

- **No runtime dependencies.** The plugin ships two files; adding a dependency multiplies the install
  surface for everyone.
- **No `process.platform` branches.** Paths come from `new URL(import.meta.url)` or the host's
  `dshHomePath()`; anything else breaks the other OS.
- **Keep the host and client halves apart.** The host answers three JSON routes and never renders; the
  client never reads files.
- **New user-facing strings go in both languages** (`T` in `lib/client.js` and `locale/{zh,en}.json`).
- **Numbers need a source.** If you touch cost or occupancy, say in the PR which projection field it
  comes from and why it is more accurate than the alternative.

## Commit messages

`type(scope): summary` in the imperative, e.g. `fix(panel): stop re-rendering the graph on hover`.
Keep the body for *why*, not *what* — the diff already says what.

## Release

1. `npm test`
2. Bump `version` (semver), update the changelog section in the release notes
3. `npm pack --dry-run` — confirm file count and size
4. `npm publish`
5. Tag `vX.Y.Z` and push, then create the GitHub release with the same notes

## License

MIT. By contributing you agree your work is released under the same license.
