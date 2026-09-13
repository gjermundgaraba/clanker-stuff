# FrontierSWE v2 Qubit Routing: pilot closeout

## Conclusion

The three-arm fixed-budget harness works. Two additional rounds produced six
valid, captured and graded submissions, each solving all 526 circuits.
Native Codex had the highest mean score across these two rounds. Pi with Code
Mode produced the best individual submission but also the largest score spread.
This does not establish a general harness ranking or a reliable Code Mode gain.

The pilot is complete; additional spending should test a different workload
rather than repeatedly sampling this task until a preferred arm wins.

## Verified results

Higher scores mean more efficient routing under the unchanged upstream scorer.
Correctly solving a circuit alone does not guarantee a positive score.

| Arm                  | Repeat 1 | Repeat 2 |     Mean | Mean recorded cost |
| -------------------- | -------: | -------: | -------: | -----------------: |
| Pi without Code Mode | 0.809768 | 0.810489 | 0.810129 |              $8.30 |
| Pi with Code Mode    | 0.769516 | 0.825511 | 0.797514 |              $6.51 |
| Native Codex         | 0.819621 | 0.821918 | 0.820770 |              $6.58 |

Four trials finished voluntarily. Pi with Code Mode in repeat 1 and native Codex
in repeat 2 reached the declared 30-minute deadline; these are valid fixed-budget
outcomes, not voluntary completions. No Pi recovery attempts or errored responses
were recorded in these six trials. Native recovery counts are not exposed by the
summary; all native runtime evidence and trajectory conversions passed.

Total recorded cost: **$42.76**. Unreported usage from interrupted requests may
be missing. The trial window, including intermediate grading, was approximately
3 hours 18 minutes; final grading followed it.

Order was Pi with Code Mode / native Codex / Pi without Code Mode, then native
Codex / Pi without Code Mode / Pi with Code Mode. Each slot ran once. No failed
attempts were discarded from this series.

## Frozen protocol

- Model: `gpt-6-astra`, high reasoning, all three arms.
- One task: FrontierSWE v2 Qubit Routing, source revision
  `9e3f71cac38ef3d7e14a41b361c7b2b54c59899b`.
- Agent budget: 1,800 seconds, plus 90 seconds for cleanup only; 4 CPUs, 16 GiB,
  Linux AMD64. Upstream's published budget is 20 hours: this is not a leaderboard run.
- Pi transient recovery: three consecutive retries maximum, 2/4/8-second
  backoff, no provider-level retries. Native Codex retains released recovery.
  All recovery counts against the original deadline. No whole-trial retries.
- Compaction disabled. Agent network follows the existing harness policy;
  fresh grading containers have networking disabled. Hidden grading assets are
  absent from the agent image.
- Native Codex: `0.154.0`, resolved as latest during preparation and frozen across
  preflight and both rounds.
- Agent image:
  `sha256:af245a4f58878af29cb16865514562cfb7c959c1ecc56405812ab37b024f03f0`.
- Grader image:
  `sha256:f406c7583d2cb2895a4795e4082f4d4f23d7b8ce92fb78f7352caadc2214112c`.

## Evidence and remaining limits

Local evidence lives under `pi/evals/.harbor/frontier-repeats/`:

- `summary.json` and `report.json`: results and interpretation.
- `series.json`, `schedule.json`, `frozen.json`, `configs/`: protocol and provenance.
- `jobs/`, `grading/`, `preflight/`: raw logs, actual submissions and grading evidence.

The closeout was derived from `summary.json` with SHA-256
`f557bf6049c1b79d3350c8151cb267c958048018ee8c80b6e47dce80e2c5ec54`.
This Markdown file is outside ignored output storage; raw evidence remains local
and ignored, not an off-machine archive. Review raw logs for credentials before
sharing or publishing them.

Earlier `/tmp/astra-frontier-qubit-v4` artifacts were no longer available when
the repeats started. Its conversationally reported scores are excluded from
these verified aggregates. The new frozen agent image also differs from that
earlier run, so the results are not presented as a single three-repeat experiment.

Remaining limits: one selected task, two observations per arm, unequal native/Pi
recovery implementations, and no reliable legacy underlying-operation counts.
Upstream thread-based timeouts can wait for worker shutdown; pathological routers
may block until the driver cap. Preserve these caveats in any external comparison.
