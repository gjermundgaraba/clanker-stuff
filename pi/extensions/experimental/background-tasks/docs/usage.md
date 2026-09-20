# Background tasks

## Load locally

From this repository:

```sh
pi -e ./pi/extensions/experimental/background-tasks/index.ts \
  --skill ./pi/extensions/experimental/background-tasks/skills/watchers
```

No installation is necessary. The skill is optional; explicit `-e` loads the extension, not its package's skills. Package discovery loads both when enabled.

Use Node.js 26+, Pi 0.86.1+, and a POSIX host (macOS/Linux). Windows admission is rejected: this implementation has no Windows process-tree backend. Print/JSON one-shot sessions are rejected because they exit when the initial prompt finishes. TUI and RPC sessions both deliver notifications automatically; no confirmation or notification budget is required.

## Tools and commands

`task_start({name, command, args?, cwd?, protocol?, timeoutMs?})` spawns an executable directly, without a shell, and returns a host-generated task ID. Omitted arguments default to an empty array. Working directories resolve literally against the current session directory, including names beginning with `@`. For shell syntax, explicitly use a shell executable and its argument array.

Ordinary jobs treat stdout and stderr as logs. Successful exit produces `completed`; a nonzero exit produces `process_error`. Do useful work or finish the turn after starting a task; do not repeatedly poll while waiting.

`task_list({})` shows the pending notification count and every retained task in compact rows. Display names are shortened to 32 Unicode characters plus an ellipsis; full names remain available through inspection. Omission/eviction counts describe bounded retention, not response truncation.

`task_inspect` requires a task ID and a view:

- `{id, view: "summary", tailBytes?}` returns status, full name, all retained event IDs, result availability, and bounded log tails. `tailBytes` is a per-stream upper bound; encoding and the overall response budget may shorten the actual tails further. Omitted source-byte counts remain visible.
- `{id, view: "result", offset?}` reads the terminal result payload without logs.
- `{id, view: "event", eventId, offset?}` reads one retained event, including its payload when present. A terminal lifecycle event need not have a payload.

Payload responses contain `payload: {encoding: "json", text, offset, nextOffset, totalBytes}`. Concatenate `text` from successive pages, passing `nextOffset` back as `offset` until it is `null`, then parse the complete JSON text. Offsets are UTF-8 bytes in that immutable JSON representation, not string indexes or raw stdout offsets. Small payloads fit in one response. Display-control escaping preserves the JSON value. An evicted event produces an explicit not-found error, never a page from another event. Terminal results remain readable by task ID under task-history retention.

`task_stop({id})` lets the agent stop a job that is no longer needed. It waits for bounded cleanup and reports the actual terminal decision. Cancellation does not overwrite a result already accepted. There is no dismissal step: terminal notification capacity is released automatically when Pi observes the notice.

Commands:

- `/tasks`: summaries.
- `/tasks inspect <id>`: summary status, all retained event IDs, result availability, and bounded log tails. Read payloads through `task_inspect` with `view: "result"` or `view: "event"`.
  These commands are read-only. There are no user-facing pause, resume, stop, or dismiss controls. Ask the agent to stop a job when needed.

Inspection is read-only and does not consume pending notifications. Notification acknowledgement means Pi observed the notice through its agent loop, not that a model acted on it or that processing succeeded.

## Border indicators

Load the optional [border-status extension](../../border-status/README.md) to see compact counts on the editor border. There is no footer status or fallback when the border host is absent.

- Active tasks: Nerd Font gears (`nf-fa-gears`, U+F085), including tasks still awaiting cleanup.
- Pending notifications: Nerd Font bell (`nf-fa-bell`, U+F0F3). This counts events, including in-flight notices until acknowledged, not tasks.

Each indicator is hidden independently when its count is zero. Icons follow the border host's preference; use `/border-status icons nerd` for Nerd Font glyphs. Unicode uses ⚙ / 🔔; ASCII uses `tasks` / `pending`. Task inspection and automatic delivery still work without the border host and in RPC mode.

## Agent-authored watchers

Write an ordinary script with Pi's existing file tools. Launch it with `protocol: "events-v1"`. Reserve stdout for UTF-8 JSON records, each followed by LF:

```json
{"v":1,"type":"event","key":"ci/123","data":{"status":"in_progress"}}
{"v":1,"type":"result","data":{"conclusion":"failure"}}
```

Every record requires `v`, `type`, and `data`; unknown fields are rejected. Only events may have an optional `key` (up to 128 characters). Send diagnostics to stderr. The host does not parse service-specific statuses, retry network requests, or evaluate predicates.

- Events continue observation. A key opts into last-write-wins replacement of pending snapshots for that task/key. Unkeyed events preserve arrival order unless progress capacity is exceeded.
- The first result finishes the observation contract and initiates process cleanup. Later records and exit callbacks cannot overwrite it. Observed CI failure can therefore be a valid result, not a watcher crash.
- Successful exit without a result is `result_missing`; nonzero exit without a result is `process_error`.
- Invalid UTF-8/JSON, unknown versions/fields, oversized records, missing final LF, and excessive record rates produce `protocol_error` immediately. Diagnostics retain stdout provenance; invalid records are not relabeled as stderr.
- Spawn failure, timeout, and cancellation have separate outcomes. Cleanup status is separate from the outcome.

A detector has the same local capabilities as a shell command. It inherits Pi's environment, potentially including credentials. No sandbox or automatic secret redaction is provided. Watchers should use external clients' existing authentication, never print tokens, and capture those clients' output rather than leaking it onto protocol stdout.

See the [authoring skill](../skills/watchers/SKILL.md) for a polling example.

## Automatic notifications and trust

Automatic messages contain only host-assigned task/event IDs and host-authored outcome names. Names, keys, logs, commands, and result payloads are not pushed into the conversation. Pulling them with `task_inspect` exposes **untrusted data**, not instructions. JSON/custom-message roles are not a prompt-injection boundary. Terminal control sequences are sanitized on display; raw bounded log files remain untrusted.

Capture continues while Pi is busy or showing an extension prompt. Delivery waits until settled and idle, then sends a triggered follow-up; a competing extension's run can queue that follow-up. Only one batch is handed off at a time. Ordinary stdout/stderr stays in logs; completion and watcher records trigger notifications.

Pending notifications recheck readiness once per second while Pi is busy, including during manual compaction. These checks do not call the model or resend an outstanding batch.

Notifications are always enabled, with no approval, wake credits, or total delivery limit. Aborting an agent turn does not disable future notifications or stop tasks. If a handoff fails or Pi settles without observing its notice, delivery retries after a one-second delay rather than requiring user intervention. Once observed, a notice is not retried merely because the model response failed or was aborted.

The inbox, event history, and logs remain bounded to limit memory use. They are session-owned, not a durable outbox: reload stops tasks and clears live notification state. Old attention checkpoints have no effect.

Old inspection calls persisted without a view are prepared as summary views, or event views when they contain an event ID; the public schema requires an explicit view.

## Ownership

All tasks belong to the current extension instance. Quit, reload, new, resume, fork, and clone stop **every** task, including dev servers. There is no detach flag. Forked/resumed historical records are not live process handles and never cause PID reconnection or restarts.

Tree navigation keeps tasks whose creation entry remains an ancestor of the active leaf and cancels others. Jumping before creation stops a task even within the same lineage. Forward navigation does not restart it. Queued wake content is filtered against current ancestry before model processing; prior external effects cannot be undone.

Shutdown sends TERM to the owned POSIX process group, waits up to one second, then KILL and up to another second. Direct-child exit allows a bounded 100 ms pipe drain; inherited pipes cannot keep a task running indefinitely. Cleanup failures remain visible and count against concurrency. Before admission and on repeated stop, the supervisor rechecks failed cleanup after its original cleanup has finished. Capacity is recovered only when the original child has exited and its process group is confirmed absent; uncertainty remains counted. Rechecking sends no new termination signals and preserves the original outcome and diagnostics. Descendants that deliberately escape their process group and abnormal host death are outside this containment guarantee. Disposable logs are removed after clean shutdown; failed-cleanup logs are retained for diagnosis, without claiming continued supervision.

## Fixed v1 limits

| Resource                          | Limit                                                                     |
| --------------------------------- | ------------------------------------------------------------------------- |
| Active/unclean tasks              | 8                                                                         |
| Deadline                          | 1 hour default; 100 ms–24 hours                                           |
| Record                            | 16 KiB before LF                                                          |
| Watcher output                    | 256 records per one-second window; excess fails the protocol              |
| Pending progress                  | 64 records / 64 KiB, plus one in-flight batch                             |
| Terminal reservations             | 32 active or unobserved terminal tasks                                    |
| Delivery batch                    | 8 records per batch; no total batch limit                                 |
| Observed event history            | 64 observed records; summaries list all retained event IDs                |
| Unprotected finished task history | 32 at admission-time pruning, plus current admitted tasks                 |
| Log storage                       | Last 128 KiB per stream, in memory and disposable files                   |
| Log tool reads                    | 6,000 bytes/stream default, 12,000 maximum                                |
| Tool response                     | 32,000 encoded bytes; complete compact envelopes and payload continuation |

Progress overflow drops the oldest pending progress and increments the omitted count. Terminal reservations are never evicted by progress; new admission fails when all slots are occupied. Observed history can be evicted, with a visible count. Log tails report omitted bytes and storage errors; they are not complete logs. Session lifecycle entries contain metadata, never raw output, and accumulate with session history.

The supervisor, wire decoder, inbox, and delivery controller are separate components. Persistence beyond a session would require a new external owner and authenticated reconnection—not a PID-file escape hatch.
