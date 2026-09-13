# Ledger scaling and memory suites

Run commands from `pi/evals`. See [setup](../README.md#setup) first.

## Three-arm volume scaling

`pi_evals.scaling` schedules 18 fresh sessions: 40, 240 and 960 ledger records, two new matched fixture seeds per size, and Pi without Code Mode, Pi with Code Mode, and native Codex. Each seed produces nested-prefix datasets across sizes. Every fixture uses 20 records per page, constant noise per record, 150 ms service latency, opaque cursors and a real concurrency cap of one. The six fixture blocks use all six arm-order permutations, balancing each arm's position globally.

```bash
uv run python -m pi_evals.scaling prepare --output /tmp/astra-scaling \
  --catalog /path/to/latest-codex-checkout/codex-rs/models-manager/models.json
uv run python -m pi_evals.scaling preflight --output /tmp/astra-scaling
uv run python -m pi_evals.scaling run --output /tmp/astra-scaling
uv run python -m pi_evals.scaling report --output /tmp/astra-scaling
```

Preparation builds its own AMD64 runtime base (no pilot images required), resolves the latest Codex release, generates new seeds, and freezes source/task/config hashes and image IDs. Each three-arm block shares one fixture and image. Preflight exercises all six fixtures through direct tools and the actual Pi/native Code Mode hosts without model-service access, with independent Python oracle tests, positive/negative runtime-catalog checks, actual grader execution, byte parity, budget enforcement, opaque-cursor rejection and concurrent requests proving the service cap. Runtime-invalid trials stop further spending; correctness failures remain outcomes.

The reference needs 3, 13 and 49 underlying operations; budgets are 4, 14 and 50, respectively. Reports retain all 18 scheduled trials and summarize correctness, requests, tokens, time and estimated cost per size/arm. This is a volume-scaling diagnostic: record count, pages and total irrelevant bytes grow together. It does not isolate independent noise, latency or concurrency effects, and two seeds do not establish precise reliability estimates.

The supported tool catalog is just `list_records` and `submit_report`; shell,
filesystem, and unrelated mutation tools are absent. Scores include exact quality,
tenant-row accuracy, total correctness, and budget compliance. Pi Code Mode gets
parsed objects; Pi without Code Mode and native Codex get JSON strings. This is a
fresh diagnostic, not a continuation of the older four-tool screening runs.
Output directories must be new. Model attempts are never retried.

Preflight retries keep numbered attempt directories without rebuilding fixtures or
changing the frozen Codex version. A malformed native service argument is ordinary
tool-error feedback, just as in Pi, and the free controls exercise correction afterward.
The scaling extension registers the provider lifecycle without its shell/file tool
controller; its extension and grader composition live with the fixture.

Scaling freezes its execution dependencies, not unrelated suites, `report.py`, or
`scaling_report.py`. Reports record current analysis-source provenance separately.
Shared trial extraction and validity policy in `trials.py` remain execution inputs.

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

Generation requires an empty destination and never replaces existing tasks.
Run the other three generated paths with the profiles listed above and distinct job names. Add `--n-attempts 1` for calibration before paid repetitions.

The generated verifier's `quality` and `reward` are deterministic normalized exact match. The suite report leaves those raw values intact and presents semantic QA-judge quality in its second table; use QA quality for LongMemEval comparisons.

The optional `--backend openai` judge uses the pinned `openai==2.54.0` SDK and
requires `OPENAI_API_KEY`. One client is shared across workers and closed after
they finish. Requests still use `https://api.openai.com/v1/chat/completions`,
`temperature=0`, `max_tokens=10`, `n=1`, and a 60-second timeout (per HTTP phase,
not an overall deadline). Only the legacy `OPENAI_ORGANIZATION` variable controls
the organization; `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, and `OPENAI_PROJECT_ID` are
ignored. Unset `OPENAI_CUSTOM_HEADERS`: the judge rejects it rather than allowing
SDK environment headers to override authentication or routing. The default Codex
backend neither imports nor initializes the SDK and is unaffected by these variables.

This changes the OpenAI transport policy intentionally: five SDK retries allow
at most six attempts, now including connection failures, timeouts, HTTP 408/409,
429, and all 5xx responses. The old transport retried only 429/500/502/503/504.
SDK retries use jittered exponential backoff (starting at 0.5 seconds, capped at
8 seconds), honor `Retry-After`/`retry-after-ms` delays up to 120 seconds and
`x-should-retry`, and stop if the requested delay exceeds 120 seconds. Failures
now raise SDK `APIStatusError` subclasses, `APIConnectionError`, or
`APITimeoutError`, not urllib exceptions. A retried request can incur additional
judge cost, particularly when a response is lost after the server completes it.

Cache filenames remain `longmemeval-judge-<backend>-<model>.jsonl`, and valid
identity-matching judgments are reused by default, including historical urllib
judgments. Changed inputs still require fresh calls. Use `--rejudge` to explicitly
replace all current judgments with fresh calls; this may incur judge cost. Save a
copy first if you need to retain the previous judgments for comparison. Cache rows
record backend/model and inputs, not transport provenance: reusing a historical row
does not make it an SDK judgment. The dependency pin and transport policy above
describe fresh OpenAI calls. Reports require `--judge-cache` when multiple judge
caches exist in a job directory.

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

Compaction suites retain the strict, persisted four-key `pi_evals` manifest: `platform`, `compaction_mode`, `expected_mechanism`, and `expected_protocol`. `expected_protocol` is required; set it to `null` when no protocol applies.
Code Mode manifests additionally require `experiment: code-mode`, `arm`, `tool_mode`, and
`pair_id`; both arms retain the real `pi-provider` platform and `compaction_mode: off`.
The adapter and verifier check the requested mode against per-request runtime evidence.

Every final verifier must emit finite `quality` and `reward` values in `[0, 1]`, binary `valid_experiment`, and `reward == quality`. Compaction graders copy `verifiers/compaction.mjs` beside the isolated grader and test that the copy is byte-identical.

Core adapters and reporting live in `src/pi_evals/`; shared profiles live in `profiles/`; the isolated image lives in `runtime/`. Inspect completed jobs with `uv run harbor view .harbor/jobs`.
