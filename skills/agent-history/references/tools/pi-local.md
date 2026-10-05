# Pi Local Agent

## Operator Summary

Primary source: `$HOME/.pi/agent/sessions`.

Collect: timestamp-prefixed JSONL session files and running-summary JSON when useful.

Parse: [../parse/jsonl.md](../parse/jsonl.md).

Ignore first: caches, logs, credentials, and online Pi browser state.

Status: verified.

History scope: default-local.

Last verified: local macOS, storage shape inspected without transcript bodies.

## Sources

| Priority | Location                                                                | Kind  | Authority | Contains           | Parser State | Collection Policy   | Sensitivity |
| -------- | ----------------------------------------------------------------------- | ----- | --------- | ------------------ | ------------ | ------------------- | ----------- |
| 1        | `$HOME/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<session-id>.jsonl` | JSONL | primary   | session transcript | partial      | collect             | private     |
| 2        | `$HOME/.pi/agent/running-summary/sessions/<session-id>.json`            | JSON  | derived   | summary state      | schema_known | collect_when_needed | private     |

## Find

Project/session directories encode working directories. Timestamp-prefixed filenames are Pi local-agent format in this corpus; do not confuse them with Claude Code's current live store.

## Fetch

Read selected session JSONL directly. Use derived summary JSON only when the question needs it, and identify it as a summary rather than the complete transcript. Keep any temporary snapshots outside the repository.

## Parse

Inspect the `type: session` header's `version`, session `id`, `timestamp`, `cwd`, and optional `parentSession`. Entry records have their own `id`, `parentId`, and ISO timestamp; these entry IDs are distinct from the session ID.

For `type: message` entries, read `message.role` and `message.content`. User content can be a string or text/image blocks. Assistant content can include text, thinking, and `toolCall` blocks; a tool-call block has `id`, `name`, and object `arguments`. A `toolResult` message uses `toolCallId`, `toolName`, `content`, and `isError`. Message-level timestamps, when present, use Unix milliseconds rather than the entry's ISO string.

Follow `id`/`parentId` to identify a branch: file order can include abandoned paths. Compaction can carry `summary` and newer `retainedTail` or legacy `firstKeptEntryId`; do not append retained context to every earlier message. `branch_summary` summarizes a path identified by `fromId`; `custom` entries are extension state, while `custom_message` can participate in context. Historical text search need not replay active context, but should retain branch/source provenance.

## Source-specific hazards

Online Pi browser state, configuration, and credentials are separate from local session history.

## Gaps

Session versions differ, including older linear histories and legacy message roles. Apply fields only when present in that version. This guide does not reproduce the full migration or active-context reconstruction implementation.

## Evidence

Previous local storage inspection established paths without reading bodies. Field guidance comes from `@earendil-works/pi-coding-agent` version `0.85.1`, in the installed package's `docs/session-format.md`, covering versioned session entries and compaction. See the upstream [session-format guide](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/session-format.md) and [session manager](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/src/core/session-manager.ts) for the maintained definitions; check the installed package version when interpreting older records.
