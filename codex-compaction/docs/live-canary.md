# Live multi-compaction canary

The live canary exercises the installed OpenAI Codex provider, stored authentication, remote compaction service, checkpoint persistence, repeated active replay, and session resume. It is intentionally separate from Vitest because it performs real network requests and consumes model usage.

Run it from the repository root:

```bash
pnpm --dir codex-compaction test:live
```

The default canary audits the local load-last deployment before making a request. It then creates an isolated persistent session with synthetic repetitive prompts and a deliberately small estimator window. Each of three rounds must create exactly one inline v4 threshold checkpoint with a unique response ID and canonical text-only replacement. Finally, it reopens the JSONL session with a normal-sized window and proves that the newest checkpoint replays without creating another checkpoint or diagnostic.

For a full-context soak test, run:

```bash
pnpm --dir codex-compaction test:live:real
```

This mode uses the model's declared context window without overriding it. It first calibrates a synthetic high-token-density payload against provider-reported usage. For each of two rounds, a normal turn must fill at least 90% of the server context without tripping the local byte estimator; the next turn then automatically compacts because of that fresh usage. Each remote checkpoint must independently report at least 90% input usage. This prevents an estimator-only trigger from passing.

Expect roughly 1.4–1.6 million provider-context tokens across calibration, fill, compaction, normal responses, and resume. Cached tokens are cheaper but still count toward context occupancy.

For a real mid-turn tool-loop test, run:

```bash
pnpm --dir codex-compaction test:live:mid-turn
```

This mode calibrates a natural-text payload, requires the model to call one deterministic tool, fills at least 80% of the real context through the tool result, and requires automatic compaction between the tool result and final assistant response. The resulting checkpoint must have phase `mid-turn`; resume must replay it without the original tool output.

Expect roughly 230,000–300,000 provider-context tokens.

For a fresh-process branch isolation test, run:

```bash
pnpm --dir codex-compaction test:live:branch
```

The parent process creates two inexpensive real checkpoints and exits its agent session. A spawned Node process then:

1. Forks at checkpoint 1.
2. Creates a divergent checkpoint and proves checkpoint 2 is absent.
3. Reopens checkpoint 2's original branch and proves the divergent checkpoint is absent.
4. Restores the divergent branch and verifies it remains independent.

Both branch prompts must complete without a framing diagnostic. This mode uses a small estimator window and is intended to test persistence and branch topology, not real-window occupancy.

For mixed transport coverage, run:

```bash
pnpm --dir codex-compaction test:live:websocket
```

This mode uses WebSocket for normal model turns while the extension continues to force remote compaction through SSE. It creates two inexpensive checkpoints and reopens the session to verify replay across the transport boundary.

The run uses the existing `openai-codex` credential from `PI_CODING_AGENT_DIR` and defaults to `gpt-5.6-sol`. It does not load project context, skills, prompts, themes, other extensions, or tools. Synthetic prompts and opaque provider checkpoints are the only conversation content.

At least seven provider requests are expected: one compaction and one normal response per round, then one resume response. Provider retries can increase that count.

Successful and failed runs retain their isolated session under the printed artifact path for inspection. Override its parent directory with `CODEX_COMPACTION_LIVE_DIR`.

Optional environment variables:

- `CODEX_COMPACTION_LIVE_MODEL` — model ID.
- `CODEX_COMPACTION_LIVE_ROUNDS` — compaction rounds; minimum 2, default 3 or 2 in real-window mode.
- `CODEX_COMPACTION_LIVE_CONTEXT_WINDOW` — forced estimator window; default 4096.
- `CODEX_COMPACTION_LIVE_PAYLOAD_BYTES` — synthetic bytes per round; default 20000.

This is a release canary, not a deterministic correctness test. Unit and integration tests remain responsible for exact malformed-state, race, retry-alignment, and fail-closed behavior.
