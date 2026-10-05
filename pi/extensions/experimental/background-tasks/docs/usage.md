# Background tasks

## Load locally

From this repository:

```sh
pi -e ./pi/extensions/experimental/background-tasks/index.ts \
  --skill ./pi/extensions/experimental/background-tasks/skills/watchers
```

No installation is necessary. The skill is optional; explicit `-e` loads the extension, not its package's skills. Package discovery loads both when enabled.

Use Node.js 26+, Pi 1.0.0+, and a POSIX host (macOS/Linux). Windows is rejected: there is no Windows process-tree backend. Print/JSON one-shot sessions are rejected because they exit when the initial prompt finishes.

## Tools and commands

`task_start({name, command, args?, cwd?, protocol?, timeoutMs?})` spawns an executable directly, without a shell, and returns the running task's summary and host-generated ID. Omitted arguments default to an empty array. Working directories resolve literally against the session directory, including names beginning with `@`. For shell syntax, launch a shell executable with an argument array. A start that fails, such as a missing executable, throws its cause and leaves no task.

Ordinary jobs treat stdout and stderr as logs. Successful exit produces `completed`; a nonzero exit produces `process_error`.

`task_list({})` lists retained tasks with name, status, cleanup state and whether each has an unread notification.

`task_inspect({id, tailBytes?})` returns the task summary, diagnostic, terminal `result`, retained watcher `events` (`seq`, optional `key`, `data`), the omitted-event count, and log tails of `tailBytes` source bytes per stream (default 6,000, maximum 131,072). Direct-model text is the same JSON, cut at 51,200 bytes, Pi's own tool-output limit, with an explicit marker. Log tails come last and everything else fits ahead of them, so only logs are cut and a smaller `tailBytes` fits. Code Mode, where enabled, receives the complete structured value.

`task_stop({id})` stops a job that is no longer needed, waits for bounded cleanup, and reports the actual outcome. Cancellation does not overwrite a result already accepted. Stopping a task whose cleanup failed checks its process group again and retries the cleanup if it is still alive.

A successful `task_inspect` or `task_stop` clears that task's pending notification, including an outcome decided while cleanup is still running. Failed calls, `task_list` and `/tasks` clear nothing. This records an invocation, not proof that the model read the output.

Commands:

- `/tasks`: one line per task.
- `/tasks <id>`: that task's line, diagnostic and log tails.

These commands are read-only. Ask the agent to stop a job when needed.

## Status indicators

In the TUI, `background-tasks.active` shows ⚙ and the number of live tasks, including tasks still awaiting cleanup. `background-tasks.pending` shows 🔔 and the number of tasks with an unread notification. Each is hidden when its count is zero. They appear in Pi's footer; the optional [footer extension](../../footer/README.md) places them in its border. RPC sessions receive no statuses.

## Agent-authored watchers

Write an ordinary script with Pi's file tools. Launch it with `protocol: "events-v1"`. Reserve stdout for UTF-8 JSON records, each followed by LF:

```json
{"v":1,"type":"event","key":"ci/123","data":{"status":"in_progress"}}
{"v":1,"type":"result","data":{"conclusion":"failure"}}
```

Every record requires `v`, `type`, and `data`; unknown fields are rejected. Only events may have an optional `key` (up to 128 characters). Send diagnostics to stderr. The host does not parse service-specific statuses, retry network requests, or evaluate predicates.

- Events continue observation. A key replaces that key's unannounced event; announced events stay inspectable.
- The first result finishes observation and starts process cleanup. Later records and exit callbacks cannot overwrite it, so an observed CI failure is a valid result, not a watcher crash.
- Successful exit without a result is `result_missing`; nonzero exit without a result is `process_error`.
- Invalid UTF-8/JSON, unknown versions or fields, oversized records, a missing final LF, and more than 256 records per second produce `protocol_error`. A record is oversized when its line, or its `data` rendered as tool-output JSON after parsing, exceeds 16 KiB; numbers such as `1e20` and escaped characters such as bidi controls render larger than they are written.
- Timeout and cancellation have separate outcomes. Cleanup status is separate from the outcome.

A detector has the same local capabilities as a shell command and inherits Pi's environment, potentially including credentials. There is no sandbox or secret redaction. Watchers should use external clients' existing authentication, never print tokens, and keep those clients' output off protocol stdout.

See the [authoring skill](../skills/watchers/SKILL.md) for a polling example.

## Notifications and trust

When a task finishes, or a watcher emits events, Pi is notified once it is idle: one `background-tasks:wake` message lists every task with unread updates and starts a new turn. A finished task is announced after its process cleanup, so its logs are complete. Notices name only host-assigned task IDs, event counts and outcomes; names, keys, logs, commands and payloads are pulled with `task_inspect` as **untrusted data**, not instructions. Message roles are not a prompt-injection boundary.

Notices wait while the agent is busy, while an extension dialog is open, and during manual compaction, rechecking once per second. When a run settles, pending notices start the next turn immediately. Handing a notice to Pi marks it delivered; it is not retried. A task's state remains available through `task_list` and `task_inspect`.

## Ownership

Tasks belong to the current extension instance. Quit, reload, new, resume, fork and clone stop **every** task, including dev servers. There is no detach flag, and session history never restarts or reconnects processes.

Tree navigation keeps tasks whose `task_start` call remains on the active branch. It stops and forgets the others; one whose cleanup failed stays listed. Forward navigation does not restart them. External effects cannot be undone.

Stopping sends TERM to the owned POSIX process group, waits up to one second, then sends KILL and waits up to another second. After the direct child exits, inherited pipes get a 100 ms drain. Cleanup failures stay visible, count against concurrency until a later stop finds the process group gone or the session reloads, and are reported on shutdown with their PIDs. Descendants that leave their process group and abnormal host death are outside this guarantee.

## Limits

| Resource                         | Limit                                                       |
| -------------------------------- | ----------------------------------------------------------- |
| Task name                        | 80 characters, counted as displayed rather than in bytes    |
| Live or unclean tasks            | 8                                                           |
| Finished tasks with unread notes | 32; further starts fail until some are inspected            |
| Read finished tasks kept         | 32, oldest pruned first                                     |
| Deadline                         | 1 hour default; 100 ms–24 hours                             |
| Record                           | 16 KiB line and rendered data; 256 records per second       |
| Retained events per task         | 64 records / 16 KiB as rendered; oldest dropped and counted |
| Logs                             | Last 128 KiB per stream, in memory                          |
| Tool text                        | 51,200 bytes; complete structured value through Code Mode   |

## Code Mode placement

All four tools are ordinary Pi tools with output schemas; Pi's `codemode` can call them in `on` or `only` mode through the same permission hooks. Scripts receive structured objects without `JSON.parse`.

```js
const { result } = await tools.task_inspect({ id: "t_…" });
// Filter or aggregate in Code Mode; print only the fields the model needs.
text({ conclusion: result.conclusion });
```
