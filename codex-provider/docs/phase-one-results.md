# Phase 1 results

> Historical phase-gate snapshot. Its checkpoint v1 and image-retention claims, file list, validation counts, and next steps were superseded by private checkpoint v4. See [design.md](design.md) for current behavior.

**Decision: GO for Phase 2.** The pure protocol core is implemented and no Pi hooks, provider execution, lifecycle compaction, extension entry point, or discovery wiring was added.

## Files changed

- `checkpoint.ts` — strict immutable `CheckpointV1` parsing, canonical JSON and SHA-256, identity compatibility, and active-branch boundary resolution.
- `replay.ts` — retained-user replacement, Unicode-safe truncation, token/window policy, deterministic tool repair, and trailing-output shrinking.
- `remote.ts` — reusable cloned-response SSE observation and strict compaction collection.
- `spike.ts` and `tests/phase-zero.test.ts` — moved the Phase 0 observer into `remote.ts`; retained only spike fixtures in `spike.ts`.
- `tests/checkpoint.test.ts`, `tests/replay.test.ts`, and `tests/remote.test.ts` — Phase 1 unit coverage.
- `phase-one-results.md` — this validation and handoff record.

## Verified invariants

- `CheckpointV1` rejects unknown fields, unsupported versions, malformed identity/timestamps/numbers/hashes, non-canonical replacement shapes, forbidden item types, bad compaction cardinality/order/content, and unrecognized metadata. Parsed output is a frozen clone.
- Replacement integrity is recomputed from canonical JSON. Provider, API, model, and normalized base URL must match exactly.
- The latest inline checkpoint or Pi compaction boundary on the supplied branch wins. A later ordinary Pi compaction disables older native state; corruption is returned at the latest boundary without scanning backward.
- Replacement history contains only caller-proven canonical user items, newest within 64K UTF-8/4 tokens, plus exactly one final new compaction item. The pinned Codex middle marker, Unicode boundaries, image preservation, image-only minimum cost, chronological order, and repeated compaction are covered.
- Token estimates include instructions and JSON structure, saturate at `Number.MAX_SAFE_INTEGER`, charge 7,373 fixed bytes per image instead of base64 length, trigger at `>= 90%`, and exceed the effective window only above 95%.
- Tool normalization removes orphan and duplicate supported outputs, inserts stable UUIDv5 `"aborted"` outputs immediately after unmatched calls, and is idempotent while preserving existing item identity/order/metadata.
- Shrinking rewrites only a recognized contiguous output suffix newest-first, preserves fields and success state, uses the pinned truncation marker or an empty tool-search array, stops at the first non-output, and reports its count.
- SSE handling covers split UTF-8 and syntax chunks, LF/CRLF, multiline `data:`, aliases, extra output items, terminal success/error, exactly-one compaction validation, premature close, HTTP errors, and cancellation.

## Design corrections and limits

- `replacementSha256` is recomputed during parsing. `sourceSha256` can only be syntax-validated because source history is deliberately not persisted; Phase 2/3 must compare it when source input is available.
- Retention accepts an explicit list of caller-proven user items. The core does not infer real users from text or role alone; branch-to-item provenance remains Phase 3 work.
- The fixed 7,373-byte image estimate follows the pinned Codex resized-image constant. Dynamic `"original"` image decoding was intentionally not copied: it needs image decoding and contradicts this phase's fixed-estimate requirement.
- Duplicate outputs use deterministic first-wins cleanup. Pinned Codex removes orphans but does not explicitly deduplicate this malformed-history case.

## Commands

```sh
pnpm test:unit codex-provider
pnpm exec vitest run --project integration codex-provider/tests/phase-zero.integration.test.ts
pnpm exec ultracite check codex-provider/checkpoint.ts codex-provider/replay.ts codex-provider/remote.ts codex-provider/spike.ts codex-provider/tests
pnpm exec oxfmt --check codex-provider/checkpoint.ts codex-provider/replay.ts codex-provider/remote.ts codex-provider/spike.ts codex-provider/tests codex-provider/phase-one-results.md
pnpm typecheck
pnpm check:tests
```

Unit: 14 passed across 4 files, including 11 new Phase 1 tests. Retained Phase 0 integration: 2 passed. Smoke was not applicable because Phase 1 intentionally has no extension package/discovery entry point.

## Phase 2 gate

**GO:** implement the registered-provider lifecycle path against these pure helpers. Keep inline replay, request framing, and production hook registration out of Phase 2 except for the lifecycle hooks required by that phase.
