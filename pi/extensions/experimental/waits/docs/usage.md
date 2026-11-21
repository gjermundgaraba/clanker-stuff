# Waits

## Tools and command

`wait_start({label, condition, instruction, cwd?, intervalSeconds?, timeoutSeconds?, checkTimeoutSeconds?})` opens a wait. The condition runs with `/bin/sh -c` in `cwd` (default: Pi's), in its own process group, with output discarded. It runs at once, then every `intervalSeconds` (default 15) until it exits 0. Each check is killed after `checkTimeoutSeconds` (default 30). `timeoutSeconds` (default 3600, at most 7 days) is an absolute deadline from the start, and time while Pi is closed counts.

`wait_list({})` lists this branch's waits. `wait_cancel({id})` ends an open or satisfied wait without a wake. `/waits` shows the same list. In the TUI, `waits.open` shows ⏳ and the number of open or satisfied waits.

Write conditions that fail closed and prove freshness. Exit 0 must be evidence that this run finished, such as a result ID the agent has not used yet. Missing input or an earlier run's output must not pass.

## Lifecycle

Each wait is an XState machine:

```text
open ─┬─ checking ──exit≠0──▶ waiting ──after(interval)──▶ checking
      │     └──exit 0───────────────────────────────▶ satisfied ──delivered──▶ fired
      ├─ deadline ──▶ expired
      └─ cancel ────▶ cancelled            (satisfied also accepts cancel)
```

Every change of top-level phase is appended to the session as a `waits:wait` entry holding the actor's persisted snapshot. Polling between `checking` and `waiting` writes nothing. On `session_start` and `/tree` navigation, the newest entry of each wait on the current branch is restored with `xstate/persist`. Timers keep their original deadlines, so an overdue check runs at once, and a wait whose deadline passed while Pi was closed ends as expired. A check interrupted by shutdown runs again.

| Event | Waits |
| --- | --- |
| `/reload` | Stop, then restore from the journal |
| Quit, then relaunch the same session | Restore on startup; a satisfied wait wakes the agent with no prompt |
| Pi killed (`kill -9`) | Same as quit: nothing is written at shutdown, so the journal is already complete |
| `/resume` to the session | Restore |
| `/new`, fork, clone | Nothing is inherited: entries carry the session id that opened them |
| `/tree` | The waits of the new branch, as journaled there |

Print and JSON modes refuse `wait_start`, because those processes end when their prompt does.

## Delivery

A satisfied wait waits for Pi to be idle: no agent run, no queued message, no extension dialog and no compaction. Then each satisfied wait is journaled as `fired`, and a single `waits:wake` custom message is handed to Pi with `triggerTurn: true`. It contains each wait's ID, label and instruction. Journaling comes first, so delivery is at most once. A process that dies between the two steps loses that wake instead of repeating it, and `wait_list` still shows the wait as fired.

A wake says the condition held when it was checked. The agent should confirm the state before acting on it.
