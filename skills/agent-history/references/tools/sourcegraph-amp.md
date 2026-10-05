# Sourcegraph Amp

## Operator Summary

Primary source: Amp thread logs under cache/log roots.

Collect: thread JSONL logs and durable session/history JSON only when needed.

Parse: [../parse/jsonl.md](../parse/jsonl.md).

Ignore first: secrets, global logs, plugin logs, editor undo buffers, and VS Code secret rows.

Status: verified storage, partial parser contract.

History scope: default-local.

Last verified: local macOS, event schema inspected without bodies.

## Sources

| Priority | Location                               | Kind   | Authority         | Contains                     | Parser State  | Collection Policy | Sensitivity |
| -------- | -------------------------------------- | ------ | ----------------- | ---------------------------- | ------------- | ----------------- | ----------- |
| 1        | `$HOME/.cache/amp/logs/threads/*.log`  | JSONL  | primary candidate | thread events/messages/tools | partial       | collect           | private     |
| 2        | `$HOME/.local/share/amp/history.jsonl` | JSONL  | secondary         | input history                | schema_known  | collect           | private     |
| 2        | `$HOME/.local/share/amp/session.json`  | JSON   | session state     | active thread pointers       | schema_known  | collect           | private     |
| 3        | `$HOME/.local/share/amp/secrets.json`  | JSON   | secret            | API keys                     | blocked       | never_collect     | secret      |
| 3        | VS Code state                          | SQLite | UI/secret support | extension state              | metadata_only | ignore_by_default | secret      |

## Find

Use Amp local share and cache roots. Thread logs are JSONL even when file extension is `.log`.

## Fetch

Read selected thread logs directly. Use durable session pointers or input-history records only when needed for the requested thread, identifying their secondary role. Exclude secrets and unrelated global logs.

## Parse

Inspect the selected thread event types and their native IDs/content fields. Distinguish message snapshots, message deltas, tool events, and telemetry; preserve line position and explicit relationships. Final-state replay rules are not established here. Do not concatenate deltas with full snapshots or infer that log order alone is the active conversation. Report when only individual events can be interpreted reliably.

## Source-specific hazards

The secrets file, global/plugin logs, and editor undo buffers are separate from thread history. VS Code state may include secret rows.

## Gaps

Authoritative reconstruction of final message state from all event variants is not documented here. A readable event stream does not guarantee a complete final transcript.

## Evidence

Local log/schema verification and installed extension metadata.
