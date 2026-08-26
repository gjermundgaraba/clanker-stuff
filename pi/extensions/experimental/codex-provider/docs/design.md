# Codex provider design

This extension is the always-on `openai-codex` provider for one controlled Pi 0.84.2 installation. It owns normal Responses requests, Codex-native direct tools and Code Mode, fast-mode service-tier selection, SSE and WebSocket transport, model metadata, turn state, continuation, remote compaction V2, and durable checkpoint replay. It reuses Pi's ChatGPT OAuth implementation and public Responses serializers.

The implementation follows the compatibility objective and pinned [Codex and Pi source baseline](codex-baseline.md). It supports only provider `openai-codex` with API `openai-codex-responses`; it is not a generic OpenAI or Azure provider.

## Runtime ownership

| Responsibility                                                                          | Implementation                                                                                      |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Provider registration, lazy loading, and hook routing                                   | [`index.ts`](../index.ts), [`runtime.ts`](../runtime.ts), [`lazy-provider.ts`](../lazy-provider.ts) |
| Session lifecycle, compaction hooks, and fast mode                                      | [`lifecycle.ts`](../lifecycle.ts), [`fast-mode.ts`](../fast-mode.ts)                                |
| Request bodies, service tiers, retries, transport, continuation, and compaction streams | [`provider.ts`](../provider.ts)                                                                     |
| Model catalog, `/models` refresh, and Codex request headers                             | [`model-catalog.ts`](../model-catalog.ts)                                                           |
| Direct tools, model gating, selection, and `/code-mode`                                 | [`tools/`](../tools/)                                                                               |
| Code Mode host protocol and nested tool runtime                                         | [`code-mode/`](../code-mode/)                                                                       |
| Branch-scoped Ultra state, Max selection, and proactive policy                          | [`ultra/`](../ultra/)                                                                               |
| Collaboration tools, durable tree, and child lifecycle                                  | Companion [`subagents`](../../subagents) extension                                                  |
| Skill-catalog visibility without Pi's `read` tool                                       | [`skill-catalog.ts`](../skill-catalog.ts)                                                           |
| Best-effort request and reliability observations                                        | [`observability.ts`](../observability.ts)                                                           |
| Strict persisted checkpoint format and active-branch resolution                         | [`checkpoint.ts`](../checkpoint.ts)                                                                 |
| Framing, retention, token estimates, and tool-history repair                            | [`replay.ts`](../replay.ts)                                                                         |
| Redacted checkpoint display                                                             | [`renderer.ts`](../renderer.ts)                                                                     |
| Read-only provider status                                                               | [`status.ts`](../status.ts)                                                                         |

The provider runtime is not optional. Loading the extension replaces Pi's effective `openai-codex` provider for the process. The extension must resolve last so no later context, header, payload, provider, or compaction registration can invalidate its checks; see [local deployment](local-deployment.md).

One provider session exists per Pi session. A user turn gets fresh turn identity and turn-state routing, while a cached physical WebSocket, exact continuation candidate, sticky SSE fallback, and context-window generation may survive across turns. Session shutdown closes transport state.

Fast mode starts disabled. `/fast` or `--fast` enables the `priority` service tier for supported models across normal requests and native compaction. The provider applies the [upstream tier-routing contract](codex-baseline.md#verified-revisions) to every supported `openai-codex-responses` stream: fast requests set `service_tier: priority` in the body and `tier=priority` in `x-codex-routing-hint`, while standard requests omit both tier selections. This covers SSE requests, remote compaction, WebSocket handshakes, and prewarm. Separately, the local provider sends `originator: pi` for standard requests and `originator: codex_cli_rs` for priority requests. That split is an empirically motivated Pi adaptation, not an upstream routing requirement.

Live model metadata is authoritative; the pinned fallback catalog covers offline startup. Persisted remote catalogs are bound to the ChatGPT account that produced them and are invalidated before another account can observe their entitlements or model policy. A catalog-observed account change also invalidates account-scoped usage cache and in-flight usage publication. The lightning status appears only when the selected model supports fast mode.

Remote reasoning presets are intersected with Pi's known thinking levels instead of being forwarded as request values. Only the Codex Responses wire efforts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` reach transport. Because Pi has no distinct `ultra` thinking level, the provider keeps Ultra as branch-scoped state, selects Pi `max` for inference, and appends the proactive policy described in the [Ultra research audit](ultra.md). The companion `subagents` extension owns the unchanged V2 tools and child lifecycle; a synchronous session contract carries active and inherited Ultra state between them.

Supported GPT-5.6 Codex models start with `exec_command`, `write_stdin`, `apply_patch`, and `view_image`; `/code-mode` replaces them with `exec` and `wait`. The provider owns those six names and suppresses Pi's seven built-ins while they are active, but leaves unrelated extension tools alone. When `@clanker-stuff/tools` is also loaded, `/tools` delegates those six choices back to this extension through a provider-neutral event contract. Tool choices follow the active session branch.

Pi normally omits its loaded-skill catalog when `read` is unavailable. When the provider's direct or Code Mode tool set suppresses `read`, the provider restores that catalog with guidance naming the active file-capable tool. It does not discover or load any additional skills.

`exec_command` and `write_stdin` apply requested `max_output_tokens` with Codex's UTF-8 approximate-token, head-plus-tail formatter and a model-visible truncation warning. The active catalog model's truncation policy caps the request. Only raw command output consumes that budget; Pi process status, truncation-file notices, and the session ID remain visible outside it. This matches the pinned truncation algorithm and control-metadata safety, not Codex's complete PTY result layout. In Code Mode, a nested tool with a declared output schema must return valid model-visible JSON; the provider decodes that JSON to the callable value and never substitutes host-only `details`.

Code Mode does not select a request envelope. `use_responses_lite` from native model metadata alone determines whether the same active tools and instructions use Responses Lite or the standard Responses envelope.

## Status and observability

`/codex-provider` renders a read-only report from the current Pi context, checkpoint entries, and the extension's SQLite observations. It distinguishes the active branch from the complete session tree, summarizes valid checkpoint usage and estimated reduction, compares the two latest request fingerprints and cache usage, reports replay blocks, transport fallbacks, and failed compaction requests, and checks the active checkpoint against the current provider identity. The report is shown through Pi's notification UI and is never appended to the session.

Complete checkpoints remain in Pi's session JSONL because Pi and the extension need them to reconstruct context during branch navigation, reload, resume, and session sharing. Compact request, transport, framing-failure, and compaction-attempt observations are written best-effort to `data/codex-provider/codex-provider.sqlite` under Pi's agent directory. The database uses WAL, never waits on a busy writer, and deletes observations older than 30 days when opened. `--no-session` keeps observations in memory. Observation failure never delays or fails a model request.

Framing and transport diagnostics are not appended to session JSONL, so they do not travel with copied or shared session files.

The checkpoint entry renderer presents estimated before/after context size separately from provider-reported compaction usage. Its default view contains operational results only; Pi's expanded-entry view reveals checkpoint identifiers, hashes, protocol versions, limits, and retained-item counts. These values establish persistence and replay health, not semantic summary quality.

## Request and transport flow

1. Pi finalizes its system prompt, messages, tools, auth, options, and earlier extension transformations.
2. The provider serializes the effective Pi context with Pi's public Responses converters, then adds only extension-owned Codex metadata.
3. `context`, `before_provider_headers`, and `before_provider_request` pair the active branch, finalized input, and headers to the same request generation.
4. WebSocket `auto` mode may prewarm once and reuses an idle socket only while its stable handshake identity still matches the endpoint, account credentials, model, effective tier, and other route headers. A mismatch closes the stale socket, reconnects, and clears socket-bound continuation state.
5. A pre-output WebSocket failure makes SSE sticky for that Pi session. Visible assistant output is never internally replayed after emission; Pi remains responsible for outer retry.

Redirects are rejected for remote compaction. Normal and compaction streams require terminal protocol state, and compaction additionally requires a matching completed response ID, usage, and exactly one canonical opaque item.

`response.service_tier` is retained for usage pricing.

## Compaction and checkpoint v1

Automatic compaction uses the remote model limit when available, capped at 90% of the context window; the effective window defaults to 95%. It can run before sampling, between tool-loop calls, for Pi manual/threshold/overflow lifecycle events, and for model `comp_hash` or usable-window transitions. Inline compaction reuses the active turn transport and turn state. Standalone lifecycle compaction uses an isolated provider session.

Every new native checkpoint has:

- custom entry type `codex-provider.checkpoint`;
- schema `clanker.codex-provider/checkpoint`, version `1`;
- protocol `openai-responses-compaction-v2`;
- provider/API/base-URL identity and the producing model ID;
- exactly one final canonical `compaction` item, recent canonical user messages, and bounded non-final `agent_message` items;
- response ID and usage, source-token estimate, reason, phase, and a SHA-256 replacement digest;
- current/previous window IDs, window number, model `comp_hash`, effective token limit, and request-schema version.

The parser requires exact keys, validates every scalar and replacement item, verifies the digest, and deep-freezes a clone. No earlier local checkpoint namespace or version is accepted. Wire `compaction_summary` is accepted only as a provider-output alias and is canonicalized immediately to `compaction`.

Retained user text has a 64,000-token budget using the conservative local estimator. Eligible non-final agent messages must fit individually within 10,000 estimated tokens. Final-answer agent messages, stale tool/reasoning/system/developer items, and image bytes are not persisted. Images become small text omissions in the durable replacement; supported inline images may remain only in the transient request that triggered compaction.

## Portable lifecycle summaries

Lifecycle compaction runs Pi's readable summarizer beside native compaction. The Pi summary and opaque checkpoint are installed together only after source, branch, model, generation, request state, and persistence checks pass. Compatible Codex replay sends the opaque replacement; an incompatible provider can use the readable summary.

`CLANKER_CODEX_COMPACTION_FAILURE=ask|fallback|cancel` controls a genuine native failure after a readable summary succeeds. The default `ask` offers fallback or cancellation only in a dialog-capable UI; headless operation, dismissal, abort, stale state, unsafe context, or failed persistence cancels. Custom `/compact` instructions affect Pi's history-summary request only, including Pi 0.84.2's existing split-turn limitation; they do not alter native compaction.

Both the readable summary and the original JSONL history remain plaintext on disk. The opaque item is not secure deletion.

## Safety invariants

1. Context framing must find exactly one canonical persisted-to-live match.
2. Only persisted retryable assistant errors omitted by Pi may be absent from live context.
3. Marker-free finalized input must retain complete structural parity and valid tool pairs.
4. Earlier payload and header transformations are paired request-locally and never persisted.
5. Compatible replay requires provider, API, canonical base URL, and non-conflicting `comp_hash`; model transitions compact explicitly instead of treating the model ID as the compatibility key.
6. A stale generation, branch, leaf, model, request state, source hash, race, or unverifiable append aborts the pending request.
7. Observations contain request hashes, 16-hex item hash prefixes, model/options, transport and retry outcomes, timings, identifiers, and usage; never message text, tool arguments, headers, credentials, URLs, or encrypted checkpoint content.

The persisted-versus-live proof is detailed in [context alignment](context-alignment.md). Executable coverage lives in the [checkpoint](../tests/checkpoint.test.ts), [provider](../tests/provider.test.ts), [replay](../tests/replay.test.ts), and [lifecycle integration](../tests/lifecycle.integration.test.ts) tests.

## Accepted limits

- Pi 0.84.2 cannot atomically replace arbitrary raw provider history and append the matching checkpoint, so append and continuation are separately verified and fail closed.
- Pi exposes load-order chaining, not exclusive terminal ownership. This package is approved only under the audited local load-last contract.
- Pi's effective prompt, tools, permissions, and messages remain authoritative. Codex application world-state sections that Pi does not expose are not fabricated.
- Token accounting is a conservative UTF-8/4 estimate plus a fixed image estimate, not the server tokenizer.
- Server sockets, response continuation, and turn state are ephemeral. Durable resume reconstructs a complete request from checkpoint plus Pi history.

See [the source map and intentional divergences](codex-baseline.md), [local deployment](local-deployment.md), and the [live canary](live-canary.md).
