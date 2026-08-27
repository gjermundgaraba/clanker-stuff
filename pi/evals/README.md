# Pi evals

Harbor suites compare the configured Pi and Codex runtimes on `gpt-5.6-terra`. Run commands from `pi/evals`.

## Setup

```bash
uv sync
./runtime/build.sh
export PI_EVAL_AUTH_JSON_PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"
export CODEX_AUTH_JSON_PATH="$HOME/.codex/auth.json"
```

The Node 26 image builds the extension inside Linux, contains one frozen Pi dependency tree, and excludes the repository, reference solutions, and hidden tests. Verify packaging and graders without model calls:

```bash
uv run harbor job start --config suites/smoke/job.yaml --yes
```

## Compaction continuity

`paired.yaml` runs matched compaction-off/on arms for every configured platform. Automatic compaction is disabled; hidden task markers invoke each runtime's manual compaction path only in on arms.

```bash
# Calibrate once, then use the profile's three attempts for a reportable run.
uv run harbor job start --config profiles/paired.yaml \
  --path suites/compaction/tasks --n-attempts 1 \
  --job-name compaction-calibration --yes
uv run harbor job start --config profiles/paired.yaml \
  --path suites/compaction/tasks --job-name compaction-paired --yes
uv run python -m pi_evals.report .harbor/jobs/compaction-paired
```

Task quality is independent of protocol validity. A terminal failed or aborted compaction is recorded and the marked instruction still runs, so it makes `valid_experiment` zero without hiding `quality`; an ambiguous runtime failure still stops the trial. The canonical report filters quality to valid completed trials and separately reports request and compaction counts, completion yield, usage, ordinary/compaction cost, agent execution time, end-to-end wall time, and matched on-minus-off deltas. Harbor's raw reward aggregate is not the experimental comparison surface.

Costs are API list-price estimates, not account invoices or subscription charges. Native Codex reporting includes the standalone compaction response captured from app-server events.

Affected earlier debugging-continuity runs used a stale `route.test.js` digest, which capped attainable quality at 0.8. They are not comparable with corrected runs and must be rerun.

## LongMemEval

The pinned generator creates 30 questions in four generated paths across three conditions:

- `full/64k` and `full/115k`: history followed by the question; use `paired.yaml`.
- `evidence`: official evidence sessions only; use `off-only.yaml`.
- `handoff/115k`: 115K history, compaction, then verbatim evidence; use `on-only.yaml`.

```bash
uv run python suites/longmemeval/scripts/prepare-longmemeval.py

uv run harbor job start --config profiles/paired.yaml \
  --path suites/longmemeval/generated/full/64k \
  --job-name longmemeval-full-64k --yes

uv run python suites/longmemeval/scripts/judge-longmemeval.py \
  .harbor/jobs/longmemeval-full-64k \
  --backend codex --model gpt-5.6-sol --workers 4
uv run python suites/longmemeval/scripts/report.py \
  .harbor/jobs/longmemeval-full-64k
```

Run the other three generated paths with the profiles listed above and distinct job names. Add `--n-attempts 1` for calibration before paid repetitions.

The generated verifier's `quality` and `reward` are deterministic normalized exact match. The suite report leaves those raw values intact and presents semantic QA-judge quality in its second table; use QA quality for LongMemEval comparisons.

This is a compaction-oriented derivative: official LongMemEval sends history and question in one request. Do not publish these results as unmodified LongMemEval-S scores. Compare full on versus full off for the observed compaction effect; evidence and handoff are diagnostic bounds with different evidence positions.

## Mem2Act

Mem2Act provides the target tool, so this suite measures recovery of arguments from conversation memory, not tool selection. The pinned sample contains 40 stratified tasks from the 323 records that resolve to one source session.

```bash
uv run python suites/mem2act/mem2act.py --selection sample
uv run harbor job start --config profiles/off-only.yaml \
  --path suites/mem2act/generated --job-name mem2act-sample --yes
uv run python -m pi_evals.report .harbor/jobs/mem2act-sample
```

Use `--selection full` in an empty generated directory for all 323 tasks. The verifier reports exact canonical arguments as quality and typed JSON-pointer parameter F1 as a diagnostic.

## Add a suite

Add `suites/<name>/` with its tasks or generator, provenance pin when applicable, tests, and any suite-specific judge/report wrapper. Normal suites use the existing profiles with Harbor's `--path`; they do not change adapters or generic reporting.

The `pi_evals` manifest has exactly four keys: `platform`, `compaction_mode`, `expected_mechanism`, and `expected_protocol`. `expected_protocol` is required; set it to `null` when no protocol applies.

Every final verifier must emit finite `quality` and `reward` values in `[0, 1]`, binary `valid_experiment`, and `reward == quality`. Compaction graders copy `verifiers/compaction.mjs` beside the isolated grader and test that the copy is byte-identical.

Core adapters and reporting live in `src/pi_evals/`; shared profiles live in `profiles/`; the isolated image lives in `runtime/`. Inspect completed jobs with `uv run harbor view .harbor/jobs`.
