# Zed

## Operator Summary

Primary source: Zed Agent Panel threads database.

Collect: a read-only database view or consistent backup, plus relevant referenced sidecars.

Parse: [../parse/sqlite.md](../parse/sqlite.md) plus [../parse/compressed-json.md](../parse/compressed-json.md).

Ignore first: UI/workspace DBs, command logs, editor contents, external-agent traces, and raw KV values.

Status: verified storage, partial parser contract.

History scope: default-local.

Last verified: local macOS, compressed JSON structure verified without bodies.

## Sources

| Priority | Location                                                       | Kind                     | Authority | Contains                  | Parser State  | Collection Policy | Sensitivity |
| -------- | -------------------------------------------------------------- | ------------------------ | --------- | ------------------------- | ------------- | ----------------- | ----------- |
| 1        | `$HOME/Library/Application Support/Zed/threads/threads.db`     | SQLite + compressed JSON | primary   | Agent Panel threads       | partial       | collect           | private     |
| 2        | `$HOME/Library/Application Support/Zed/db/<profile>/db.sqlite` | SQLite                   | secondary | UI/workspace/thread index | schema_known  | collect           | private     |
| 3        | external agent registry/config                                 | JSON                     | support   | agent configuration       | metadata_only | ignore_by_default | private     |

## Find

Zed stores Agent Panel thread payloads in a dedicated threads DB. Supporting DBs can reference sidebars, workspaces, terminals, and external agents.

## Fetch

Use read-only SQLite access or a [consistent backup](../collect/sqlite-safe-copy.md); do not copy database and WAL files independently from a live writer.

## Parse

Inspect the selected thread table and payload metadata, then use a known decoder for its [compressed JSON](../parse/compressed-json.md). The codec and complete message/content variant mapping are not established in this card. If a decoder is unavailable, report that thread metadata is readable but the conversation payload is unsupported. Once decoded, use observed native roles, content blocks, and ordering; do not invent schema fields or treat an index entry as the transcript.

## Source-specific hazards

Supporting databases can contain unrelated drafts, editor contents, command logs, tokens, and cookies alongside thread metadata.

## Gaps

The exact codec and full payload mapping are not supplied here. Storage discovery alone does not establish that a thread can be decoded.

## Evidence

Local SQLite and compressed payload verification; public Zed Agent Panel docs.
