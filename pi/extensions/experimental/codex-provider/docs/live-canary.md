# Live Codex provider canary

The live canary exercises the installed OpenAI Codex credential, the replacement provider, remote V2 compaction, durable `clanker.codex-provider/checkpoint` schema-v1 checkpoints under the `codex-provider.checkpoint` session namespace, transport behavior, and replay in a fresh Node process. It makes real network requests and consumes model usage.

Except for the installed-environment RPC run, the runners do not load project context, skills, prompts, themes, other extensions, or unrelated tools.

## Default SSE run

Run from the repository root:

```bash
vp run @clanker-stuff/codex-provider#test:live
```

SSE is the default transport. Three rounds use a small estimator window and synthetic prompts. Every round must:

1. Perform compaction and the following model response over SSE without constructing a WebSocket.
2. Add exactly one strict schema-v1 threshold checkpoint with a unique response ID.
3. Advance `windowNumber`, set `previousWindowId` to the prior `currentWindowId`, and issue a new current ID.
4. Complete without an extension error.
5. Report every checkpoint through `/codex-provider` without appending a session entry.

The parent then exits its session. A new Node process opens the JSONL session, sends two normal turns with a large window, and proves the newest opaque window replays without creating another checkpoint.

## Portable lifecycle run

```bash
vp run @clanker-stuff/codex-provider#test:live:portable
```

This SSE-only mode performs a real lifecycle `/compact` with custom instructions. It requires one readable Pi summary beside one native schema-v1 checkpoint, verifies that the custom marker enters only the summary, and confirms the compatible request contains the opaque replacement instead of the readable summary. The model must recall a generated value that the custom instructions deliberately omitted from the portable summary, proving that omission did not alter native checkpoint recall.

Retries can increase usage and cost. The retained JSONL artifact stores the readable summary and original conversation in plaintext; summary omission is not deletion.

## Real-window SSE run

```bash
vp run @clanker-stuff/codex-provider#test:live:real
```

This mode uses the model's declared context window. It calibrates a high-token-density payload, then performs two SSE compactions. Before each compaction, a fill turn must reach at least 90% of the server context without crossing the local byte estimate. The following turn must compact from provider-reported usage, and the checkpoint must report at least 90% side-input usage.

The final JSON includes one metadata-only estimator record per round, derived from that round's latest compaction request: the local estimated source tokens, Pi's provider-reported prompt-side total (`input + cacheRead + cacheWrite`), their local/provider ratio, model, declared and effective context limits, observed Responses Lite request state, and the inferred count of rewritten trailing outputs. Every round must produce at least one new compaction request, but retries may produce more. The ratio must be positive and finite. The canary does not assume a fixed context size or use a tokenizer.

Request bodies are inspected only in memory to derive those fields. The estimator evidence does not include or write prompt text, tool arguments, encrypted content, credentials, headers, URLs, payload bodies, or request sizes. The separately retained Pi session JSONL still contains the canary's synthetic conversation, as required for fresh-process replay.

Expect roughly 1.4–1.6 million provider-context tokens across calibration, fills, compactions, normal responses, and fresh-process replay. Cached tokens still count toward context occupancy.

## Mid-turn tool-loop run

```bash
vp run @clanker-stuff/codex-provider#test:live:mid-turn
```

This mode calibrates natural text and performs two real tool loops. In each round the model must call `context_filler` exactly once. Its result fills at least 80% of the real context and crosses the local threshold, forcing compaction before the next model response. The model must then call `post_compaction_probe` exactly once; the tool rejects an early call by recording how many checkpoints existed when it ran. This proves the post-compaction request still contains the current tool schemas and system instructions. Both checkpoints must have phase `mid-turn`, and their windows must form one monotonic replacement chain.

Before round two replays the active checkpoint, a canary extension injects one hidden custom message and deterministically changes its live top-level timestamp from the persisted timestamp. The provider request must still contain exactly one opaque compaction item and one copy of the sentinel text, and replay must complete successfully.

Expect roughly 460,000–600,000 provider-context tokens.

## WebSocket run

```bash
vp run @clanker-stuff/codex-provider#test:live:websocket
```

This is genuine WebSocket coverage for both compaction and normal turns. The runner counts WebSocket constructions and fails if any `/responses` request uses SSE. It performs repeated schema-v1 replacements, then proves branch isolation in a fresh process over WebSocket. Before disposal, the harness uses Pi's public reload lifecycle so `session_shutdown` closes cached sockets immediately.

## Forced fallback run

```bash
vp run @clanker-stuff/codex-provider#test:live:fallback
```

The runner injects a WebSocket constructor that always fails. Round one starts with inline compaction, whose private retry loop makes exactly three pre-output WebSocket attempts before activating provider-owned SSE fallback. The exact UI warning `OpenAI Codex WebSocket is unavailable; using SSE for this session.` must appear once after the following successful assistant. Every later compaction and normal turn in that runtime must stay on SSE without constructing another WebSocket or warning.

In the fresh process, checkpoint replay transforms the finalized payload, so prewarm is skipped. Its first normal turn makes one failed WebSocket attempt and emits the same UI warning, and the new runtime stays on SSE without another warning for its second turn.

## Fresh-process branch isolation

```bash
vp run @clanker-stuff/codex-provider#test:live:branch
```

The parent creates at least two checkpoints and exits its session. A spawned Node process then:

1. Forks at checkpoint 1 and creates a divergent schema-v1 window chained from it.
2. Proves checkpoint 2 is absent from the divergent branch.
3. Reopens checkpoint 2's original branch and proves the divergent checkpoint is absent.
4. Restores the divergent branch and verifies it remains independent.

## Capability run

```bash
vp run @clanker-stuff/codex-provider#test:live:capabilities
```

This sends a real inline PNG and requires the model to identify its color, exercises Pi's strict JSON-schema tool path with an exact object, compacts that mixed image/tool history, and switches to a second available Codex model for the final response. The durable checkpoint must omit the inline image bytes while the transient post-compaction request remains usable.

The default switch is from `gpt-5.6-sol` to `gpt-5.6-terra`. Set `CODEX_COMPACTION_LIVE_ALT_MODEL` to choose another available `openai-codex-responses` model. Pi does not expose a separate response-format setting on `AgentSession`; its constrained strict tool schema is the supported structured-output surface covered here.

## Below-threshold metadata run

```bash
vp run @clanker-stuff/codex-provider#test:live:threshold
```

This performs one small real tool loop using the model's declared context window and live remote metadata. Both model calls must complete without creating a checkpoint. It guards nullable or missing auto-compaction metadata from turning the effective threshold into zero.

## Fast routing run

```bash
CODEX_FAST_LIVE_PAID=1 pnpm --filter @clanker-stuff/codex-provider run test:live:fast
```

The explicit `CODEX_FAST_LIVE_PAID=1` guard acknowledges paid usage. The runner defaults to `gpt-5.6-sol`; optional arguments include `--model ID`, `--pairs N`, `--seed N`, and `--out PATH`.

[`scripts/live-fast.ts`](../scripts/live-fast.ts) runs one standard/fast pair by default over WebSocket, using a fresh runtime session and socket for each generation. Every socket sends one `generate=false` prewarm followed by one generation, so the default pair comprises two paid generations and four `response.create` frames. Each generation disables reasoning and must stream the exact fixed 64-word response. The runner compares complete visible words delivered after the first nonempty text delta through the last text delta; words already complete in the first delta are excluded. This is a client-visible fixed-work rate, not exact token generation throughput, because text deltas can contain more than one token. Provider-reported output tokens and backend timing metrics remain separate evidence.

The runner verifies the [upstream tier-routing contract](codex-baseline.md#verified-revisions): standard omits `service_tier` and uses a model-only hint, while fast sends the priority request tier and matching priority hint. It separately records the local originator adaptation: `pi` for standard and `codex_cli_rs` for fast. Deterministic provider tests cover the equivalent SSE contract and the standard-to-fast WebSocket transition that must reconnect rather than reuse a handshake bound to the old route.

The retained artifact records sanitized outbound routing evidence under `samples[].wire`; observed generation, prewarm, and total `response.create` counts; successful prewarm and generation terminal event type, status, and `service_tier`; client timing and visible-word delivery rate; fixed-output validation; usage and cost; whitelisted numeric `responsesapi.websocket_timing` metrics; and the standard/fast rate ratio. The ChatGPT Codex WebSocket may report different terminal tiers for prewarm and generation, so those labeled values are evidence rather than a pass/fail oracle. The artifact persists no prompts, authentication or account data, complete headers, credentials, or other secrets.

This canary depends on paid backend behavior and timing, so it is deliberately non-gating. A single pair is a direct throughput measurement, not a statistical claim; increase `--pairs` only when repeated sampling is useful.

## Ten-round soak runs

```bash
vp run @clanker-stuff/codex-provider#test:live:soak:sse
vp run @clanker-stuff/codex-provider#test:live:soak:websocket
```

Each soak performs ten sequential compactions, verifies unique response IDs and one monotonic schema-v1 window chain, then reopens the session in a fresh Node process for two replay turns. The WebSocket soak additionally requires one reused connection and zero SSE requests. Set `CODEX_COMPACTION_LIVE_ROUNDS` to increase the run beyond ten rounds.

A ten-round soak processes at least about 375,000 input tokens through compaction, plus the normal responses and fresh-process replay. Run these deliberately; they are broader state-leak and long-chain coverage, not routine unit tests.

## Client stream-fault run

```bash
node pi/extensions/experimental/codex-provider/scripts/live-multi-compaction.ts --stream-fault --sse
```

This mode interrupts the first real `/responses` compaction response body inside the client after the HTTP request succeeds. It identifies compaction structurally by the trailing `compaction_trigger`, matching the provider protocol rather than assuming a separate endpoint. The provider must retry, persist exactly two schema-v1 checkpoints across two rounds, and replay them in a fresh process. The runner requires exactly one injected fault and at least one extra compaction request.

## Concurrent RPC run

```bash
node pi/extensions/experimental/codex-provider/scripts/live-chaos.ts --rpc
```

This launches Pi's real RPC process and sends two `compact` commands without awaiting either one. Both overlapping compactions must cancel without persisting a partial entry. A following recovery compaction must persist one schema-v1 lifecycle checkpoint and remain usable on the next prompt. The isolated artifacts are retained, but their copied `auth.json` is removed before exit.

## Crash/restart run

```bash
node pi/extensions/experimental/codex-provider/scripts/live-chaos.ts --crash
```

This launches the normal SSE runner, polls its JSONL artifact, and sends `SIGKILL` as soon as the first complete checkpoint line is readable. A fresh Node process then opens that exact session and proves the durable checkpoint can serve two normal turns without being replaced.

## Installed-environment RPC run

```bash
vp run @clanker-stuff/codex-provider#test:live:installed
```

This explicitly invoked canary resolves the system `pi` command to its compiled installation, requires Pi 0.84.2, and runs it in RPC mode with the actual `PI_CODING_AGENT_DIR`. It therefore loads the user's configured settings, extensions, and other resources instead of constructing an extension-isolated environment. The working directory and session directory are temporary, and the retained artifact root is printed at startup. A project-local compaction setting keeps the short manual run eligible; it does not change the model context window.

The model keeps its native declared context window; this run does not force the small estimator window used by the default synthetic canary. One happy path verifies project instructions, provider/API identity, Direct Mode `exec_command` and `apply_patch`, Code Mode `exec` with nested tools, a strict manual checkpoint over that tool history, a non-persisting `/codex-provider` status request, and fresh-process Direct Mode tool availability plus opaque checkpoint recall. The installed `/tools` command must also be present, proving the provider is running alongside the tools extension.

This canary makes paid model requests, depends on the installed Pi environment and backend, and is intentionally non-deterministic. Run it deliberately when validating the real local deployment; deterministic tests remain responsible for exact protocol and failure behavior.

## Mixed marathon run

```bash
vp run @clanker-stuff/codex-provider#test:live:marathon
```

The marathon deliberately composes existing canaries: a ten-round SSE soak, WebSocket branch isolation, two real-window mid-turn tool loops, client stream-fault recovery, concurrent RPC recovery, and checkpoint-boundary `SIGKILL` recovery. It consumes roughly one million or more provider-context tokens; retries increase that total.

## Optional manual TUI smoke

For a visual check, open the system Pi CLI in a disposable working directory from a Herdr pane, complete a normal turn and a manual `/compact`, run `/codex-provider`, then complete another turn. Confirm that the checkpoint and status views render clearly and the configured tools remain available after compaction.

This is a manual, non-gating smoke check. Terminal layout, timing, and model output make it unsuitable as an automated PTY assertion suite; the RPC canaries remain the structured runtime checks.

Use one transport flag with any compatible behavior mode:

```text
--sse | --websocket | --fallback
--branch | --capabilities | --portable | --real-window | --mid-turn | --soak | --stream-fault | --threshold
```

`--sse` is implicit when no transport flag is present. Choose at most one behavior mode. `--portable` and `--stream-fault` require SSE. Real-window and mid-turn evidence requires SSE request inspection, so `--real-window --websocket` and `--mid-turn --websocket` are rejected; forced fallback remains compatible because its compaction requests continue over SSE. `--mid-turn` implies `--real-window`. Internal `--branch-child` and `--restart-child` flags are reserved for the runner.

## Configuration and artifacts

The runner defaults to `openai-codex/gpt-5.6-sol` and uses the credential under `PI_CODING_AGENT_DIR`. Successful and failed runs retain their isolated session under the printed artifact path.

Optional environment variables:

- `CODEX_COMPACTION_LIVE_MODEL` — model ID.
- `CODEX_COMPACTION_LIVE_ALT_MODEL` — capability-run model-switch target; default `gpt-5.6-terra`.
- `CODEX_COMPACTION_LIVE_ROUNDS` — compaction rounds; minimum 2, default 3, 10 for soak mode, or 2 for real-window, mid-turn, branch, and stream-fault modes.
- `CODEX_COMPACTION_LIVE_CONTEXT_WINDOW` — forced estimator window; default 4096.
- `CODEX_COMPACTION_LIVE_PAYLOAD_BYTES` — synthetic bytes per round; default 20000.
- `CODEX_COMPACTION_LIVE_DIR` — artifact parent directory.

This is a release canary, not a deterministic correctness test. It does not inject server-side rate limits or disconnect the paid backend itself. Unit and integration tests remain responsible for exact malformed-state, race, retry-alignment, and fail-closed behavior.
