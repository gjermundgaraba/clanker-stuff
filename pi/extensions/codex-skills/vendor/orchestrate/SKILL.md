---
name: orchestrate
description: Coordinate multiple agents on large-scope tasks. Use whenever the work is substantial; trivial tasks do not require this skill.
---

# Orchestrate

Remain available to the user while delegating substantive work. Run narrow, read-only scouts in parallel without parent history: use `fork_turns: "none"` when `spawn_agent` exposes `fork_turns`; when it exposes `fork_context`, omit `fork_context` or set it to `false`. When `spawn_agent` exposes `reasoning_effort`, use `"low"` for scouts, `"medium"` for routine implementation, and `"high"` for difficult work; otherwise omit that field. Give each agent distinct ownership, prevent overlapping assignments, and instruct leaf workers not to delegate. Integrate the results and keep approvals with the user.
