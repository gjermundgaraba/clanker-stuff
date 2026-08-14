# Pi evals

Harbor tasks for comparing vanilla Pi, Pi with `codex-provider`, and pinned Codex CLI across compaction continuity, long-term memory, and tool use. The adapters resume native multi-step sessions and normalize compaction evidence into ATIF v1.7 trajectories.

## Setup

Run commands from this directory.

```bash
uv sync
./scripts/build-runtime.sh
export PI_EVAL_AUTH_JSON_PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"
export CODEX_AUTH_JSON_PATH="$HOME/.codex/auth.json"
```

The runtime is Linux and Node 24. It contains pinned production packages and a small portable `mem2act` CLI; the repository, reference solutions, and hidden tests are absent during agent execution. Run the no-provider Oracle smoke with:

```bash
uv run harbor job start --config jobs/smoke.yaml --yes
```

## Compaction continuity

The compaction job has six matched arms: compaction off/on for vanilla Pi, Pi with `codex-provider`, and Codex CLI. Pi's 25K effective boundary and Codex CLI's 45K boundary are empirically aligned to the same pressure phase. Off arms use an explicit disabled setting—Codex uses an unreachable one-billion-token limit—rather than an unset model default.

```bash
uv run harbor job start --config jobs/compaction-matrix.yaml --yes
./scripts/report.py .harbor/jobs/compaction-matrix
```

Verifiers report end-state quality independently from trigger, attempt, success, mechanism, boundary, and continuation validity. A missed or failed compaction invalidates an on-arm experiment; it does not become an incorrect task answer. Pressure text is embedded directly in each prompt, so tool choice cannot change the trigger margin.

## LongMemEval compaction track

The generator pins the cleaned LongMemEval-S and oracle files by immutable revision and SHA-256, then creates 30 seeded questions balanced across all six question types. Each question has nested, evidence-preserving 32K, 64K, and 115K ceilings. History is split at session boundaries into roughly 12K-token steps, followed by the question, so every compactor has a valid between-turn boundary without exposing relevance or answer markers.

```bash
uv run python scripts/prepare-longmemeval.py

# One 64K question with exactly one pre-query compaction per on arm.
uv run harbor job start --config jobs/longmemeval-64k-single-compaction.yaml \
  --path datasets-generated/longmemeval/64k/00 \
  --job-name longmemeval-calibration --yes

# Full 90-task matrix.
uv run harbor job start --config jobs/longmemeval.yaml --yes

# Controlled 115K confirmation matrix.
uv run harbor job start --config jobs/longmemeval-115k-single-compaction.yaml --yes
```

The in-task `exact_normalized` score is a deterministic lower bound. Apply LongMemEval's task-specific semantic rubric with `gpt-5.6-sol`; results are cached beside the job and deliberately labeled `QA judge`, not official LongMemEval:

```bash
./scripts/judge-longmemeval.py .harbor/jobs/longmemeval \
  --backend codex --model gpt-5.6-sol --workers 4
```

`scripts/report.py` automatically uses cached judge labels.

This is a compaction-oriented derivative because official LongMemEval sends history and question in one request. Do not publish its numbers as unmodified LongMemEval-S results.

The evaluation protocol is fixed before the breadth screen. Round 1 runs all 30 seeded questions once; only valid trials contribute to its headline quality estimate. A task advances to five fresh attempts per arm when any platform's valid on/off pair disagrees, along with the first three seed-ordered tasks where every valid arm is correct; repeats remain separate from Round 1 and are capped at 12 discordant tasks, selected as the first two per question type in seed order, backfilled in global seed order if a type has fewer than two.

Deviation (2026-08-14): the cap was predeclared as the literal first 12 qualifying tasks in seed order. After Round 1 labels were seen, we found the generator's seed order groups ordinals by question type (00-04 knowledge-update through 25-29 temporal-reasoning), so the literal rule — selecting 00 01 03 04 06 07 08 09 10 11 12 13 from the 25 discordant tasks — would have excluded single-session-preference, single-session-user, and temporal-reasoning entirely, making them ineligible for the per-type summaries and the 115K confirm tier. The stratified rule above was fixed before any Round 2 trial ran; beyond the predeclared discordance trigger it conditions only on question type and seed order, never on outcome direction, magnitude, or platform, and its budget is identical. Amended selection: 00 01 06 07 10 11 15 16 21 22 25 26; controls (rule unchanged): 02 05 20. Invalid slots are rerun at most twice and otherwise reported as not evaluable. A task advances to 115K when a platform's five-attempt absolute on/off gap is at least 0.6 with at least four valid trials in both arms; confirm the top five seed-order-tiebroken tasks plus two concordant controls using exactly one calibrated pre-query compaction.

## Mem2Act tool-memory track

Mem2Act preparation downloads pinned upstream files but never vendors them because the upstream repository has no license file despite its README claiming MIT. Exactly 323/400 questions resolve to one raw source session; 77 unresolved questions are excluded rather than replaced with answer-leaking evolution metadata. Sample mode selects 40 deterministic, stratified tasks.

```bash
uv run python scripts/prepare-mem2act.py --selection sample \
  --output datasets-generated/mem2act

# One task across the three tool surfaces.
uv run harbor job start --config jobs/mem2act.yaml \
  --path datasets-generated/mem2act/qa_201 \
  --job-name mem2act-calibration --yes

# All 40 sample tasks. Use --selection full in an empty output directory for 323.
uv run harbor job start --config jobs/mem2act.yaml --yes
```

The hidden verifier reports exact tool, exact canonical arguments, and typed JSON-pointer parameter F1. Every agent uses the same semantic CLI, so Pi-specific `read`/`write` names do not contaminate the comparison.

## Layout

- `benchmarks/` pins upstream provenance, checksums, selections, and known exclusions.
- `src/pi_evals/` contains isolated adapters, trajectory conversion, and generators.
- `datasets/` contains checked-in Harbor tasks; `datasets-generated/` is ignored and reproducible.
- `jobs/` defines comparison arms; `scripts/report.py` reports raw rows and matched-arm on-minus-off mean deltas.

Inspect completed jobs with `uv run harbor view .harbor/jobs`.
