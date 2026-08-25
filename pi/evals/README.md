# Pi evals

Harbor tasks for comparing vanilla Pi, Pi with `codex-provider`, and native Codex across compaction continuity, long-term memory, and argument grounding. The adapters resume native multi-step sessions and normalize successful compactions into ATIF v1.7 trajectories.

## Setup

Run commands from this directory.

```bash
uv sync
./scripts/build-runtime.sh
export PI_EVAL_AUTH_JSON_PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"
export CODEX_AUTH_JSON_PATH="$HOME/.codex/auth.json"
```

The Linux/Node 24 image contains one frozen Pi dependency tree shared by the CLI and provider extension, pinned Codex CLI, and the portable `mem2act` command. The repository, reference solutions, and hidden tests are absent during agent execution. Run the no-provider packaging smoke with:

```bash
uv run harbor job start --config jobs/smoke.yaml --yes
```

## Compaction continuity

The compaction job has six matched arms: compaction off/on for vanilla Pi, Pi with `codex-provider`, and native Codex. Automatic compaction is disabled in every arm. At each hidden task boundary, off arms continue unchanged while on arms invoke that runtime's native manual compaction API. The marker is removed before the model sees the next instruction.

```bash
uv run harbor job start --config jobs/compaction-matrix.yaml --yes
./scripts/report.py .harbor/jobs/compaction-matrix
```

Verifiers report end-state quality separately from attempt, success, mechanism, exact boundary, and continuation validity. A missed, failed, misplaced, or extra compaction invalidates an on-arm experiment; it is not scored as an incorrect task answer.

The report reads per-request metrics from the final trajectory and separates ordinary model calls, compaction calls, and their total. Native Codex usage comes from transient app-server response events, so its standalone compaction request is included. Dollar values are API list-price equivalents, not an account invoice or subscription charge.

## LongMemEval compaction track

The generator pins cleaned LongMemEval-S and its evidence-only file by immutable revision and SHA-256. It selects 30 seeded questions balanced across all six question types, retains every official evidence session, and creates these derived conditions:

- `full/64k`: six chronological, token-balanced history steps.
- `full/115k`: ten chronological, token-balanced history steps.
- `evidence`: only the official evidence sessions, rendered with the source history's dates and content.
- `handoff/115k`: the identical 115K history and compaction boundary, then verbatim evidence immediately before the question.

```bash
uv run python scripts/prepare-longmemeval.py

# Calibrate all 30 questions once before paid repetitions.
uv run harbor job start --config jobs/longmemeval-64k.yaml \
  --n-attempts 1 --job-name longmemeval-64k-calibration --yes

# Fixed reportable protocol: 30 questions × 3 attempts in each job.
for config in longmemeval-64k longmemeval-115k \
  longmemeval-evidence longmemeval-handoff-115k; do
  uv run harbor job start --config "jobs/$config.yaml" --yes
done
```

Controlled on arms explicitly invoke exactly one compaction after the final full-history step: segment 5 at 64K or segment 9 at 115K. Evidence has three compaction-off surfaces; handoff has the three compaction-on surfaces and rejects any compaction after evidence is reintroduced.

The in-task `exact_normalized` score is a deterministic lower bound. Apply the task-specific LongMemEval semantic rubrics with `gpt-5.6-sol`, then report each job:

```bash
./scripts/judge-longmemeval.py .harbor/jobs/JOB_NAME \
  --backend codex --model gpt-5.6-sol --workers 4
./scripts/report.py .harbor/jobs/JOB_NAME
```

Interpret the conditions as diagnostics, not interchangeable benchmark scores. `full-on − full-off` is the observed compaction effect. `full-on − handoff` approximates summary information loss but is also affected by evidence position; `handoff − evidence` measures interference from carrying compacted residue; `full-off − evidence` measures long-context retrieval cost without compaction.

This is a compaction-oriented derivative because official LongMemEval sends history and question in one request. Do not publish these numbers as unmodified LongMemEval-S results.

## Mem2Act argument-grounding track

Mem2Act's main condition provides the target tool, so this track measures recovery of its arguments from conversation memory; it does not measure tool selection. Preparation downloads pinned upstream files but never vendors them because the upstream repository has no license file despite its README claiming MIT. Exactly 323/400 questions resolve to one raw source session; the 77 unresolved questions are excluded rather than replaced with answer-leaking evolution metadata.

```bash
uv run python scripts/prepare-mem2act.py --selection sample \
  --output datasets-generated/mem2act
uv run harbor job start --config jobs/mem2act.yaml --yes
```

Sample mode selects 40 deterministic, stratified tasks and the fixed job runs three attempts per agent. Use `--selection full` in an empty output directory for all 323. The hidden verifier reports exact canonical arguments and typed JSON-pointer parameter F1. Every agent uses the same semantic CLI, so adapter-specific native tool names do not affect the score.

## Layout

- `benchmarks/` pins upstream provenance, checksums, selections, and exclusions.
- `src/pi_evals/` contains isolated adapters, trajectory conversion, and generators.
- `datasets/` contains checked-in tasks; ignored `datasets-generated/` is reproducible.
- `jobs/` defines fixed comparison arms; `scripts/report.py` reports validity, quality, usage, and matched-arm deltas.

Inspect completed jobs with `uv run harbor view .harbor/jobs`.
