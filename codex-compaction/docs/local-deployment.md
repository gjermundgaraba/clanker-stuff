# Local deployment contract

This package is approved only for a controlled local Pi 0.83.0 deployment where its resolved `index.ts` is the final enabled extension. The audit rejects every other Pi version.

1. Add the package path as the last global `packages` entry in `PI_CODING_AGENT_DIR/settings.json`.
2. Run `node audit-local-order.ts [cwd]` from this package.
3. Restart or reload Pi, then rerun the audit.

The audit uses Pi's public resource loader, includes trusted project settings, rejects extension diagnostics, verifies reload stability, compares both its SDK and the `pi` executable on `PATH` to 0.83.0, and fails unless this package is exactly last.

Rerun it after any global or project settings change, package addition or reorder, extension-path change, or Pi upgrade. A later global package invalidates the contract until the package is restored to the final resolved position and the audit passes.

This procedure is an external operational check, not an in-package ordering guarantee. General discovery and npm publication remain unsupported until Pi provides exclusive terminal hook ownership.

See the [current design](design.md) for request, replay, and checkpoint invariants.

Fail-closed context-framing errors append a redacted `codex-compaction.diagnostic` entry to the session. It contains only counts, hashes, message shapes, and the first mismatch location; provide the session ID when reporting the failure.

See [context alignment](context-alignment.md) for the persisted-versus-live retry invariant and fail-closed matching rules.

Before and after Pi/provider upgrades, run the opt-in [live multi-compaction canary](live-canary.md).

The private checkpoint format is v4. Earlier checkpoints are intentionally unsupported; start a new session or branch before an earlier checkpoint after upgrading. V4 replacements are text-only: images are available to the live request that triggered inline compaction but persist only as omission text.
