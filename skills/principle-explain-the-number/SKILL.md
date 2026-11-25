---
name: principle-explain-the-number
description: "Apply before you measure, and before you trust, report, or act on a number you measured: a speedup, a regression, a throughput, a latency, or an eval result. Find what limits it, and rule out that it measured something other than the work you think."
license: MIT
metadata:
  upstream-source: "https://github.com/cursor/plugins"
  upstream-path: "pstack/skills/principle-explain-the-number/"
  upstream-revision: "2dd5c0ccc5b207dc23a69759871a35954082cbf7"
  upstream-relationship: "adapted"
  upstream-license: "MIT"
  upstream-license-file: "LICENSE"
  upstream-baseline-kind: "recorded"
---

# Explain the Number

- **Write the decision before you run.** Name the result that would change it, and the noise floor. Stop when the run-to-run spread is larger than the effect.
- **Ask "why not double?"** Name the resource or code path that bounds the result, from a profile or counters taken during a run. A guess from reading the code is not a limiter.
- **List what else the number could be measuring** (errors, skipped or cached work, code that never ran, an untuned side, noise, a piece too small to matter) and rule out each one with evidence.
- **Keep the run count, the spread, and the limiter with the number.**

For an eval result, ask whether every run did the task, whether the gap holds across trials and models, and whether the scenario matters.
