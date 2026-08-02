# Codex compaction design

> This document describes the current side-compaction implementation. The planned complete-provider successor is specified in the [provider replacement plan](provider-replacement-plan.md), backed by the [current research](provider-replacement-research.md).

## Supported boundary

This private extension supports only Pi 0.83.0, `openai-codex`, and `openai-codex-responses`. Normal requests keep Pi's registered provider and transport. Side compaction uses that provider over SSE so the extension can observe and validate the opaque result without owning authentication or duplicating Pi's serializer.

The extension must load last. Pi 0.83.0 cannot guarantee terminal hook ownership, so general discovery and npm publication remain unsupported.

## Source baseline

The implemented protocol was derived from these pinned revisions:

- OpenAI Codex `6219b7c40fc9c702c0aef9964e72b492558f60e4`.
- `ogulcancelik/pi-extensions` `d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6`.
- `IgorWarzocha/howaboua-pi-stuff` `7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988`.

Current Codex is a moving reference rather than an automatic compatibility promise. The extension intentionally diverges by omitting image bytes from durable compacted history to avoid the retained-image failure reported in `openai/codex#24388`.

## Request and replay invariants

1. Context framing must identify exactly one canonical persisted-to-live match.
2. Only persisted assistant errors omitted by Pi's automatic retry may be absent live.
3. Marker-free finalized input must retain complete structural parity.
4. Earlier payload and header transformations are paired request-locally and never persisted.
5. Remote compaction must return exactly one canonical opaque item and a matching completed response ID.
6. Stale generation, branch, model, request-state, race, or persistence checks abort the request.
7. Redirects are rejected and unsafe failures never fall back to textual compaction.

Wire `compaction_summary` remains an accepted provider-output alias and is immediately canonicalized to `compaction`. It is never valid in persisted state.

## Private checkpoint v4

Checkpoint v4 stores:

- One final canonical `compaction` item.
- Recent canonical user messages containing only `input_text`.
- Provider/model/base-URL identity, response ID and usage, source tokens, reason, and phase.
- A canonical SHA-256 digest of the replacement.

Every retained image becomes a small text omission before token budgeting and persistence. The transient replacement used by the inline request that triggered compaction may still carry its inline data images; those bytes never enter the checkpoint. Unsupported `agent_message` input fails closed before remote compaction.

Middle-truncation markers count toward the same UTF-8/4 retained-text budget. If the marker itself cannot fit, that boundary text is omitted.

The parser requires exact keys, validates all scalar values, verifies the replacement hash, and deep-freezes the result. Earlier checkpoint versions are unsupported without migration.

## Operational limitations

- Pi provides no atomic checkpoint installation and history replacement transaction.
- Side compaction cannot reuse Pi's active transport session.
- Pi exposes no native Codex `comp_hash`, context-window ID, or world-state reinjection.
- Lifecycle compaction and inline compaction remain separate because they handle different Pi events.
- Redacted diagnostics persist shapes, counts, and hashes only; they never contain message text, tool arguments, headers, credentials, or encrypted checkpoint content.

See [local deployment](local-deployment.md), [context alignment](context-alignment.md), and the [live canary](live-canary.md) for operational use.
