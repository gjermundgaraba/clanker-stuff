# Agent evaluation

The evaluation harness compares three coding-agent paths on fresh copies of the same committed fixture:

1. Pi with this extension loaded explicitly.
2. Pi's built-in `openai-codex` provider with the extension omitted.
3. `codex exec --json`.

Every arm receives the same model ID, reasoning level, task prompts, timeout, and hidden deterministic tests. The harness compares behavior and repository results, not response text.

## Free validation

Run the structural smoke test before any paid evaluation:

```bash
node pi/extensions/experimental/codex-provider/scripts/evaluate-agents.ts --smoke
```

It checks the three CLIs, proves each untouched fixture fails, and proves each reference solution passes. It does not contact a model.

Run the complete scheduling and reporting path without model calls:

```bash
node pi/extensions/experimental/codex-provider/scripts/evaluate-agents.ts --dry-run --repetitions 2
```

## Paid evaluation

The default suite makes six agent runs per repetition: two tasks across three runners.

```bash
node pi/extensions/experimental/codex-provider/scripts/evaluate-agents.ts \
  --model gpt-5.6-sol \
  --reasoning high \
  --repetitions 3 \
  --timeout-minutes 20
```

Authenticate Pi and Codex CLI before starting. The harness copies only each CLI's authentication file into a temporary private config directory and deletes that directory after the arm finishes.

Use `--task inventory-ledger` or `--task http-retry` for a smaller run. Each repetition rotates which runner goes first; three repetitions place every runner in every position once.

## Compaction and resume

`compaction-resume` is excluded by default. It sends five resumed continuity turns totaling roughly 300,000 prompt tokens, followed by an implementation turn. This is intended to cross normal compaction thresholds and can be expensive.

```bash
node pi/extensions/experimental/codex-provider/scripts/evaluate-agents.ts \
  --task compaction-resume \
  --model gpt-5.6-sol \
  --reasoning high
```

The grader checks whether the final implementation preserves five earlier decisions. The Pi extension arm also fails unless Pi emits the extension's checkpoint marker, either in a completed compaction or a durable checkpoint-append event. Compaction remains informational for Pi's built-in provider and Codex CLI because those paths do not expose equivalent durable signals.

## Results

The command prints the output directory and writes `results.json`. Each arm retains its isolated git workspace and a sanitized `events.jsonl` containing lifecycle, tool name, stop, compaction, and usage metadata only.

Results include pass/fail, protected-file integrity, elapsed time, first-response time, tool calls, token usage, compactions, and diff files/lines/bytes. Codex CLI compactions are `null`, not zero, because its JSON event stream does not expose them. A runner error or timeout always fails its arm, even when the resulting files pass the hidden tests.

`results.json` is atomically refreshed after every arm, so completed results survive a later fixture, grading, diff, or reporting failure. Raw prompts, tool arguments, tool output, assistant text, stderr, sessions, and authentication data are not retained in results.

The harness does not claim perfect parity: Pi and Codex CLI have different system prompts and tool implementations. Interpret repeated task pass rates and resource metrics together; do not compare exact text.

## Code Mode A/B

The provider-local benchmark compares direct Codex tools, `/code-mode`, and native `codex exec` on the same fixture:

```bash
vp run eval:code-mode --runs 3
```

Use `--prepare-only` for a no-model-call fixture check. Results include hidden-test outcomes, active tools, elapsed and first-response times, token usage, cost, and each workspace diff.

Elapsed and first-response timing starts with the task prompt. Fixture creation, session setup, and Code Mode host download or installation are excluded; starting the installed host process and executing tools remain measured.
