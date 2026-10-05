# Background tasks design

Implemented by the experimental [background-tasks extension](../). Pi API baseline: v1.0.0.
[Usage](usage.md) is authoritative for tools, commands, protocol, and limits; [validation](validation.md) records tested behavior.

## Scope

Run ordinary background jobs and let the agent author arbitrary watcher logic in code, without service-specific tools or a watcher expression language.

Tasks are session-owned, including dev servers. Reload and session replacement end that ownership; tree navigation keeps only tasks started on the active branch. This is an ownership policy, not proof of continued user intent. No detach mode, daemon or PID reconnection exists; survival would need an external owner and a concrete requirement.

## One supervisor, two execution contracts

```text
agent → task tools → supervisor ─┬─ stdout/stderr → in-memory log tails
                                 ├─ watcher events → per-task notices
                                 └─ outcome        → per-task notices
                                                      │
                                     idle delivery → Pi session
```

Jobs and watchers share process ownership, IDs, cancellation and inspection. A watcher is a supervised program with an explicit event contract; detection (queries, polling, retries, predicates) belongs in the program. A watcher observing a server is a separate task; stopping it does not stop the server.

The start boundary hands off ownership after spawn. A start that fails or is cancelled first cleans up, then throws and forgets the task; only a task whose cleanup failed stays listed.

## Outcomes are not cleanup

The first terminal decision wins; later exit or error callbacks cannot change it. Cleanup status is separate: accepting a result does not prove process termination. Protocol framing fails closed, and record size and rate limits bound parsing work. Size bounds both the raw line and the parsed data as rendered in tool text, which can be larger, so a result and full event retention fit the text preview ahead of the log tails.

Cleanup owns bounded TERM/KILL escalation of the process group and a bounded pipe drain. A failed cleanup counts against concurrency until a later stop finds the group gone, or until reload; stopping again re-runs the escalation if it is still alive. Orphans from abnormal host death or descendants that leave the group are outside this guarantee.

## Notices are task state

Each task records its retained events and how much of the task has been announced: the last announced event sequence and whether its outcome was announced. A task has an unread notice when it has newer events, counting those retention dropped before they were announced, or a decided outcome that has not been announced and whose cleanup has finished. Delivery, retention and the status count all derive from that one predicate.

Delivery hands Pi one message listing every task with unread updates, then marks them announced. A successful `task_inspect` or `task_stop` marks the whole task read, including an outcome decided before cleanup finishes. Human commands and `task_list` only observe.

Keyed events replace their own unannounced predecessor. Retention is per task (64 records / 16 KiB as rendered in tool text), with omitted counts; the newest event stays even when it alone is larger. Finished tasks are pruned only once clean and read; too many unread finished tasks block new starts instead of dropping notices.

## Delivery

Notices are delivered only when Pi is idle, through `pi.sendMessage(…, { triggerTurn: true })`. Delivery runs from `agent_settled`, where Pi defers the triggered prompt until every settled handler has finished, and from a 100 ms debounce after task changes. While the agent is busy, an extension dialog is open, or manual compaction runs, a one-second recheck waits; compaction and dialogs end without `agent_settled`.

Handing a notice to Pi counts as delivery. There is no receipt tracking or retry: a notice lost before Pi records it is not repeated, but the task remains inspectable. Each delivery is its own run, so settlement consumers always see a boundary between notices.

## Trust

Notices contain only host-authored task IDs, event counts and outcome names. Payloads, logs, names and keys are pulled on demand as untrusted data. Structured output and the text preview carry the same JSON; Code Mode receives the complete value. Pi converts custom messages into model-facing content, so roles are not a security boundary, and processes inherit local capabilities and credentials.

## Ownership and storage

Each task records the session leaf at its start. On tree navigation, tasks whose origin is no longer an ancestor are forgotten before their cleanup is awaited, so no notice announces them meanwhile. Shutdown stops every task, which retries earlier failed cleanups, and reports those that still fail with their PIDs.

Logs are bounded in-memory tails; no files are written. Session history holds only tool calls and notices, never a process database.

Modules follow the repository [extension structure](../../../../../docs/extension-structure.md):

- `index.ts`: registration manifest.
- `register.ts`: tool registrations.
- `supervisor.ts`: process ownership, lifecycle, admission, retention.
- `notices.ts`: per-task events and announcement state.
- `protocol.ts`: watcher record framing and the wake message type.
- `logs.ts`: bounded log tails.
- `task.ts`: input schemas, rows and the text preview.
- `output.ts`: structured output schemas.
- `runtime.ts`: Pi lifecycle, delivery, statuses and tool coordination.
- `renderers.ts`: tool display.

## Source grounding

Architectural inspirations, not dependencies:

- [cahalane/pi-monitor at 3a24607](https://github.com/cahalane/pi-monitor/tree/3a24607): lifecycle/pipeline separation and resource limits.
- [nklisch background tasks at b8a0030](https://github.com/nklisch/pi-extensions/blob/b8a0030/packages/pi-background-tasks/extensions/background-tasks.ts): compact completion notices and pull-based logs.
- [FradSer monitor at f2f8f93](https://github.com/FradSer/pi-packages/blob/f2f8f93/packages/monitor/src/monitor.ts): explicit terminal-result contract and missing-result distinction.
- [channels.tools wake component at e180364](https://github.com/schuettc/pi-extensions/blob/e180364/packages/channels.tools/src/wake.ts): independent busy-gated delivery.
