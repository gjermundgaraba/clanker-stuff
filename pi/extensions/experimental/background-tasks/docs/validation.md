# Validation

All scenarios use synthetic jobs and payloads. No service credentials or private session content are fixtures.

## Automated

The automatic-notification revision, including the manual-compaction readiness follow-up, passed all **72 package tests** (unit, integration, and smoke), package-scoped checks, repository-wide `vp check`, README policy, and test-boundary checks. The full repository test suite and manual Herdr exercise were not repeated for this revision.

The package has unit tests for strict framing, inbox reservations/coalescing/eviction, automatic delivery and retry, bounded logs, schemas and tool output. Real subprocess tests cover spawn/exit failures, missing results, record floods, cancellation, deadlines, concurrency, inherited-pipe drain, TERM-resistant descendants, and history pruning.

Real Pi 0.85.0 sessions verify:

- Spawn handoff before completion, idle triggered notices, metadata-only delivery and pull inspection.
- Busy buffering and a competing extension starting a run between the readiness check and send; the follow-up is queued without interrupting that run.
- Automatic delivery of tasks completed during manual compaction, after success, failure, or cancellation. All three regression cases reproduced the stalled notification before the readiness fix.
- Both TUI and RPC deliver notifications without confirmation. Aborted responses do not hold later notifications.
- Task listing and inspection through `/tasks`, and agent-callable cancellation through `task_stop`.
- Payload continuation survives numeric serialization expansion and UTF-8 boundaries; summary log reads fit after invalid-byte expansion.
- Notification observation automatically releases reservations; retained payloads remain inspectable.
- Ancestral ownership and no resurrection after tree navigation.
- Agent stop during terminal cleanup waits for completion without overwriting the accepted result.
- A stale queued notice is removed before provider context on a new branch.
- Reload cleans processes and rebuilds empty live state.
- Actual SDK runtime clone/fork/new/resume replaces ownership without PID reconnection.

A smoke test discovers the package through Pi's package loader. These tests do not assert model obedience, crash-proof containment or crash-safe delivery.

Run from the repository:

```sh
vp test pi/extensions/experimental/background-tasks
vp check pi/extensions/experimental/background-tasks
vp run ready
```

## Historical validation (before automatic notifications)

The following runs tested earlier approval/budget behavior, which has been removed. They are historical evidence only, not the current notification contract. The automatic-notification revision has not been manually exercised in Herdr.

The targeted cleanup revision passed `vp run ready`: **174 test files and 1,610 tests**, including **70 package tests**. All repository static, packaging, README, and test-boundary checks passed. New regressions cover deduplicated pause checkpoints with failed-write retry, provider abortion without an aborted signal, literal relative/absolute working directories, omitted arguments, and failed-cleanup reconciliation. Process tests use real children with narrowly simulated process-group probe/signal failures to verify absent, live, permission-denied, and still-running-child cases, plus a gated log close to verify cleanup completion ordering.

Before the event-discovery follow-up, the explicit-authorization and retrieval revision passed `vp run ready`: 174 test files and 1,599 tests repository-wide, including 59 tests in this package. Formatting, lint, types, package readiness, README policy, test boundaries, and the bundled-review asset check also passed.

The event-discovery follow-up passed all 61 package tests and scoped formatting, lint, and type checks. Added coverage verifies discovery across all 137 retained events at per-task capacity, metadata fitting within the response budget, and a real session retrieving the oldest of ten held observations without previously knowing its ID. The repository-wide suite and manual Herdr exercise were not repeated for this follow-up.

### Targeted cleanup manual Herdr exercise

On macOS with Pi **0.85.1**, a fresh isolated Herdr tab loaded the local extension and a disposable faux-provider driver via `pi -e`, without installation or external model/API calls.

- A real `task_start` omitted `args` and ran `/bin/pwd` with `cwd: "@foo"`, alongside a distinct `foo` directory. Inspection returned the literal `@foo` path and clean completion.
- TUI confirmation granted eight credits; the pending completion consumed one. A provider-returned aborted message held notifications. Two subsequent `/tasks pause` commands produced no duplicate checkpoint: native session records contained exactly `(8, false)`, `(7, false)`, `(7, true)`.
- Quit returned the pane to its shell. The synthetic child PID was absent, task logs were removed, and the owned tab and temporary fixtures were deleted.

Herdr again missed some short-turn/dialog lifecycle transitions; terminal UI and native session records supplied the verification. Failed-cleanup OS errors and checkpoint-write failures were tested automatically, not induced manually. Earlier lifecycle and payload manual scenarios below were not repeated for this targeted revision.

### Revision manual Herdr exercise

The revised code was exercised on macOS with Pi **0.85.1**, in a dedicated background Herdr tab, using explicit local `pi -e` paths and no installation. A disposable driver extension used Pi's built-in faux provider to script actual tool calls; there were no external model/API calls.

Verified against terminal UI, the synthetic session's native records, and process probes:

- Starting and inspecting a completed watcher left one held notice and zero wake credits. Declining `/tasks resume` left authorization unchanged.
- A valid watcher record containing 2,500 numbers expanded to 55,001 bytes when serialized. `task_inspect` retrieved it in four JSON-text pages; concatenation reconstructed all values. Every tool response stayed below 32,000 bytes (the largest observed was 19,177 bytes).
- `task_dismiss` cleared the pending notice without granting credits or removing the retained task.
- A second completed watcher stayed held until the TUI confirmation was accepted. Exactly one metadata-only custom notice was appended; version-2 checkpoints recorded eight credits at confirmation and seven after dispatch. Subsequent ordinary prompts did not replenish credits.
- Reload stopped a live synthetic server and exposed an empty task list with seven credits. Quitting stopped another live server. All four synthetic task PIDs were absent afterward, and the owned Herdr tab was closed.

Herdr did not consistently classify the confirmation dialog or short post-reload turns as working/blocked. Actual dialog rendering, native session entries, and PID checks were used instead of treating `agent_prompt_stalled` as execution failure.

### Original manual Herdr exercise (before explicit-only authorization)

The original implementation was manually driven on macOS through a dedicated Herdr tab, using Pi **0.85.1** and explicit local `-e` paths, without installation. A disposable second extension registered Pi's built-in faux provider with scripted tool calls and slow streaming. This kept model output deterministic while exercising the real TUI, tool execution, queue, session files, and process lifecycle; no external model/API calls were made.

Launch shape (replace paths):

```sh
pi --offline --no-extensions \
  -e /absolute/path/to/background-tasks/index.ts \
  -e /temporary/path/to/synthetic-driver.ts \
  --no-skills --no-context-files --no-prompt-templates \
  --provider bg-manual --model scripted \
  --session-dir /temporary/path/to/sessions
```

Observed:

- A delayed watcher returned a running task ID before its result; the settled session then displayed a metadata-only result notice and consumed one wake credit.
- Invalid JSON on stdout produced a distinct `protocol_error`; inspection showed the diagnostic and original stdout.
- Reload killed a running synthetic server; `kill(pid, 0)` reported it absent.
- Escape during a slowly streamed automatic wake held the later terminal result: the footer showed one held event with seven credits. Confirming `/tasks resume` delivered it once and cleared the held count.
- `/new` and `/clone` stopped owned servers and presented empty live task state, rather than restoring historical PIDs.
- A synthetic command drove the public `ctx.navigateTree()` API back to a marked entry: the ancestral server survived, the later server stopped, and no abandoned-task notice was delivered.
- `task_stop` returned `cancelled` with clean process-group cleanup. Quitting a subsequent server session also removed its process. All nine synthetic task PIDs were absent after shutdown.

Herdr sometimes reported `agent_prompt_stalled` for short turns and slash commands whose lifecycle transitions were too fast to observe. Terminal output, synthetic session records, and PID checks—not that wait status—were used as evidence.

Manual tests complement the automated suite; they do not establish Linux/Windows behavior or external-service integration.
