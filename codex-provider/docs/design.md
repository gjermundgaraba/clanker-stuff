# Codex provider design

> This document describes the durable checkpoint and replay foundation used by the complete provider replacement. The replacement is specified in the [provider replacement plan](provider-replacement-plan.md), backed by the [current research](provider-replacement-research.md).

## Supported boundary

This private extension supports only Pi 0.83.0, `openai-codex`, and `openai-codex-responses`. By default it owns normal request construction, SSE/WebSocket transport, model metadata, turn state, continuation, and compaction V2 while reusing Pi's OAuth and serializers. With `CLANKER_CODEX_PROVIDER_REPLACEMENT=0`, normal requests use Pi's built-in provider and existing v4/v5 checkpoints remain replayable, but the extension does not create new remote checkpoints.

The extension must load last. Pi 0.83.0 cannot guarantee terminal hook ownership, so general discovery and npm publication remain unsupported.

## Source baseline

The checkpoint foundation was derived from these pinned revisions:

- OpenAI Codex `6219b7c40fc9c702c0aef9964e72b492558f60e4`.
- `ogulcancelik/pi-extensions` `d0b1fc8ba5523c14ed5b48fbd1536f5752a42bb6`.
- `IgorWarzocha/howaboua-pi-stuff` `7f72997715bfdbcaa1ced0d38d1c7b3bad7f8988`.

Current Codex is a moving reference rather than an automatic compatibility promise. The extension intentionally diverges by omitting image bytes from durable compacted history to avoid the retained-image failure reported in `openai/codex#24388`.

The complete provider implementation follows OpenAI Codex `bb5054fe47abe73ecbbd454751066a28c89f4bb9` and Pi `845d6ff1f6643aba440341cce877ce1c43ebbc39` (`v0.83.0`).

## Request and replay invariants

1. Context framing must identify exactly one canonical persisted-to-live match.
2. Only persisted assistant errors omitted by Pi's automatic retry may be absent live.
3. Marker-free finalized input must retain complete structural parity.
4. Earlier payload and header transformations are paired request-locally and never persisted.
5. Lifecycle compaction atomically stores a readable Pi summary and an opaque checkpoint; compatible Codex replay sends only the checkpoint, while incompatible providers use the summary.
6. Remote compaction must return exactly one canonical opaque item and a matching completed response ID.
7. Stale generation, branch, model, request-state, race, or persistence checks abort the request.
8. Redirects are rejected and unsafe failures never fall back to textual compaction.

Wire `compaction_summary` remains an accepted provider-output alias and is immediately canonicalized to `compaction`. It is never valid in persisted state.

## Private checkpoints v4 and v5

Checkpoint v4 stores:

- One final canonical `compaction` item.
- Recent canonical user messages containing only `input_text`.
- Provider/model/base-URL identity, response ID and usage, source tokens, reason, and phase.
- A canonical SHA-256 digest of the replacement.

Every retained image becomes a small text omission before token budgeting and persistence. The transient replacement used by the inline request that triggered compaction may still carry its inline data images; those bytes never enter the checkpoint. Unsupported `agent_message` input fails closed before remote compaction.

Each lifecycle compaction runs Pi's portable summarizer alongside native remote compaction. This adds one ordinary model request, provider usage, and cost. The Pi summary and original JSONL history remain plaintext on disk; the opaque checkpoint remains in `details.checkpoint`. Custom `/compact` instructions affect only the history-summary request, not native compaction or compatible replay. Under Pi 0.83.0 split-turn semantics, they do not affect the separately generated turn-prefix section. Omitting text from the summary is therefore portability guidance, not secure deletion.

Set `CLANKER_CODEX_COMPACTION_FAILURE` to `ask`, `fallback`, or `cancel` (case-insensitive after trimming); the default is `ask`. `fallback` installs the completed portable summary when native remote compaction fails, while `cancel` leaves context unchanged. `ask` offers those choices only with dialog-capable UI and otherwise cancels. Invalid values warn once and behave as `ask`; dismissal, abort, stale state, or unsafe context always cancels.

Middle-truncation markers count toward the same UTF-8/4 retained-text budget. If the marker itself cannot fit, that boundary text is omitted.

Checkpoint v5 also retains bounded non-final `agent_message` items and adds the current and previous window IDs, window number, model `comp_hash`, effective token limit, and request-schema version. The parser requires exact keys, validates all scalar values, verifies the replacement hash, and deep-freezes the result. Earlier versions other than v4 are unsupported without migration.

## Operational limitations

- Pi provides no atomic checkpoint installation and history replacement transaction.
- Provider-owned compaction reuses the active session transport and turn state. The deleted legacy side-request path could not do so.
- Portable replay requires a non-empty readable lifecycle summary. Legacy marker-only lifecycle compactions cannot be migrated and remain fail-closed on incompatible providers.
- Pi's built-in provider exposes no Codex `comp_hash`, context-window ID, or world-state reinjection. The replacement obtains the first two from remote model metadata and owns its window state; Codex application world state remains unavailable.
- Lifecycle and inline installation remain separate because they handle different Pi events, even though replacement compaction shares one provider runtime.
- Redacted diagnostics persist shapes, counts, and hashes only; they never contain message text, tool arguments, headers, credentials, or encrypted checkpoint content.

See [local deployment](local-deployment.md), [context alignment](context-alignment.md), and the [live canary](live-canary.md) for operational use.
