# Validation

All scenarios use synthetic jobs and payloads. No service credentials or private session content are fixtures.

## Automated

Unit tests cover:

- Strict watcher framing.
- Per-task notices: keyed replacement, record and byte caps, unread outcome and events, and clearing.
- Bounded in-memory log tails.
- Closed input schemas, structured output for every tool, and the cut text preview.
- Notice clearing by agent reads and stops but not by human, list or failed reads.
- Native TUI statuses and idle-only delivery: held while busy or while a dialog is open, delivered at settlement or dialog end.
- Renderers, including stored results whose details no longer match the schema.

Real-subprocess tests cover every outcome, failed and cancelled starts leaving no task, admission and unread-retention limits, discarding orphaned tasks, TERM-resistant process groups, and the inherited-pipe drain.

Real `AgentSession` tests verify:

- Native Code Mode calls and Pi permission blocking.
- Literal working directories.
- A completion during a busy run arrives as one new run after settlement.
- Metadata-only notices in TUI and RPC, with payloads and logs pulled by inspection.
- Complete structured values through Code Mode.
- Notices held while an extension dialog is open, and delivered after manual compaction succeeds, fails or is aborted.
- An outcome read before cleanup finishes produces no later notice.
- A failed start reports its cause with no task or notice.
- `/tasks` output, `task_stop`, tree-navigation ownership, and reload.
- SDK runtime clone, fork, new and resume stop every task without reconnection.

A smoke test discovers the package through Pi's package loader. These tests do not assert model obedience, crash-proof containment or crash-safe delivery.

Run from the repository:

```sh
vp test --project unit pi/extensions/experimental/background-tasks
vp test --project integration pi/extensions/experimental/background-tasks
vp test --project smoke pi/extensions/experimental/background-tasks
vp check pi/extensions/experimental/background-tasks
```

The current design has not been manually exercised in a live TUI.
