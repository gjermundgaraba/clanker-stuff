# Local deployment contract

This package is approved only for a controlled Pi 0.83.0 installation where its resolved `index.ts` is the final enabled extension. The provider runtime is always on, and the audit rejects every other Pi SDK or executable version.

1. Add the package path as the last global `packages` entry in `PI_CODING_AGENT_DIR/settings.json`.
2. From this repository, run `node codex-provider/audit-local-order.ts [cwd]`.
3. Restart or `/reload` Pi, then rerun the audit.

The audit uses Pi's public `SettingsManager` and `DefaultResourceLoader`, includes trusted project settings, rejects extension diagnostics, resolves twice to verify reload stability, and requires this package's canonical `index.ts` exactly once and last. It compares both the imported SDK and the `pi` executable on `PATH` with `0.83.0`.

Rerun the audit after:

- any global or project settings change;
- any package addition, removal, or reorder;
- any extension-path change or `/reload`;
- any Pi upgrade or executable change.

A later package invalidates the contract until this package is restored to the final resolved position and the audit passes. This is an external operational check, not an in-package ordering guarantee; general discovery and npm publication are unsupported.

## Runtime and recovery

Loading the extension always registers its complete `openai-codex` provider. There is no built-in-provider or replay-only switch. Do not co-load another package that registers the same provider or competes for `context`, `before_provider_headers`, `before_provider_request`, or `session_before_compact` ownership.

New checkpoints use only custom type `codex-provider.checkpoint`, schema `clanker.codex-provider/checkpoint`, version `1`. Earlier local checkpoint namespaces and versions are unsupported; start a new session or branch before an old checkpoint after upgrading. Persisted replacements omit image bytes and carry provider window and model-compatibility state.

Set `CLANKER_CODEX_COMPACTION_FAILURE` to `ask`, `fallback`, or `cancel` when the default interactive choice is unsuitable. Invalid values warn once and behave as `ask`. This changes only failure handling after readable summary generation; it does not disable provider ownership.

Fail-closed alignment errors append a redacted `codex-provider.diagnostic` entry. It contains counts, hashes, message shapes, and the first mismatch location only; provide the session ID when reporting a failure.

Before and after any Pi or provider change, run the package tests and the [live multi-compaction canary](live-canary.md). See [design](design.md) for the runtime contract and [context alignment](context-alignment.md) for replay failure rules.
