# Background tasks design

Implemented by the experimental [background-tasks extension](../). Pi API baseline: v0.87.0.
[Usage](usage.md) is authoritative for tools, commands, protocol, and limits; [validation](validation.md) records demonstrated behavior and verification limits.

## Scope

Run ordinary background jobs and let the agent author arbitrary watcher logic in code, without service-specific tools or a watcher expression language.

Tasks are session-owned, including dev servers. Reload and session replacement end that ownership. Ancestry-aware tree navigation retains only tasks whose creation entry remains on the active branch. This is an ownership policy, not proof of continued user intent; external effects cannot be rolled back.

No detach escape hatch, daemon, or PID reconnection is implemented. Survival requires an external owner and a concrete product requirement, not a speculative flag.

## One supervisor, two execution contracts

```text
agent → task tools → supervisor
                      ├─ ordinary stdout/stderr → bounded logs
                      ├─ watcher records       → event inbox
                      └─ lifecycle outcomes    → event inbox
                                                    │
                                              delivery policy
                                                    │
                                                Pi session
```

Jobs and watchers share process ownership, IDs, cancellation, storage, and inspection. A watcher is a supervised program with an explicit event contract, not a second process-management system. Detection belongs in the program: queries, polling, retries, change detection, and predicates. The host owns process supervision and automatic notification delivery.

A watcher observing a server is a separate task; stopping it does not implicitly stop the server. Scripts remain ordinary files authored with existing tools; no mandatory SDK, in-process evaluation, or executable project configuration is required.

The start boundary hands off ownership after spawn, not after the first probe or completion. Cancellation during startup must not leave an unreported child. Thereafter the task lifetime is independent of its starting tool call.

## Outcomes are not cleanup

Ordinary jobs report process completion; opted-in watchers distinguish continuing observations from terminal results. A CI failure can be a successfully observed result, distinct from the detector crashing or failing authentication.

The first terminal decision wins. Later exit/error callbacks cannot overwrite it or produce additional terminal notices. Cleanup status is separate: accepting a result does not prove process termination.

Protocol framing fails closed. Malformed or unsupported stdout remains diagnostic evidence with its original provenance, rather than being reinterpreted as events or relabeled stderr. Record and rate limits bound parsing work before inbox backpressure applies.

Cleanup owns bounded TERM/KILL escalation and pipe drain. Failed cleanup remains counted against admission. Subsequent admission or stop can reconcile that failure only after the original cleanup finishes, the original child is known exited, and the owned group is confirmed absent. Reconciliation never sends fresh termination signals using an old PID, releases notification reservations, or changes the terminal decision. Permission errors and uncertain liveness remain failures.

Abnormal host death or descendants escaping their group can leave orphans. This is not crash-proof containment, and persisted PIDs do not establish live ownership.

## Capture is independent of delivery

Subprocess callbacks submit observations to the inbox; they never send Pi messages directly. Host task IDs, event IDs, and sequence numbers are distinct from watcher-supplied keys.

Keyed progress represents replaceable pending state within one task/key. Unkeyed events retain arrival order. Coalescing never alters an already-handed-off batch. Progress overflow evicts only progress and exposes an omitted count.

Admission and task-history pruning share one derived protection set: tasks awaiting terminal capture, plus tasks with pending or in-flight notices. Each distinct task occupies one of 32 slots, even if it appears in several of those sources. Capturing a terminal transfers protection from the awaiting task to its unread notice; retiring the last notice releases protection naturally. Completed tasks with unread watcher events still occupy a slot. This keeps notification metadata available without a separate reservation-reconciliation state machine. Exhaustion blocks admission rather than silently deleting results. Retired history and logs have separate finite retention.

Runtime inspection requires an explicit `observe` or `consume` mode. Human commands observe; the agent tool consumes. Each view constructs its complete response before consuming the local events and outcome it returned, so failures consume nothing. Summary consumes its listed IDs and reported terminal outcome; event consumes only its selected ID; result consumes only the terminal outcome. Successful `task_stop` also consumes the terminal outcome without consuming earlier progress. `task_start` returns a running task, and `task_list` is observational.

The supervisor decides an immutable terminal outcome before cleanup emits its notice. The awaiting-capture map records whether that outcome has already been retrieved. If so, capture stores the terminal event directly in history instead of scheduling a stale notice. Capture removes the map entry; any remaining notices independently protect the task. Abandonment and clear discard awaiting state, and repeated reads never recreate it. Event-only retrieval does not mark an unrelated terminal outcome retrieved.

Consumption removes exact IDs from pending and in-flight eligibility while retaining inspectable history. Lookup returns sequence order across history, flight, and pending. Retired history need not stay sorted internally: only a new capture trims it to its 64-record target, sorting by sequence rather than retrieval order. Consumption and acknowledgement never evict payloads. Continuation is not pinned across later captures, task pruning or session replacement.

Aggregate retention stays bounded by 168 records: 64 retired history at capture, 64 pending progress, at most 32 terminal notices, and an 8-record flight. Between captures, retirement only transfers existing records, so history may exceed its target without growing total storage.

Pruning claims and counts selected history victims synchronously before awaiting filesystem removal. No concurrent admission can count the same eviction twice.

## Delivery and trust

Notices contain only host-authored IDs and outcome names. Payloads, command output, names, and keys are pulled on demand as untrusted data. Summary inspection exposes every retained event ID; immutable payload JSON supports byte-offset continuation without truncating response envelopes.

Structured JSON and custom-message roles are not security boundaries: Pi converts custom messages into model-facing user content. Pull-based access reduces unsolicited exposure, but does not eliminate prompt injection once data is read. Programs inherit local capabilities and environment credentials; process supervision is not a sandbox.

Capture continues while busy. At a successful `agent_before_settle` boundary, delivery admits one already-ready batch of at most eight notices unless an extension prompt is open or the run is aborted. It appends a native `custom_message` draft to the preceding handlers' `event.entries` and requests `continue: true`. It does not queue a follow-up or wait for tasks to finish. Error and abort boundaries do not admit a batch.

The activity admission allowance stays spent until actual `agent_settled`, even after receipt acknowledgement or a dropped proposal. This gives settlement consumers a lifecycle boundary instead of allowing notifications to extend one activity indefinitely; it is not a total notification or model-spend cap. Inbox ownership independently prevents overlapping batches. Remaining batches and later task completions use idle delivery. Blocking extension prompts gate both admission points.

Idle delivery checks readiness and calls Pi's triggered `sendMessage()` synchronously, starting a new prompt through the unmodified public API. Arbitrary third-party replacements of `sendMessage` that start another run inside that handoff are outside the supported contract. Boundary and idle delivery share notification content, inbox ownership, and receipt reconciliation, not a transport mechanism.

While notifications are pending and Pi is not ready, one timer rechecks readiness every second. This also covers manual compaction returning to idle without an `agent_settled` event. Readiness checks do not resend an outstanding batch; shutdown cancels the timer.

### Receipt means recorded history

```text
pending → boundary proposal or idle prompt → recorded in the actual session branch
```

Only one batch may be outstanding. Before provider-context preparation and at settlement, the runtime looks for its runtime ID and outstanding batch ID in actual session `custom_message` entries. A match acknowledges the batch, retiring its remaining notices. Proposed boundary previews are not receipts. Extension `message_end` is not used: it precedes persistence on the normal loop path and is absent for boundary drafts.

Retrieval does not acknowledge a batch, fabricate a branch receipt, reset activity admission, or retract an admitted message. Even when all its events are consumed, outstanding batch identity remains until a real receipt or an already-eligible boundary retry resolves it. Retry requeues only remaining events; an empty dropped proposal neither produces an empty wake nor blocks later pending notices. Already-admitted content may still mention subsequently consumed events.

Later boundary handlers can replace or invalidate the proposal. If its receipt is still missing at settlement, the boundary batch returns to pending and idle delivery retries after one second. A synchronous idle handoff failure also backs off for one second. Settlement or elapsed time alone does not prove that a queued message was discarded; an unacknowledged idle handoff is not automatically requeued.

Pi commits valid boundary drafts even when cancellation during a later handler suppresses continuation. Such a recorded notice is accepted without forcing a model response: it remains available for the next request. Neither cancellation, a failed response, nor lack of model processing replays a recorded notice. Later pending notifications continue automatically.

Retrieval and recorded receipts are runtime-local, not replayed when navigating before them. This is session-local, bounded in-memory tracking. Recording a receipt is not proof of model action, successful processing, or crash-safe persistence; there is no durable outbox or crash-exactly-once guarantee.

### Always-on delivery

TUI and RPC sessions use the same automatic delivery policy. There are no approvals, wake credits, attention checkpoints, or total batch limits. The user-facing `/tasks` command only lists or inspects tasks. The agent retains `task_stop` for jobs that are no longer needed; there is no dismissal tool or manual notification lifecycle.

Process concurrency, deadlines, record sizes, and retained memory still have finite limits. Those resource bounds do not grant or revoke permission to notify the agent.

## Ownership and storage boundaries

Capture creation provenance from synchronized session state at tool execution. On branch navigation, revoke all stale tasks and their notifications before awaiting process cleanup. Never restart tasks on forward navigation. A handed-off message may not be retractable, so ancestry is also checked before provider context.

Shutdown blocks admission and delivery, invalidates callbacks, cancels timers, and cleans owned groups. Resource creation is lazy, not an extension-factory side effect. Resume/reload history is evidence of past work, never a live process handle.

Follow the repository [extension structure](../../../../../docs/extension-structure.md):

- `index.ts`: registration manifest and thin wiring.
- `supervisor.ts`: process ownership, lifecycle, admission, cancellation.
- `protocol.ts`: bounded record framing and validation.
- `inbox.ts`: coalescing, retention, and delivery batches.
- `delivery.ts`: bounded boundary/idle admission, acknowledgement, and retry.
- `logs.ts`: bounded storage and reads.
- `task.ts`: strict schemas, compact formatting, payload continuation.
- `runtime.ts`: Pi lifecycle and tool coordination.

The supervisor owns no Pi context. Do not introduce generic process, storage, or clock backends without an actual need. Strict tool schemas stay closed and current; renderers tolerate older stored calls without argument migrations.

Session custom entries contain lifecycle metadata, not raw payloads or a process database. Disposable logs live under an owned temporary directory. File mutation uses Pi's per-file queue. Installed source is never runtime storage.

## Survival is a different ownership model

Keeping a dev server alive and reconnecting later needs an external owner, reconnectable identity rather than bare PIDs, disconnected logs/status, explicit stop authorization, and recovery behavior.

Watching while Pi is closed additionally needs durable events, authorized routing to an agent session, ownership claims, duplicate handling, crash recovery, and autonomous spending policy. Merely keeping a detector alive supplies none of these guarantees.

Keep the supervisor/protocol/inbox separation, but defer daemon transport, leader election, and persistent-job modes until those requirements exist. Calendar scheduling is likewise separate: schedule task execution, not repeated model prompts.

## Source grounding

These are architectural inspirations, not dependencies or guarantees copied wholesale:

- [cahalane/pi-monitor at 3a24607](https://github.com/cahalane/pi-monitor/tree/3a24607): lifecycle/pipeline separation and resource limits; its default delivery is steering.
- [nklisch background tasks at b8a0030](https://github.com/nklisch/pi-extensions/blob/b8a0030/packages/pi-background-tasks/extensions/background-tasks.ts): compact completion notices and pull-based logs.
- [FradSer monitor at f2f8f93](https://github.com/FradSer/pi-packages/blob/f2f8f93/packages/monitor/src/monitor.ts): explicit terminal-result contract and missing-result distinction.
- [channels.tools wake component at e180364](https://github.com/schuettc/pi-extensions/blob/e180364/packages/channels.tools/src/wake.ts): independent busy-gated delivery.
- [pi-wake at ac01632](https://github.com/Jasperxjy/pi-wake/blob/ac01632/extensions/pi-wake/index.ts): handoff versus observed delivery; its durable daemon machinery is outside v1.
- [dannote background manager at 73fe052](https://github.com/dannote/dot-pi/blob/73fe052/extensions/background.ts): named jobs and inspectable logs, not the v1 ownership model.
- [Pi v0.87.0 extension documentation](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/docs/extensions.md): lifecycle, provenance fields, custom messages, and session state.
- [Pi v0.87.0 AgentSession](https://github.com/earendil-works/pi/blob/v0.87.0/packages/coding-agent/src/core/agent-session.ts): `sendCustomMessage`, `_appendCustomMessage`, `_handleAgentEvent`, and prompt dispatch.

Source inspection informed this design. The implementation has unit, real-subprocess, AgentSession integration, discovery, and manually driven Herdr/Pi validation; limitations are recorded in the linked validation document.
