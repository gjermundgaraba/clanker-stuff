# Cline

## Operator Summary

Primary source: Cline data directory.

Collect: session SQLite DB, per-session JSON/message files, and relevant sidecars.

Parse: [../parse/sqlite.md](../parse/sqlite.md) and JSON.

Ignore first: provider settings, credentials, logs, cron/team DBs unless needed.

Status: verified storage, partial parser contract.

History scope: default-local.

Last verified: local macOS, small local sample inspected structurally.

## Sources

| Priority | Location                                        | Kind   | Authority       | Contains               | Parser State  | Collection Policy   | Sensitivity |
| -------- | ----------------------------------------------- | ------ | --------------- | ---------------------- | ------------- | ------------------- | ----------- |
| 1        | `$HOME/.cline/data/db/sessions.db`              | SQLite | primary         | sessions               | partial       | collect             | private     |
| 1        | `$HOME/.cline/data/sessions/<session-id>*.json` | JSON   | primary/sidecar | messages/session state | partial       | collect             | private     |
| 2        | `$HOME/.cline/data/user_input_history.jsonl`    | JSONL  | secondary       | input history          | partial       | collect_when_needed | private     |
| 3        | provider/settings/log files                     | mixed  | support         | config/logs/secrets    | metadata_only | ignore_by_default   | secret      |

## Find

Use `$HOME/.cline/data`. Editor-extension storage may exist separately depending on host editor.

## Fetch

Use read-only SQLite access or a [consistent backup](../collect/sqlite-safe-copy.md). Read only the matching session JSON/sidecars needed for the question. Exclude provider settings and credentials.

## Parse

Inspect the selected database schema and session JSON structure before querying content. Filter by the observed native session key and read the associated message JSON. This card does not establish exact table names, JSON content paths, or ordering fields across Cline variants; use only relationships present in the selected schema. If message order or a sidecar relationship cannot be established, report that gap instead of inventing a conversation.

## Source-specific hazards

Provider settings and credentials are separate from session history.

## Gaps

Exact session/message field and sidecar mappings are not documented here for every Cline host/version. Locating a session does not establish complete message reconstruction.

## Evidence

Local schema verification.
