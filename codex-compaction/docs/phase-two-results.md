# Phase 2 results

> Historical phase-gate snapshot. Its file list, validation counts, limits, and next steps describe Phase 2 only. See [design.md](design.md) for current behavior.

**Decision: GO for Phase 3; NO-GO for discovery or release.** The registered-provider lifecycle path now handles manual, Pi threshold, and overflow compaction. Normal-request opaque replay remains intentionally absent.

## Files changed

- `lifecycle.ts` — lifecycle-only hook registration, full active-source construction, registered-provider execution, bounded retries, stale-state checks, checkpoint/result construction, status, and install verification.
- `replay.ts` — added pure Pi-compatible unsupported-user-image omission.
- `remote.ts` — added typed, body-free SSE failure categories for safe retry decisions.
- `tests/lifecycle.test.ts` — lifecycle execution and construction unit tests.
- `tests/lifecycle.integration.test.ts` — real `AgentSession` lifecycle tests.
- `tests/replay.test.ts` — added supported/unsupported image modality coverage.
- `tests/agent-session.ts` — added test-only compaction-settings injection.
- `phase-two-results.md` — this handoff record.

No extension entry point, package manifest, README, discovery wiring, normal request hook, direct HTTP client, provider override, or session-file mutation was added.

## Verified behavior

- Activation is exact to `openai-codex` + `openai-codex-responses`; unsupported model routes are left untouched. A nonblank resolved `apiKey` is required because the registered Codex `streamSimple()` contract does not accept an Authorization header as a substitute. Missing auth cancels before provider invocation.
- The selected provider and auth are resolved at attempt time. The side request receives the current model, full active branch context, system prompt, active tool schemas, thinking level, session ID, resolved env, lifecycle signal, and forced SSE transport.
- The provider-built envelope is preserved. Only `input` is replaced by normalized/shrunk effective history plus one final trigger. Existing beta features from resolved, model, and provider headers are retained when `remote_compaction_v2` is added.
- Provider retries are zero. This layer performs at most three attempts with abort-aware 500/1,000 ms delays. Network/premature-stream, 408, 409, and 5xx failures retry; auth, cancellation, 429, provider policy errors, and malformed output do not.
- Success requires both Pi provider `stop` completion and cloned raw SSE completion, a nonempty provider response ID exactly equal to the raw response ID, and exactly one valid canonical compaction item. Missing/mismatched IDs are invalid non-retryable output. Assistant text is never used as checkpoint state.
- Checkpoints contain strict identity, reason/phase, response usage, source and replacement hashes, estimated tokens, shrink count, fixed policy, proven branch users, and one new opaque item. Tests confirm request source, auth, headers, and raw events are absent from persistence.
- One lifecycle operation is shared only for the same operation key. Generation, model identity, leaf, active-branch hash, system prompt, active tool names/schemas, thinking level, and signal are rechecked before success. Request-state identity is canonically hashed into the operation key. Shutdown/model/session/request-state changes abort or stale-discard the result.
- Manual success persists strict lifecycle details and reloads the local marker. The checkpoint remains resolvable after resume and branch navigation.
- Pi threshold compaction installs the extension lifecycle result with `fromHook: true`. Remote failure returns `cancel: true`, performs no textual fallback, and leaves branch IDs unchanged.
- Overflow success installs the checkpoint and Pi performs exactly one retry. The integration fixture observes one failed normal call, one side compaction, and one normal retry.
- `session_compact` ignores Pi 0.83.0's potentially stale repeated-summary event entry ID. It resolves the newest active lifecycle checkpoint from the current branch and verifies generation, expected response ID, and replacement hash. A real two-compaction regression proves the second repeated marker is accepted and its newest response is authoritative.
- A corrupt active lifecycle-carried checkpoint remains fail-closed. A corrupt inline checkpoint is ignored only when its nearest earlier Pi compaction boundary is absent or is an ordinary Pi compaction with an authoritative human-readable summary. A nearest earlier native lifecycle checkpoint blocks fallback because its summary is only the encrypted marker. The code never scans backward to replay an older native checkpoint.
- Unsupported user images are replaced with Pi's exact non-vision placeholder before side-request normalization and checkpoint retention. Base64 payloads are neither sent nor retained; supported images remain unchanged.

## Public API gaps and phase boundary

Cold lifecycle requests preserve fields exposed by Pi's registered provider: model, instructions, serialized context, tools, reasoning effort, provider defaults, prompt-cache/session ID, resolved auth/account headers, provider env, and public model/provider headers.

Pi 0.83.0 does not expose the active normal request's resolved `service_tier`, caller-selected verbosity, `client_metadata`, max-output field, cache/retry settings, timeout, constrained-sampling tool metadata, or later extension payload/header mutations. These values cannot be copied safely on cold lifecycle compaction.

No hardcoded request or idle timeout was added. The lifecycle path can honor the public compaction abort signal, but Pi does not expose the active normal request's timeout/idle-timeout policy for reuse by this cold side request.

Two deliberate phase limits remain:

1. After lifecycle installation, Pi's context contains only the local marker. Overflow immediately retries, so that retry cannot send the opaque item until Phase 3 adds finalized normal-request replay. The integration test proves Pi's one-retry control flow, not safe model-visible replay. No new Pi API is required: Phase 3's public `context`/`before_provider_request` path is the smallest fix. This is why the lifecycle factory is not discoverable yet.
2. `session_compact` fires after Pi persists and reloads the entry. Public APIs allow verification and notification but not rollback. Atomic post-install rejection would require a Pi compaction transaction/rollback API; strict pre-return construction makes this a verification gap rather than a reason to mutate JSONL.

Phase 3 must apply the same corrupt-inline provenance rule during replay: no/ordinary prior Pi compaction permits local fallback, while a prior native lifecycle boundary remains fail-closed.

For manual compaction Pi's general agent signal is already aborted before the lifecycle hook. The implementation correctly uses `SessionBeforeCompactEvent.signal`, which is the public live compaction signal.

## Commands

```sh
pnpm test:unit codex-compaction
pnpm exec vitest run --project integration codex-compaction/tests
pnpm exec ultracite check codex-compaction/checkpoint.ts codex-compaction/replay.ts codex-compaction/remote.ts codex-compaction/lifecycle.ts codex-compaction/spike.ts codex-compaction/tests
pnpm exec oxfmt --check codex-compaction/checkpoint.ts codex-compaction/replay.ts codex-compaction/remote.ts codex-compaction/lifecycle.ts codex-compaction/spike.ts codex-compaction/tests codex-compaction/phase-two-results.md
pnpm typecheck
pnpm check:tests
```

Unit: 23 passed across 5 files, including 9 Phase 2/review tests. Integration: 9 passed across 2 files, including 7 lifecycle tests. Smoke was not applicable because there is still no package/discovery entry point.

## Phase 3 gate

**GO:** add fail-closed context framing and finalized normal-request replay, then prove pre-sampling/tool-loop timing and that no lifecycle marker reaches the provider. Do not expose the lifecycle factory through discovery before those tests pass.
