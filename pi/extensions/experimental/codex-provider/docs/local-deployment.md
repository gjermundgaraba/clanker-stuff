# Local deployment contract

This package is approved only for a controlled installation matching the repository’s pinned and validated Pi SDK, where its resolved `index.ts` is the final enabled extension. The [workspace catalog](../../../../../pnpm-workspace.yaml) owns the dependency baseline. The provider runtime is always on. Run the audit from this repository after installing its locked dependencies and passing `vp run ready`; matching an arbitrary SDK installation does not establish support.

1. Add the package path as the last global `packages` entry in `PI_CODING_AGENT_DIR/settings.json`.
2. From this repository, run `node pi/extensions/experimental/codex-provider/audit-local-order.ts [cwd]`.
3. Restart or `/reload` Pi, then rerun the audit.

The audit uses Pi's public `SettingsManager` and `DefaultResourceLoader`, includes trusted project settings, rejects extension diagnostics, resolves twice to verify reload stability, and requires this package's canonical `index.ts` exactly once and last. It requires the `pi` executable on `PATH` to exactly match the imported SDK’s `VERSION`. There is no separately maintained supported-version literal.

Privacy warning: Radius-backed `/share` uploads the full system prompt and every active tool's name, description, and schema.

Rerun the audit after:

- any global or project settings change;
- any package addition, removal, or reorder;
- any extension-path change or `/reload`;
- any Pi upgrade or executable change.

A later package invalidates the contract until this package is restored to the final resolved position and the audit passes. This is an external operational check, not an in-package ordering guarantee; general discovery and npm publication are unsupported.

## Runtime and recovery

Loading the extension always registers its complete `openai-codex` provider. There is no built-in-provider or replay-only switch. Do not co-load another package that registers the same provider or competes for `context`, `context_with_system`, `before_provider_headers`, `before_provider_request`, or `session_before_compact` ownership. Full-transcript `context_with_system` handlers run after ordinary `context` handlers regardless of extension load order; being loaded last does not bypass that second phase.

New lifecycle checkpoints are Pi `CompactionEntry` records with `details.type: codex-provider.checkpoint`; inline checkpoints are `CustomEntry` records with `customType: codex-provider.checkpoint`. Both use schema `clanker.codex-provider/checkpoint`, version `1`. Earlier local checkpoint namespaces and versions are unsupported; start a new session or branch before an old checkpoint after upgrading. Persisted replacements omit image bytes and carry provider window and model-compatibility state.

Native compaction failure leaves the active branch unchanged. An incompatible provider cannot replay an opaque lifecycle checkpoint.

Fail-closed alignment errors write a best-effort observation to `data/codex-provider/codex-provider.sqlite` under Pi's agent directory. It contains counts, hashes, message shapes, and the first mismatch location only; provide the session ID when reporting a failure.

Before and after any Pi or provider change, run the package tests and the [live multi-compaction canary](live-canary.md). After changing extension order, provider tools, or Code Mode, also run the installed-environment canary. See [design](design.md) for the runtime contract and [context alignment](context-alignment.md) for replay failure rules.
