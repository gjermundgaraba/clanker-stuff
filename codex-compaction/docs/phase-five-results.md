# Phase 5 results

> Historical phase-gate snapshot. Its package contents, extension counts, and test totals record Phase 5 and are not current status. See [design.md](design.md) and [local-deployment.md](local-deployment.md) for the current contract.

## Decision

**GO for this controlled local Pi 0.83.0 deployment.**

**NO-GO for general discovery or npm publication until Pi provides exclusive terminal hook ownership.**

The local contract is external: the complete resolved extension set must be audited after settings/package changes, after reload, and after Pi upgrades. Adding or reordering a later global package invalidates approval until the target is restored to the final resolved position and the audit passes.

## Package surface

The private local package now provides:

- `@clanker-extensions/codex-compaction` with Node `>=24`, public Pi peers, repository metadata, and `pi.extensions`.
- One package export: the combined production `codexCompactionExtension` default factory.
- Explicit production files; reports, spike code, research, tests, sessions, and synthetic encrypted fixtures are excluded.
- The repository MIT license and a README conforming to `docs/readme-style.md`.
- `docs/local-deployment.md` with the required rerun conditions.

The public Responses serializer is reached through the package `imports` map so Pi's Jiti compatibility alias cannot redirect the public subpath to the root compatibility entrypoint. No private path is imported or hardcoded.

## Checkpoint renderer

Only the combined production factory registers the `codex-compaction.checkpoint` entry renderer.

It strictly calls `parseCheckpoint`. Valid entries display only:

- Model.
- Phase and reason.
- Source and replacement token estimates.
- Aggregate usage when present.

Malformed entries render nothing. The renderer never displays encrypted content, replacement history, raw checkpoint data, hashes, origin session ID, response ID, or compaction item ID.

## Local order audit

`audit-local-order.ts` uses public `SettingsManager` and `DefaultResourceLoader` APIs. It:

1. Resolves the requested cwd and `PI_CODING_AGENT_DIR` (default `~/.pi/agent`) with trusted project settings.
2. Rejects extension loading diagnostics.
3. Resolves twice and requires identical reload order.
4. Requires the canonical package `index.ts` exactly once and last.
5. Prints the resolved count and final path.

Before installation, the independently repeated baseline was 22 extensions with no diagnostics.

After appending `../../code/priv/clanker-extensions/codex-compaction` as the final global package, both initial load and reload resolve:

```text
Resolved 23 extensions
Final extension: /Users/gg/code/priv/clanker-extensions/codex-compaction/index.ts
```

### Sensitive hook registrations

All 23 loaded extension registrations were inspected through the public loader result:

| Position | Extension | Sensitive hooks |
| --- | --- | --- |
| 2 | `tools/index.ts` | `before_provider_headers`, `before_provider_request` |
| 6 | `codex-fast/index.ts` | `before_provider_request` |
| 23 | `codex-compaction/index.ts` | `context`, `before_provider_headers`, `before_provider_request`, `session_before_compact` |

No other resolved extension registers any of the four sensitive hooks. The two compatible non-target mutators are top-level entries and run before the target.

A temporary trusted project fixture with one project top-level extension and one project package resolves both before the global codex-compaction package; the target remains final across reload. This is evidence for the current Pi behavior, not a guarantee for future configuration.

## Tarball gate

The packed artifact contains exactly 11 files:

- `LICENSE`, `README.md`, `package.json`.
- `index.ts`, `checkpoint.ts`, `lifecycle.ts`, `remote.ts`, `renderer.ts`, `replay.ts`.
- `audit-local-order.ts`, `docs/local-deployment.md`.

The smoke test installs that tarball with production Pi peers and loads it through `DefaultResourceLoader`. No report, spike, research, test, session, or fixture file is present.

## Validation

Final validation:

- Unit: 39 tests across 7 files.
- Integration: 36 tests across 4 files.
- Smoke: 2 tests across 1 file.
- Repository TypeScript check: passed.
- Test/boundary check: passed.
- Package-directory Ultracite: passed.
- Package-directory Oxfmt, including Markdown: passed.
- README contract: passed by package-local manual validation.
- `npm pack --dry-run`, exact tar contents, and isolated production-peer load: passed.
- Actual local loader and reload order audit: passed with 23 extensions and the target final.
- Private-import and trailing-whitespace checks: passed.

No repository root package/workspace/catalog/README file, dependency lockfile, direct HTTP client, provider override, session JSONL, unrelated dirty file, or commit was changed.

## Operational rule

Run:

```bash
node codex-compaction/audit-local-order.ts /Users/gg/code/priv/clanker-extensions
```

after every relevant settings/package change, after `/reload`, and after every Pi upgrade. General publication remains blocked until `onTerminal` or an equivalent exclusive public contract exists.
