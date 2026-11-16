## What this changes

<!-- One paragraph. What the user sees differently. -->

## Why

<!-- The bug or gap. Link the issue if there is one. -->

## Checks

- [ ] `npm test` passes (29 contract tests)
- [ ] `node --check lib/client.js` and `node --check lib/index.js`
- [ ] `npm pack --dry-run` still reports ~10 files
- [ ] No new runtime dependency
- [ ] New user-facing strings exist in both `zh` and `en`
- [ ] README updated if a capability changed (not for internal refactors)
- [ ] Screenshot included for visual changes

## Notes for the reviewer

<!-- Anything subtle: a projection field that may be missing on older hosts, a layout
     that only breaks under 900px, etc. -->
