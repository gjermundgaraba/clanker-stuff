# Live provider-replacement canary

The live canary exercises the installed OpenAI Codex credential, the replacement provider, remote V2 compaction, durable v5 checkpoints, transport behavior, and replay in a fresh Node process. It makes real network requests and consumes model usage.

The runner clears `CLANKER_CODEX_PROVIDER_REPLACEMENT` so it exercises default replacement ownership. It does not load project context, skills, prompts, themes, other extensions, or unrelated tools.

## Default SSE run

Run from the repository root:

```bash
pnpm --dir codex-provider test:live
```

SSE is the default transport. Three rounds use a small estimator window and synthetic prompts. Every round must:

1. Perform compaction and the following model response over SSE without constructing a WebSocket.
2. Add exactly one strict v5 threshold checkpoint with a unique response ID.
3. Advance `windowNumber`, set `previousWindowId` to the prior `currentWindowId`, and issue a new current ID.
4. Complete without a framing diagnostic or extension error.

The parent then exits its session. A new Node process opens the JSONL session, sends two normal turns with a large window, and proves the newest opaque window replays without creating another checkpoint.

## Portable lifecycle run

```bash
pnpm --dir codex-provider test:live:portable
```

This SSE-only mode performs a real lifecycle `/compact` with custom instructions. It requires one readable Pi summary beside one native v5 checkpoint, verifies that the custom marker enters only the summary, and confirms the compatible request contains the opaque replacement instead of the readable summary. The model must recall a generated value that the custom instructions deliberately omitted from the portable summary, proving that omission did not alter native checkpoint recall.

The run makes at least five provider responses: two setup turns, one portable-summary request, one native compaction request, and one compatible replay turn. Retries can increase usage and cost. Its retained JSONL artifact stores the readable summary and original conversation in plaintext; summary omission is not deletion.

## Real-window SSE run

```bash
pnpm --dir codex-provider test:live:real
```

This mode uses the model's declared context window. It calibrates a high-token-density payload, then performs two SSE compactions. Before each compaction, a fill turn must reach at least 90% of the server context without crossing the local byte estimate. The following turn must compact from provider-reported usage, and the checkpoint must report at least 90% side-input usage.

Expect roughly 1.4–1.6 million provider-context tokens across calibration, fills, compactions, normal responses, and fresh-process replay. Cached tokens still count toward context occupancy.

## Mid-turn tool-loop run

```bash
pnpm --dir codex-provider test:live:mid-turn
```

This mode calibrates natural text and performs two real tool loops. In each round the model must call `context_filler` exactly once. Its result fills at least 80% of the real context and crosses the local threshold, forcing compaction before the next model response. The model must then call `post_compaction_probe` exactly once; the tool rejects an early call by recording how many checkpoints existed when it ran. This proves the post-compaction request still contains the current tool schemas and system instructions. Both checkpoints must have phase `mid-turn`, and their v5 windows must form one monotonic replacement chain.

Before round two replays the active checkpoint, a canary extension injects one hidden custom message and deterministically changes its live top-level timestamp from the persisted timestamp. The provider request must still contain exactly one opaque compaction item and one copy of the sentinel text, and replay must complete without a context-frame diagnostic.

Expect roughly 460,000–600,000 provider-context tokens.

## WebSocket run

```bash
pnpm --dir codex-provider test:live:websocket
```

This is genuine WebSocket coverage for both compaction and normal turns. The runner counts WebSocket constructions and fails if any `/responses` request uses SSE. It performs repeated v5 replacements, then proves branch isolation in a fresh process over WebSocket. Before disposal, the harness uses Pi's public reload lifecycle so `session_shutdown` closes cached sockets immediately.

## Forced fallback run

```bash
pnpm --dir codex-provider test:live:fallback
```

The runner injects a WebSocket constructor that always fails. The first inline compaction must make exactly one WebSocket attempt and fall back to SSE. Every later compaction and normal turn in that runtime must stay on SSE without constructing another WebSocket. In the fresh process, checkpoint replay transforms the finalized payload, so prewarm is skipped; the first normal turn makes one failed WebSocket attempt and that new runtime must then remain on SSE for its second turn.

## Fresh-process branch isolation

```bash
pnpm --dir codex-provider test:live:branch
```

The parent creates at least two checkpoints and exits its session. A spawned Node process then:

1. Forks at checkpoint 1 and creates a divergent v5 window chained from it.
2. Proves checkpoint 2 is absent from the divergent branch.
3. Reopens checkpoint 2's original branch and proves the divergent checkpoint is absent.
4. Restores the divergent branch and verifies it remains independent.

## Capability run

```bash
pnpm --dir codex-provider test:live:capabilities
```

This sends a real inline PNG and requires the model to identify its color, exercises Pi's strict JSON-schema tool path with an exact object, compacts that mixed image/tool history, and switches to a second available Codex model for the final response. The durable checkpoint must omit the inline image bytes while the transient post-compaction request remains usable.

The default switch is from `gpt-5.6-sol` to `gpt-5.6-terra`. Set `CODEX_COMPACTION_LIVE_ALT_MODEL` to choose another available `openai-codex-responses` model. Pi does not expose a separate response-format setting on `AgentSession`; its constrained strict tool schema is the supported structured-output surface covered here.

## Below-threshold metadata run

```bash
pnpm --dir codex-provider test:live:threshold
```

This performs one small real tool loop using the model's declared context window and live remote metadata. Both model calls must complete without creating a checkpoint. It guards nullable or missing auto-compaction metadata from turning the effective threshold into zero.

## Ten-round soak runs

```bash
pnpm --dir codex-provider test:live:soak:sse
pnpm --dir codex-provider test:live:soak:websocket
```

Each soak performs ten sequential compactions, verifies unique response IDs and one monotonic v5 window chain, then reopens the session in a fresh Node process for two replay turns. The WebSocket soak additionally requires one reused connection and zero SSE requests. Set `CODEX_COMPACTION_LIVE_ROUNDS` to increase the run beyond ten rounds.

A ten-round soak processes at least about 375,000 input tokens through compaction, plus the normal responses and fresh-process replay. Run these deliberately; they are broader state-leak and long-chain coverage, not routine unit tests.

Use one transport flag with any compatible behavior mode:

```text
--sse | --websocket | --fallback
--branch | --capabilities | --portable | --real-window | --mid-turn | --soak | --threshold
```

`--sse` is implicit when no transport flag is present. Choose at most one behavior mode. `--portable` requires SSE request inspection; `--mid-turn` implies `--real-window`. Internal `--branch-child` and `--restart-child` flags are reserved for the runner.

## Configuration and artifacts

The runner defaults to `openai-codex/gpt-5.6-sol` and uses the credential under `PI_CODING_AGENT_DIR`. Successful and failed runs retain their isolated session under the printed artifact path.

Optional environment variables:

- `CODEX_COMPACTION_LIVE_MODEL` — model ID.
- `CODEX_COMPACTION_LIVE_ALT_MODEL` — capability-run model-switch target; default `gpt-5.6-terra`.
- `CODEX_COMPACTION_LIVE_ROUNDS` — compaction rounds; minimum 2, default 3, 10 for soak mode, or 2 for real-window, mid-turn, and branch modes.
- `CODEX_COMPACTION_LIVE_CONTEXT_WINDOW` — forced estimator window; default 4096.
- `CODEX_COMPACTION_LIVE_PAYLOAD_BYTES` — synthetic bytes per round; default 20000.
- `CODEX_COMPACTION_LIVE_DIR` — artifact parent directory.

The default run makes at least eight provider responses: one compaction and one normal response per round, then two fresh-process replay responses. Retries can increase that count.

This is a release canary, not a deterministic correctness test. Unit and integration tests remain responsible for exact malformed-state, race, retry-alignment, fail-closed, and replacement opt-out behavior.
