# Pi evals

Private Harbor evaluation tooling for **Pi without Code Mode**, **Pi with Code Mode**,
and **native Codex**. Run commands from `pi/evals`.

The supported harness comparisons are [Frontier Qubit Routing](#frontierswe-v2-qubit-routing-pilot)
and [ledger volume scaling](docs/suites.md#three-arm-volume-scaling).
See the [verified Frontier results](results/frontier-qubit-routing.md).
The pre-existing [memory and compaction suites](docs/suites.md#compaction-continuity)
remain separate experiments, not Code Mode comparisons.

## Setup

Requires Node 26+, Python 3.12+, uv, and Docker with Linux AMD64 support.

```bash
uv sync
export PI_EVAL_AUTH_JSON_PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"
export CODEX_AUTH_JSON_PATH="$HOME/.codex/auth.json"
```

Authenticate Pi and Codex before paid runs. Frontier preparation builds its own images,
resolves the latest published Codex, and freezes versions across preflight and measurement.
Scaling also builds its own runtime and freezes the latest Codex.
Use `./runtime/build.sh` for the memory/compaction suites' baseline image;
it is not a latest-Codex comparison series.

## Validation

```bash
uv run python -m unittest discover -s tests
# From the repository root:
vp check pi/evals
```

Preflight below exercises real containers without model calls. A work deadline is
a valid fixed-budget outcome; a runtime, telemetry or capture failure is not.
Keep failed attempts and unknown usage visible, rather than selecting successful retries.

A failed no-model preflight can be rerun with the same command and frozen inputs.
Each attempt keeps its logs, input identity and status under `preflight/attempt-NNNN/`.
A successful matching preflight is reused. Neither path repeats model trials or
refreezes a series.

## FrontierSWE v2 Qubit Routing pilot

`pi_evals.frontier` runs one released Python algorithm-optimization task with
Pi without Code Mode, Pi with Code Mode, and native Codex. The prompt and upstream
0–1 scoring are unchanged. The default agent budget is 30 minutes rather than the
published 20 hours, so this is a capped harness comparison, not a leaderboard run.

```bash
mkdir -p .cache/checkouts
git clone --filter=blob:none https://github.com/Proximal-Labs/frontier-swe-v2.git .cache/checkouts/frontier-swe-v2
git -C .cache/checkouts/frontier-swe-v2 checkout 9e3f71cac38ef3d7e14a41b361c7b2b54c59899b
uv run python -m pi_evals.frontier prepare --output .harbor/frontier-qubit \
  --upstream .cache/checkouts/frontier-swe-v2
uv run python -m pi_evals.frontier preflight --output .harbor/frontier-qubit
uv run python -m pi_evals.frontier run --output .harbor/frontier-qubit
uv run python -m pi_evals.frontier report --output .harbor/frontier-qubit
```

Preparation resolves the latest published Codex and freezes its version, matched
agent image, separate grader image, task/config snapshots and execution sources.
Driver, trial-state/usage policy, adapter, protocol, runtime and verifier changes block
continuation. Frontier's reporter is separate: presentation and aggregation changes
are recorded as provenance, not enforced as execution inputs. Spending and recovery
decisions read trial evidence directly, never report output.
All arms use Astra/high, 4 CPUs, 16 GiB and AMD64, with compaction off.
Pi uses its built-in transient-error recovery: at most three consecutive retries
with 2/4/8-second backoff and no provider-level retries. Native Codex retains its
frozen released recovery behavior. All recovery counts against the original
30-minute work budget. Whole-trial retries remain disabled.
The agent runs non-root with the public simulator and training circuits; hidden
circuits, scoring anchors and the greedy reference are removed from its image.
Harbor only exports Python source and validates runtime evidence. The original
verifier grades that source in a fresh, network-disabled container. Agent network
policy follows the existing coding harness rather than enforcing upstream's offline
sandbox. Proximus continuation and submit-tool behavior are not reproduced.

The free preflight provisions agent-owned runtime/log directories and checks actual
non-root Pi startup in both modes without network access, Harbor export, empty/wrong submissions, the upstream
greedy baseline over the full test pool, its exact agent-image export roundtrip,
simulator tampering and scoring anchors. There is no executable optimal oracle.
Retain upstream `reward`, circuits solved and category scores separately: a valid
complete circuit may still score zero if it does not improve on the greedy anchor.
The upstream thread timeout waits for executor shutdown, so a pathological router
can block until the whole driver timeout; affected results need explicit review.

One attempt per arm is descriptive. Reports omit known-bad legacy underlying-operation
counts; newly converted traces use cell-scoped identities and deduplicate repeated waits.
Pi telemetry uses a queued `eval-events.jsonl` sidecar, separate from its JSON stdout.
Unknown pricing stays null without discarding tokens or independently captured scores.
Runtime-invalid evidence stops spending after capture and grading. `run --resume`
continues unstarted slots or grades captured trials; it never retries a started model trial.
Grading retries retain numbered attempt directories, logs and status under `grading/`,
require unchanged grading inputs, and reuse an already successful result. Even a failed
Harbor attempt can be graded diagnostically; that does not make it comparison-eligible
or permit further model spending. Historical frozen series are not refrozen or migrated.
The default $20 observed-cost checkpoint is between trials, not an in-flight cap.
Upstream content is provided for evaluation purposes, not under a root permissive license.

The runner now journals each completed native model response immediately and uses
a host-side work deadline with 90 seconds of cleanup grace. At cutoff it kills
all dedicated agent-user processes, including detached tools, then captures the
actual Python source independently of trajectory conversion. The free Harbor
preflight exercises this cutoff with a detached writer and an intentional telemetry
failure. Budget-exhausted submissions are scored; unrecovered stream-error partial submissions
are marked diagnostic and never retried. Unknown runtime evidence stops spending
after preserving and grading the captured source. Reports expose cutoff status,
capture hashes, and comparison eligibility separately from task scores.
Historical failed trials and replayed edits remain diagnostic, not repaired
benchmark results. Fresh comparisons must rerun all three arms with frozen sources.

For two additional rounds with rotated arm order, prepare one series with
`--rounds 2 --order-offset 1`. This schedules Code Mode / native / direct, then
native / direct / Code Mode, using one latest-Codex resolution and one frozen
image throughout calibration and all six trials. Each slot has its own logs,
capture, grade and start marker. Reports retain failed slots and aggregate only
valid scored outcomes, with sample counts; recorded costs include failed trials.
Use `run --cost-checkpoint 40` for this six-trial series (between trials, not an
in-flight spending limit). Prefer a persistent output directory such as
`pi/evals/.harbor/frontier-repeats` rather than temporary storage.
