# Waits

## Tools and command

`wait_start({label, condition, instruction, intervalSeconds?, timeoutSeconds?, checkTimeoutSeconds?})` opens a wait. The condition runs with `/bin/sh -c` in Pi's working directory at the time, in its own process group, with output discarded. It runs at once, then every `intervalSeconds` (default 15) until it exits 0. Each check is killed after `checkTimeoutSeconds` (default 30). `timeoutSeconds` (default 3600) is an absolute deadline from the start; time while Pi is closed counts. Every duration is at most 24 days, because Node's `setTimeout` overflows past about 24.8.

`wait_list({})` and `/waits` list live waits: state, last check result, label and ID. `wait_cancel({id})` ends a live wait without a wake.

Write conditions that fail closed and prove freshness. Exit 0 must be evidence that this run finished, such as a result ID the agent has not used yet. Missing input or an earlier run's output must not pass.

## Display

In the TUI, while any wait is live, the `waits.open` status shows ⏳ and the number of live waits, and the `waits.live` widget above the editor shows one row per wait: its label, last check result, time to the next check and time left. It redraws every second and lists at most five.

The transcript draws each wait as cards, from the same journal entries the runtime reads, so they also appear when the wait was opened from a Code Mode script and when a session is resumed:

- `waits:opened` shows the label, condition, interval and deadline, and the instruction when expanded.
- `waits:ended` shows a cancellation. A satisfied or expired wait draws nothing here, because the wake that follows carries the outcome.
- `waits:wake` shows one card per finished wait: its outcome and the instruction. The model still reads the full wake text.

Direct calls to the three tools render as one-line status rows.

## Lifecycle

Each live wait is an XState machine:

```text
open ─┬─ checking ──exit≠0──▶ waiting ──after(interval)──▶ checking
      │     └──exit 0──────────────────────────────▶ satisfied
      └─ deadline ──▶ expired
```

The session journal records two facts per wait: `waits:opened` (ID, owning session, spec, deadline) when it opens, and `waits:ended` (`satisfied`, `expired` or `cancelled`) when it ends. Each is appended before it takes effect. On `session_start` every wait this session opened and has not ended gets a new actor, which checks at once and keeps the original deadline. A wait whose deadline passed while Pi was closed expires at once.

Waits belong to the session, not to a branch: the journal is read across the whole session file, because an outcome happened in the world.

| Event | Waits |
| --- | --- |
| `/reload` | Stop, then resume from the journal |
| Quit, then relaunch the same session | Resume on startup; a finished wait wakes the agent with no prompt |
| Pi killed (`kill -9`) | Same as quit, since nothing is written at shutdown |
| `/resume` to the session | Resume |
| `/tree` | No change: an ended wait stays ended on every branch |
| `/new`, fork, clone | Nothing is inherited: a copied `waits:opened` names its original session |
| Print or JSON run | Refuses `wait_start` and resumes nothing, since the run ends with its prompt |

## Delivery

A finished wait waits for Pi to be idle: no agent run, no queued message and no extension dialog. Then each finished wait is journaled as ended, and one `waits:wake` custom message is handed to Pi with `triggerTurn: true`. It names each wait and repeats its instruction; an expired wait says so and asks the agent not to act on it unless the condition holds now. Journaling comes first, so delivery is at most once: a process that dies between the two steps loses that wake instead of repeating it. If journaling fails, nothing is sent, a warning is shown, and delivery is tried again later.

A wake says the condition held when it was checked. The agent should confirm the state before acting on it.
