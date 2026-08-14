# Pi evals

Harbor tasks for evaluating Pi across coding, tool use, and context compaction. The adapters preserve native multi-step sessions and normalize Pi, the Codex provider extension, and Codex CLI into ATIF v1.7 trajectories.

## Run

Run commands from this directory.

```bash
uv sync
./scripts/build-runtime.sh
uv run harbor job start --config jobs/smoke.yaml --yes
```

The smoke job uses Harbor's Oracle agent and makes no model calls. The runtime is Linux, Node 24, and contains only pinned production packages; reference solutions and hidden tests are not present during agent execution.

Run the normal Pi coding and native-tool tasks after pointing the adapter at a Pi authentication file:

```bash
export PI_EVAL_AUTH_JSON_PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"
uv run harbor job start --config jobs/pi.yaml --yes
```

The compaction matrix uses the same model, reasoning effort, prompts, and empirically aligned boundaries across vanilla Pi, Pi with `codex-provider`, and pinned Codex CLI. Deterministic shell output creates removable context pressure without depending on tool names. It requires both Pi and Codex credentials:

Pi compacts at 25,000 tokens and Codex CLI at 45,000 because their system prompts and tool-result accounting differ; both thresholds target the same pressure phase.

```bash
export PI_EVAL_AUTH_JSON_PATH="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/auth.json"
export CODEX_AUTH_JSON_PATH="$HOME/.codex/auth.json"
uv run harbor job start --config jobs/compaction-matrix.yaml --yes
./scripts/report.py .harbor/jobs/compaction-matrix
```

Inspect completed jobs with:

```bash
uv run harbor view .harbor/jobs
```

## Layout

- `src/pi_evals/` contains isolated Pi and Codex CLI adapters plus ATIF conversion.
- `datasets/` contains normal Harbor task directories; add scenarios without changing the runner.
- `jobs/` selects task groups, comparison arms, and attempt counts.

Compaction verifiers report correctness facts separately from experiment validity, mechanism, boundary, continuation, token usage, cost, and latency. Pi stdout remains raw in `pi-events.jsonl`; stderr is separate in `pi-stderr.log`.
