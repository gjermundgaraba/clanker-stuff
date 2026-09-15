# Background tasks design

Implemented by the experimental [background-tasks extension](../). Pi API baseline: v0.85.0.
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

Bounded storage cannot promise unlimited terminal retention. Each admitted task reserves a terminal slot until Pi observes its terminal notification. Exhaustion blocks admission rather than silently deleting results. Inspection is read-only; acknowledgement releases capacity automatically. Delivered history and logs have separate finite retention.

Pruning claims and counts selected history victims synchronously before awaiting filesystem removal. No concurrent admission can count the same eviction twice.

## Delivery and trust

Notices contain only host-authored IDs and outcome names. Payloads, command output, names, and keys are pulled on demand as untrusted data. Summary inspection exposes every retained event ID; immutable payload JSON supports byte-offset continuation without truncating response envelopes.

Structured JSON and custom-message roles are not security boundaries: Pi converts custom messages into model-facing user content. Pull-based access reduces unsolicited exposure, but does not eliminate prompt injection once data is read. Programs inherit local capabilities and environment credentials; process supervision is not a sandbox.

Capture continues while busy. Delivery waits for settlement and idle state, including blocking extension prompts. Dispatch uses a triggered follow-up so another extension winning the readiness race queues the batch rather than steering into its run.

While notifications are pending and Pi is not ready, one timer rechecks readiness every second. This also covers manual compaction returning to idle without an `agent_settled` event. Readiness checks never retry a batch while its delivery cycle is outstanding, and shutdown cancels the timer.

### Handoff is not observation

```text
pending → handed to Pi → observed through the agent loop
```

Only one batch may be outstanding. Correlation through extension `message_end` confirms agent-loop observation, not model action, successful processing, or durable persistence: extension handlers run before Pi appends the message to session history.

Pi's extension-facing `sendMessage()` has no success acknowledgement. The idle, non-triggered append path does not emit extension `message_end`; this dispatcher never uses that path.

A settled cycle with an unobserved batch retries it after one second. A synchronous handoff failure also retries after one second. No retry runs while a delivery cycle is outstanding; elapsed time alone does not prove that Pi lost a queued follow-up. Acknowledgement may precede settlement, so an outstanding delivery cycle is distinct from an outstanding batch.

An aborted turn does not pause delivery. An observed notice is not replayed because the response failed or was aborted; later pending notifications continue automatically. This is bounded in-memory delivery tracking, not a crash-safe or exactly-once outbox.

### Always-on delivery

TUI and RPC sessions use the same automatic delivery path. There are no approvals, wake credits, attention checkpoints, or total batch limits. The user-facing `/tasks` command only lists or inspects tasks. The agent retains `task_stop` for jobs that are no longer needed; there is no dismissal tool or manual notification lifecycle.

Process concurrency, deadlines, record sizes, and retained memory still have finite limits. Those resource bounds do not grant or revoke permission to notify the agent.

## Ownership and storage boundaries

Capture creation provenance from synchronized session state at tool execution. On branch navigation, revoke all stale tasks and their notifications before awaiting process cleanup. Never restart tasks on forward navigation. A handed-off message may not be retractable, so ancestry is also checked before provider context.

Shutdown blocks admission and delivery, invalidates callbacks, cancels timers, and cleans owned groups. Resource creation is lazy, not an extension-factory side effect. Resume/reload history is evidence of past work, never a live process handle.

Follow the repository [extension structure](../../../../../docs/extension-structure.md):

- `index.ts`: registration manifest and thin wiring.
- `supervisor.ts`: process ownership, lifecycle, admission, cancellation.
- `protocol.ts`: bounded record framing and validation.
- `inbox.ts`: coalescing, retention, and delivery batches.
- `delivery.ts`: idle delivery, observation, and retry.
- `logs.ts`: bounded storage and reads.
- `task.ts`: strict schemas, compact formatting, payload continuation.
- `runtime.ts`: Pi lifecycle and tool coordination.

The supervisor owns no Pi context. Do not introduce generic process, storage, or clock backends without an actual need. Strict tool schemas stay strict; `prepareArguments` belongs only at real persisted-call migrations.

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
- [Pi v0.85.0 extension documentation](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/docs/extensions.md): lifecycle, provenance fields, custom messages, and session state.
- [Pi v0.85.0 AgentSession](https://github.com/earendil-works/pi/blob/v0.85.0/packages/coding-agent/src/core/agent-session.ts): `sendCustomMessage`, `_appendCustomMessage`, `_handleAgentEvent`, and prompt dispatch.

Source inspection informed this design. The implementation has unit, real-subprocess, AgentSession integration, discovery, and manually driven Herdr/Pi validation; limitations are recorded in the linked validation document.
