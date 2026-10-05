# OpenCode

## Operator Summary

Primary source: OpenCode SQLite database.

Collect: a read-only database view or consistent backup, plus relevant referenced sidecars.

Parse: [../parse/sqlite.md](../parse/sqlite.md).

Ignore first: logs, config, cache, and credentials.

Status: verified.

History scope: default-local.

Last verified: local macOS, schema inspected without transcript bodies.

## Sources

| Priority | Location                                 | Kind   | Authority      | Contains                  | Parser State  | Collection Policy       | Sensitivity |
| -------- | ---------------------------------------- | ------ | -------------- | ------------------------- | ------------- | ----------------------- | ----------- |
| 1        | OpenCode DB path from `opencode db path` | SQLite | primary        | sessions, messages, parts | partial       | collect                 | private     |
| 2        | OpenCode session diff storage            | JSON   | secondary      | diffs/snapshots           | partial       | collect_when_referenced | private     |
| 2        | OpenCode tool-output storage             | files  | artifact store | tool outputs              | partial       | collect_when_referenced | private     |
| 3        | config/cache/log dirs                    | mixed  | support        | settings/logs             | metadata_only | ignore_by_default       | private     |

## Find

Prefer the CLI:

```sh
opencode db path
```

`OPENCODE_DB` may override the default database path.

## Fetch

Query the selected database read-only. Use a [consistent backup](../collect/sqlite-safe-copy.md) when a stable snapshot is needed. Follow tool-output sidecars only when the question requires their contents.

## Parse

Identify the actual schema generation before querying. The cited upstream revision contains both message/part tables and a newer `session_message` table; the following fields apply to the message/part generation only.

| Table     | Relevant columns and JSON fields                                                              |
| --------- | --------------------------------------------------------------------------------------------- |
| `session` | `id`, optional `parent_id`, and directory/title metadata                                      |
| `message` | `id`, `session_id`, `time_created`, `time_updated`, JSON `data` with `role` and time metadata |
| `part`    | `id`, `message_id`, `session_id`, timestamps, and JSON `data`                                 |

Join `message.session_id` to `session.id` and `part.message_id` to `message.id`, preserving session identity. The checked reader orders messages by `time_created` with an `id` tie-breaker, then parts by `id` within a message. IDs are restored from table columns and need not appear inside JSON `data`.

Text/reasoning parts carry `text`. Tool parts carry `callID`, `tool`, and `state`; state can be pending, running, completed, or error. Completed state includes output; error state includes an error. These are states of the same call, not separate calls. An assistant's `parentID` is a message relationship, distinct from session `parent_id`.

If `session_message` is present, inspect its `session_id`, `type`, `seq`, and `data` schema and establish which generation holds the selected session. Coexisting legacy tables do not establish that their rows are authoritative. The newer payload mapping and migration precedence are not established here; do not apply the message/part query to it or infer a complete transcript from its metadata.

## Source-specific hazards

Configuration, logs, and snapshots are separate from session/message/part records and referenced tool outputs.

## Gaps

Storage generations differ. Complete newer `session_message` payload decoding and precedence during migration are not covered by this guide. State which schema was used and any unresolved fields or tool-output sidecars.

## Evidence

Previous local schema inspection established storage locations without reading bodies. Message/part guidance is checked against OpenCode commit `bbd72fb8b0bb6de580d2041a0150016227c63ac0`: [SQLite definitions](https://github.com/anomalyco/opencode/blob/bbd72fb8b0bb6de580d2041a0150016227c63ac0/packages/core/src/session/sql.ts#L68), [V1 payload types](https://github.com/anomalyco/opencode/blob/bbd72fb8b0bb6de580d2041a0150016227c63ac0/packages/schema/src/v1/session.ts#L102), and [reader hydration/ordering](https://github.com/anomalyco/opencode/blob/bbd72fb8b0bb6de580d2041a0150016227c63ac0/packages/opencode/src/session/message-v2.ts#L80).
