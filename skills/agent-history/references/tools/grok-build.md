# Grok Build

## Operator Summary

Primary source: `$GROK_HOME/sessions`.

Collect: per-session JSONL/JSON files, memory when relevant to the task, and session search DB as secondary index.

Parse: [../parse/jsonl.md](../parse/jsonl.md), [../parse/sqlite.md](../parse/sqlite.md).

Ignore first: auth, logs, hooks, marketplace cache, bundled docs, and memory unless required.

Status: verified storage, partial parser contract.

History scope: default-local.

Last verified: local macOS, structural inspection and installed docs.

## Sources

| Priority | Location                                                            | Kind   | Authority        | Contains                  | Parser State | Collection Policy | Sensitivity |
| -------- | ------------------------------------------------------------------- | ------ | ---------------- | ------------------------- | ------------ | ----------------- | ----------- |
| 1        | `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl`      | JSONL  | primary          | authoritative restore log | partial      | collect           | secret      |
| 1        | `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl` | JSONL  | model stream     | raw model chat stream     | partial      | collect           | private     |
| 2        | `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/events.jsonl`       | JSONL  | event log        | tool/phase events         | partial      | collect           | private     |
| 2        | `$GROK_HOME/sessions/<encoded-cwd>/<session-id>/*.json`             | JSON   | metadata/context | summaries/context/signals | schema_known | collect           | private     |
| 3        | `$GROK_HOME/sessions/session_search.sqlite`                         | SQLite | index            | searchable session docs   | schema_known | ignore_by_default | private     |

## Find

Resolve `${GROK_HOME:-$HOME/.grok}`. Sessions are grouped by encoded working directory.

## Fetch

Read only the relevant files in the selected session directory. Treat the search DB as a derived index; use read-only SQLite access or a [consistent backup](../collect/sqlite-safe-copy.md) if it is needed. Exclude auth, unrelated logs/hooks, and memory outside the requested scope.

## Parse

Installed docs identify `updates.jsonl` as the authoritative restore log and `chat_history.jsonl` as the stream sent to the model. Read chat records with their observed native role/content fields for content questions; identify event-log evidence separately. This card does not establish replay rules for updates, rewinds, or compaction. Do not concatenate these files or claim that a raw model stream reconstructs the final active conversation.

## Source-specific hazards

Update logs may include prompt-context values and rewind snapshots; auth, hooks, marketplace state, and memory are separate from conversation streams.

## Gaps

Complete update/rewind replay and final active-conversation reconstruction are not established here. State which stream supports an answer and what remains unknown.

## Evidence

Local filesystem verification and installed session/memory docs.
