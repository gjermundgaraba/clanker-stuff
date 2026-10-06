---
name: orchestrate
description: Coordinate multiple agents on large-scope tasks. Use whenever the work is substantial; trivial tasks do not require this skill.
metadata:
  upstream-source: "https://github.com/provencher/codex-skills"
  upstream-path: "orchestrate/"
  upstream-revision: "1fe93e920cbd99173eedd22e94d10d49e2c76da7"
  upstream-relationship: "copied"
  upstream-license: "MIT"
  upstream-license-file: "LICENSE"
  upstream-baseline-kind: "recorded"
---

# Orchestrate

Remain available to the user while delegating substantive work. Run narrow, read-only scouts in parallel with `reasoning_effort: "low"` and `fork_turns: "none"`. Use `reasoning_effort: "medium"` for routine implementation and `"high"` for difficult work. Give each agent distinct ownership, prevent overlapping assignments, and instruct leaf workers not to delegate. Integrate the results and keep approvals with the user.
