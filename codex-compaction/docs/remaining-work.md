# Historical Phase 5 gap assessment

> Archived planning record. It preserves the constraints identified during Phase 5 but does not define current work and does not recommend changes to Pi. Current behavior and operations are documented in [design.md](design.md) and [local-deployment.md](local-deployment.md).

## Historical decision

**GO for the audited local deployment in `phase-five-results.md`. NO-GO for general discovery or npm publication.** Pi 0.83.0 still provides only load-order chaining, so the local contract depends on an external audit proving this package is the final resolved extension.

The audit must be rerun after settings or package changes, extension reload, and Pi upgrades. Adding or reordering a later global package invalidates the local approval until the audit passes again.

## General-release conditions recorded at Phase 5

1. **Obtain terminal hook ownership in Pi.**
   - Implement the minimal public API in `pi-hook-priority-proposal.md`, or an equivalent contract that is enforceable across initial discovery and reload.
   - Re-run the executable adversarial order tests against that API.
   - Do not substitute package-list conventions, deferred registration, `session_start`, or `resources_discover`; Phase 4 proves none is a terminal guarantee.

2. **Complete general release validation after terminal ownership exists.**
   - Keep private workspace validation separate from public discovery, the root catalog, and publication.
   - Expand package-local behavior and recovery documentation beyond the current local deployment contract.
   - Run pinned request/replacement fixtures against the selected Pi/Codex revisions.
   - Run `pnpm check:all`, `pnpm check:readmes`, all unit/integration/smoke projects, package-scoped Ultracite/Oxfmt, and repository typecheck.
   - Repeat isolated installed-package manual, threshold, overflow, resume, branch, model-switch, cancellation, and malformed-state flows against the terminal API.

## Capability gaps recorded at Phase 5

### 1. Terminal ownership

**Unavailable capability:** unique public terminal registration for `context`, `before_provider_request`, `before_provider_headers`, and `session_before_compact`. Numeric normal-handler priority was not required. The archived design is in `pi-hook-priority-proposal.md`. The extension needs proof that no later handler can mutate validated input, remove the feature header, or replace its compaction result.

**Accepted local operational constraint:** load this extension last among all context, payload, header, and compaction mutators and run `audit-local-order.ts`. The current global package path is last and the loader/reload audit passes. Package order remains a convention, so this approval is local-only and general discovery remains NO-GO.

### 2. Raw provider output across transports

**Unavailable capability:** raw Responses output items or a provider-owned compaction result callback for SSE and WebSocket transports.

**Current constraint:** side compaction forces SSE and observes a cloned `Response`; normal requests retain Pi's configured transport. No direct HTTP client or provider override should be added to work around this.

### 3. Active request and transport settings

**Unavailable capability:** resolved active transport, timeout/idle-timeout, service tier, verbosity, max output, cache/retry policy, constrained-sampling metadata, client metadata, and later payload/header mutations for lifecycle compaction.

**Current constraint:** inline compaction inherits the finalized envelope, while cold manual/Pi-threshold/overflow compaction can preserve only public registered-provider options. No guessed defaults or hardcoded timeout should be introduced.

### 4. Atomic state installation and continuation

**Unavailable capability:** a transaction that atomically installs checkpoint state, replaces active agent/session history, accounts usage, and continues or aborts the pending provider request. A rollback API for failed post-append verification was the minimum smaller primitive considered.

**Current constraint:** `appendEntry()` is synchronous and verifiable, but append plus payload continuation is not atomic. An entry may already be durable when verification fails; the current request aborts, but public APIs cannot roll the entry back. Exact Codex-style world-state/history replacement is unavailable.

### 5. Token, usage, and effective-window metadata

**Unavailable capability:** server-accurate finalized-input tokens, model effective-context percentage, compaction-window metadata, and a supported way to add inline side-request usage to session totals.

**Current constraint:** the extension uses the pinned UTF-8/4 plus image estimate, model `contextWindow`, fixed 90%/95% policy, and stores side usage only in checkpoint metadata. Fresh provider usage is a lower bound, not an exclusive replacement.

### 6. Stable finalized-input provenance

**Unavailable capability:** finalized input spans or stable item provenance for replacing Pi baseline history without temporary user markers.

**Current behavior:** Phase 4 measures the serializer effect exactly: one start marker shifts framed fallback IDs by `+1`, and start plus end markers shift suffix fallback IDs by `+2`. The extension uses Pi's exported serializer to build the marker-free ID map, rewrites only exact `msg_pi_*` fallback IDs, removes the current nonce markers with no replacement, and requires the entire canonical Responses input to equal marker-free serialization. Active structural mismatch fails closed. No-checkpoint threshold framing falls back to the exact finalized unframed candidate path. Native IDs, reasoning IDs, metadata, ordering, and real tool linkage remain untouched; synthetic tool outputs are rejected.

## Optional parity improvements versus current Codex

- Reuse Codex turn-scoped transport/session state, cached WebSocket continuation, `previous_response_id`, installation/thread/turn metadata, and `comp_hash` when public APIs eventually expose them.
- Match server tokenizer counts and dynamic original-image accounting instead of the conservative fixed estimator.
- Reconstruct Codex world-state reinjection and compaction-window IDs more closely after Pi exposes stable history replacement.
- Preserve every cold-request field and transport retry/cache nuance once active request options are public.
- Add broader provider-response fixtures for future Codex event variants and transport implementations after the pinned baseline is stable.
- Compare performance and cache behavior for long repeated replay; optimize canonical matching only if measurements justify it.

These are parity improvements, not reasons to add a direct client, duplicate serializer, provider override, or private import.

## Already complete; no more abstraction needed

- Strict checkpoint schema, migration boundary, canonical hashing, identity matching, and newest-boundary resolution.
- Conservative corrupt-inline provenance and fail-closed native lifecycle handling.
- Registered-provider lifecycle compaction for manual, Pi threshold, and one-retry overflow.
- Strict cloned-SSE compaction collection, response-ID agreement, bounded retries, cancellation, and no textual fallback.
- Canonical retained users plus exactly one opaque item, image modality safety, tool-history repair, and 95% trailing-output shrink.
- Exact-current-nonce framing, semantic baseline matching, prefix/suffix preservation, and opaque replay without local markers.
- Threshold decisions using `max(valid fresh usage, finalized estimate)`, including exact 90% and 95% boundaries.
- Pre-replay and pre-inline checks for generation, request state, model, leaf, branch, active source, immutable input, and post-network freshness.
- Inline persistence verification, repeated replacement, resume/branch replay, pre-sampling/tool-loop timing, and overflow retry replay.
- Case-insensitive feature-header merging and provider-envelope preservation.
- Exact non-Codex no-op behavior with no active native checkpoint.
- Unframed below-threshold candidates that re-evaluate the full finalized envelope, compact a payload-only 90% crossing, preserve non-input fields, persist before continuation, replay later, and leave below-threshold payloads byte-identical.
- Whole-input marker-free structural parity using Pi's exported serializer, including exact `+1` framed and `+2` suffix fallback-ID correction, tool-pair safety, collision-safe failure, active fail-closed behavior, and no-checkpoint unframed fallback.
- Private local package surface with only the combined default factory, public Pi peers, explicit tarball files, matching MIT license, concise README, and local deployment contract.
- Strict checkpoint entry renderer that exposes only model, phase/reason, token estimates, and aggregate usage.
- Source discovery, packed production-peer installation, tarball allowlist, and trusted project-order audit coverage.
- Actual local loader audit: 23 resolved extensions, stable reload order, target final.
- Shared lifecycle/inline generation, abort controller, in-flight slot, status, and notifications.

Do not add factories, adapters, configuration objects, or a second state layer around these completed behaviors.

## Archived next-phase recommendation

The Phase 5 record recommended the following sequence. It is retained only as historical evidence and is not current repository policy:

1. Rerun the local audit after every relevant settings/package change, reload, and Pi upgrade.
2. Implement or obtain the public Pi terminal-hook API in `pi-hook-priority-proposal.md`.
3. Only after terminal ownership passes, add public discovery/catalog wiring and consider general publication.

**Historical GO:** the audited local deployment and Pi API work. Only the audited local deployment remains current.

**NO-GO:** general discovery, npm publication, or portable load-order claims on Pi 0.83.0.
