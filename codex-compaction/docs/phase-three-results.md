# Phase 3 results

> Historical phase-gate snapshot. Its file list, validation counts, limits, and next steps describe Phase 3 only. See [design.md](design.md) for current behavior.

**Decision: implementation PASS; release remains blocked.** Framed normal-request replay, pre-provider inline compaction, and lifecycle retry replay work through public Pi 0.83.0 APIs. Discovery/package wiring remains intentionally absent because load-last ordering is not guaranteed.

## Files changed

- `replay.ts` — nonce-bearing context markers, exact contiguous baseline framing, strict finalized-marker extraction, prefix/suffix-preserving replay, and finalized token estimates.
- `checkpoint.ts` — shared conservative corrupt-inline fallback policy used by lifecycle and replay.
- `lifecycle.ts` — combined lifecycle/replay factory, normal-request header mutation, finalized envelope validation, 90% inline compaction, persistence verification, race checks, and fail-closed cancellation.
- `tests/replay.test.ts` — pure framing, marker, replay, token, and modality cases.
- `tests/lifecycle.test.ts` — finalized decision, payload validation, feature merge, stale usage, and install-verification cases.
- `tests/lifecycle.integration.test.ts` — real `AgentSession` timing, replay, overflow, repeated replacement, resume/branch, ordering, and failure coverage.
- `tests/agent-session.ts` — test-only model and system-prompt injection.
- `phase-three-results.md` — this handoff record.

No package manifest, production entry point, command, discovery wiring, direct HTTP client, provider override, private Pi import, session-file rewrite, new dependency, or commit was added.

## Finalized replay and framing

- The combined `codexCompactionExtension` retains Phase 2 lifecycle hooks and adds `context`, `before_provider_request`, and `before_provider_headers`.
- Activation remains exact to provider `openai-codex` and API `openai-codex-responses`.
- `context` reconstructs Pi's public branch baseline and requires that sequence exactly once inside earlier handlers' context result. Baseline equality uses canonical JSON object ordering while retaining strict values and array order. Fresh prefix/suffix mutations are preserved. Overflow retry also handles Pi's public removal of a trailing failed assistant.
- Random UUIDv7 start/end markers frame either the full Pi baseline or only the live tail after an active checkpoint. Markers are ephemeral and never persisted.
- The finalized Responses envelope must be an object for the current model with `stream: true`, `store: false`, an object-only `input` array, and no existing compaction trigger.
- Exactly one start and one end marker for the current nonce must occur in order. Missing, reversed, or duplicate current markers call `ctx.abort()` before provider fetch. Malformed prefix-like user text and exact markers for other nonces are unrelated input and remain untouched.
- Normal replay removes Pi's local marker/baseline and inserts the active canonical replacement exactly once. Earlier context-handler prefix/suffix items remain around it.
- Corrupt or incompatible inline state falls back only when no prior Pi compaction exists or the nearest prior Pi compaction is ordinary authoritative text. A prior native lifecycle boundary remains fail closed. Lifecycle-carried corruption/incompatibility is always blocked.
- Exact provider/API/model/normalized-base-URL compatibility remains mandatory.

## Inline compaction and timing

- When Pi's public context usage indicates the 90% threshold may be reached, the finalized payload is framed and measured with the pinned UTF-8/4 plus 7,373-byte image policy.
- Fresh compatible assistant usage is accepted only after the active boundary and is a lower bound: threshold and effective-window decisions use `max(freshUsageTokens, estimatedTokens)`. `usedFreshUsage` is true only when fresh usage is strictly larger.
- Triggering occurs at `>= 90%` of the model context. Tool outputs are normalized and trailing outputs are shrunk against the 95% effective window before the side request.
- The registered provider builds and executes the side request. The finalized normal envelope is cloned, only `input` is changed, and exactly one final `compaction_trigger` is added.
- The side request is completed before the pending normal provider request. A strict inline checkpoint is appended and synchronously resolved by response ID, replacement hash, parent leaf, and newest-boundary position.
- The pending request continues with fresh prefix, the new replacement, and fresh suffix. It never sends the local lifecycle marker or trigger.
- Real `AgentSession` tests prove compaction before first sampling and between a tool result and the next model call. Checkpoint phase is respectively `pre-sampling` and `mid-turn`.
- Repeated inline compaction replaces the old opaque item. The newest replacement replays once after resume and after public tree navigation to the checkpoint boundary.
- Manual lifecycle replay and Pi's one-retry overflow path now send the opaque item instead of the local marker. Overflow persists one Pi compaction and performs one normal retry.

## Request and race safety

- The normal request envelope is unchanged when no checkpoint is active and Pi usage is below threshold. A real comparison proves byte-identical request bodies.
- Existing finalized fields such as `service_tier` and `client_metadata` are preserved on both inline side and pending normal requests.
- Existing `x-codex-beta-features` values are merged case-insensitively. `remote_compaction_v2` is present once on supported normal and side requests, without changing unrelated headers.
- One state object shares the lifecycle/inline in-flight slot, generation, and shutdown controller. The direct provider call bypasses extension hooks and cannot recurse.
- Before replay-only return or inline network start, current leaf ID, branch hash, and framed source must still match the frame captured in `context`. An earlier payload handler's branch mutation is proven to abort with zero normal fetches.
- Before persistence, the implementation rechecks generation, signal, leaf, branch hash, active boundary, model identity, system prompt, active tool names/schemas, thinking level, immutable finalized input hash, and framed source hash.
- Remote failure, invalid current markers, incompatible identity, corrupt native state, request/branch mutation, and failed append verification all abort the pending normal request. No unsafe local-summary or normal-provider fallback occurs.
- The append-verification fixture demonstrates the public Pi limitation precisely: an append may already be durable when verification fails, but the pending request is aborted and the unverified state is never returned to that provider call. Pi exposes no append rollback transaction.

## Real-session proofs

The Phase 3 integration suite covers:

1. Unchanged body bytes plus case-insensitive feature merging, and a no-op non-Codex route.
2. Duplicate current markers, stale request/branch, replay races, append verification, remote failure, incompatible identity, and corrupt-after-native fail-closed paths.
3. Preservation of unrelated malformed/stale marker-like text.
4. Manual and overflow replay, pre-sampling/tool-loop timing, repeated replacement, resume, and branch replay.

All retained Phase 0–2 unit and integration tests remain green.

## Public API and release boundary

Implementation imports only public exports from:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-ai/api/openai-responses-shared`
- `@earendil-works/pi-coding-agent`

Behavior remains pinned to Pi `845d6ff1f6643aba440341cce877ce1c43ebbc39` (`0.83.0`) and Codex `6219b7c40fc9c702c0aef9964e72b492558f60e4`.

The immediate release blocker remains unsolved: Pi exposes no handler-order introspection or priority. This extension must load last among context, payload, header, and compaction mutators so no later handler can alter the finalized source after validation or remove the feature header. No discovery wiring was added because the repository cannot currently enforce that invariant.

Cold lifecycle requests retain the Phase 2 fidelity gaps for caller verbosity, `client_metadata`, service tier, max-output/cache settings, constrained-sampling metadata, and later extension mutations that Pi does not expose before a normal request exists. Inline requests preserve those fields from the finalized envelope.

No hardcoded timeout or idle timeout was invented. Public abort signals are propagated, but Pi 0.83.0 does not expose the normal request's resolved timeout/idle-timeout policy for side-request reuse.

Two limits narrow the finalized-request claim:

- With no active checkpoint, framing is gated by public `ctx.getContextUsage()`. A payload-only mutation can push finalized input above 90% after a below-threshold context event, so that request is not framed or compacted by this extension. The 90% decision is exact only for requests that reached the framing path.
- Active-checkpoint framing inserts temporary user messages before Pi serialization. Although those markers are removed before transport, their positions can change serializer-generated fallback assistant IDs. Pi exposes no finalized-input provenance API that would avoid the temporary messages.

See `remaining-work.md` for the historical release-gap classification.

## Validation

```sh
pnpm exec vitest run --project unit codex-compaction
pnpm exec vitest run --project integration codex-compaction
pnpm exec ultracite check codex-compaction
pnpm exec oxfmt codex-compaction --check
pnpm typecheck
pnpm check:tests
```

Unit: 28 passed across 5 files. Integration: 24 passed across 2 files. Smoke remains not applicable because release/discovery wiring is deliberately absent.

## Gate

**NO-GO for package discovery or release.** The next phase must resolve or formally constrain handler ordering, close the release gaps in `remaining-work.md`, and add package/install smoke coverage before discovery.
