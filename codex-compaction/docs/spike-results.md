# Phase 0 spike results

> Historical phase-gate snapshot. Its file list, validation counts, and next steps describe Phase 0 only. See [design.md](design.md) for current behavior.

**Decision: GO for Phase 1 only.** All five blocking assumptions passed on Pi 0.83.0. This spike does not implement or register a production extension.

## Matrix

| # | Assumption | Result | Executable evidence |
| --: | --- | :-: | --- |
| 1 | Workspace/runtime versions and public exports are compatible | **PASS** | Runtime imports loaded both packages at 0.83.0, including the exported Responses serializer subpath, `ModelRuntime`, `ModelRegistry`, `SessionManager`, and `createAgentSession`. |
| 2 | Registered `openai-codex` `streamSimple()` accepts the required public arguments/options | **PASS** | The real registered provider completed with a supplied model, context, API key, `fetch`, `onPayload`, `onResponse`, `env`, `sessionId`, signal, and SSE transport. The custom payload was present in the compressed wire body. |
| 3 | `Response.clone()` can observe raw compaction SSE independently | **PASS** | The provider completed normally while the cloned branch observed one opaque `compaction` item and `response.completed`. The fixture split SSE syntax and a multibyte character across chunks. A second test aborted and cancelled both tee consumers. |
| 4 | `ctx.abort()` prevents the request despite a caught hook exception | **PASS** | A real `AgentSession` ran the actual `before_provider_request` chain. The hook called `ctx.abort()`, then threw; Pi reported the caught extension error, produced an aborted assistant message, and called global `fetch` zero times. |
| 5 | `pi.appendEntry()` is immediately visible and survives session operations | **PASS** | Inside the real provider hook, the new custom entry was immediately both branch-visible and the leaf. A new resumed `AgentSession`, a `SessionManager.forkFrom()` session, an in-file `branch()`, and a final `SessionManager.open()` all retained the entry and expected parent chain. |

## Public request surface proved

The registered provider constructed and sent these fields from public inputs:

- model from `Model`;
- instructions, input, and tools from `Context`;
- temperature and reasoning effort from `SimpleStreamOptions`;
- `prompt_cache_key` from `sessionId`;
- provider defaults for `store`, `stream`, `include`, `text`, `tool_choice`, and `parallel_tool_calls`;
- auth/account/session/custom headers through the registered provider.

The public options `fetch`, `onPayload`, `onResponse`, `headers`, `env`, `sessionId`, `signal`, and `transport` were accepted in one real invocation. `env` has no request-body representation and its SSE effect was not separately observable with a custom fetch.

## Exact API gaps

`Provider.streamSimple()` does not make the following current-normal-request values available to the side call:

- `service_tier`;
- caller-selected text verbosity (`text.verbosity` stayed `"low"`);
- `client_metadata`;
- a Codex max-output field (`maxTokens` produced no `max_output_tokens`);
- caller-selected `tool_choice`, `parallel_tool_calls`, `store`, `stream`, or `include`;
- a raw output-item callback.

`onPayload` can manually add fields when their values are already known, but it does not expose the active normal request's resolved values. `ExtensionContext` also does not expose all active transport/cache/retry settings or later extension header/payload mutations. Therefore inline compaction must copy its observed normal envelope; a cold lifecycle side call cannot claim exact field parity.

## Session-operation scope

Proven:

- synchronous `appendEntry()` visibility in the same `before_provider_request` handler;
- persisted reopen/resume through `SessionManager.continueRecent()` and a newly bound `AgentSession`;
- cross-file fork through public `SessionManager.forkFrom()`;
- in-file branch and persisted reopen through public `branch()` and `open()`.

Not separately exercised:

- interactive `ExtensionCommandContext.fork()`, which replaces the active session runtime;
- hot `ctx.reload()`.

The tested public session primitives are sufficient to prove checkpoint data survives resume, fork, and branch serialization. Phase 3 should still add a full command-context fork/reload scenario if it depends on replacement-session hook ordering.

## Commands

```sh
pnpm list @earendil-works/pi-ai @earendil-works/pi-coding-agent --depth 0 --json
pnpm exec vitest run --project unit codex-compaction/tests/phase-zero.test.ts
pnpm exec vitest run --project integration codex-compaction/tests/phase-zero.integration.test.ts
pnpm exec ultracite check codex-compaction/spike.ts codex-compaction/tests
pnpm exec oxfmt --check codex-compaction/spike.ts codex-compaction/tests codex-compaction/spike-results.md
pnpm typecheck
```

Unit: 3 passed. Integration: 2 passed. Typecheck passed.

Smoke was not applicable: Phase 0 intentionally has no package manifest, extension entry point, or discovery wiring. No root workspace/config file was needed or changed by the spike.

## Phase 1 gate

**GO:** implement only the pure protocol core described in Phase 1.

Still no-go for a production release until later phases address handler-order safety and the documented fidelity gaps. Do not replace the proven SSE clone observer with a direct HTTP client or private session-file mutation.
