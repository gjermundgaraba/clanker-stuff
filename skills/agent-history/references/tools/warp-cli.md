# Warp CLI

## Operator Summary

Primary source: macOS stable CLI's group-container `tui/warp.sqlite`, not `$HOME/.warp_cli` or diagnostic logs.

Collect: direct read-only SQLite access; use a consistent SQLite backup if a stable snapshot is needed.

Parse: SQLite metadata and query text are accessible; full task payload decoding is not established. See [SQLite guidance](../parse/sqlite.md).

Ignore first: settings, CLI binaries, logs, auth/account data, and the desktop terminal's separate stores.

Collection status: verified local store and read-only access.

Parser status: opaque task payloads; known metadata schema.

History scope: default-local.

Last verified: 2026-09-11, macOS, `v0.2026.09.09.08.26.stable_02`.

## Sources

| Priority | Location                                                                                                              | Kind   | Authority                     | Contains                                                                                      | Parser State  | Collection Policy | Sensitivity |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------- | --------------------------------------------------------------------------------------------- | ------------- | ----------------- | ----------- |
| 1        | `$HOME/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/tui/warp.sqlite` | SQLite | local conversation/task store | conversation metadata, binary tasks, AI queries, command history, unrelated app/account state | opaque        | collect           | secret      |
| 3        | `$HOME/.warp_cli/settings.toml`                                                                                       | TOML   | configuration                 | settings, not a transcript                                                                    | metadata_only | ignore_by_default | private     |
| 3        | `$HOME/Library/Logs/warp-cli/warp.log*`                                                                               | logs   | diagnostics                   | operational logs, not verified transcript authority                                           | pending       | ignore_by_default | secret      |

`2BBY89MBSN.dev.warp` is the application's macOS group identifier, not an account identifier. The `tui/` component distinguishes this observed CLI store from desktop app storage.

## Find

Run `scripts/find-transcripts.mjs --tool "Warp CLI"`, resolving the helper relative to the loaded `SKILL.md` directory.

The verified path is:

```sh
SOURCE="$HOME/Library/Group Containers/2BBY89MBSN.dev.warp/Library/Application Support/dev.warp.Warp-Stable/tui/warp.sqlite"
```

Narrow by `ai_queries.start_ts` for query activity, or `agent_conversations.last_modified_at` for conversation updates. A conversation modified today need not have been created today; neither count is a count of CLI launches. For SQLite's observed UTC-style timestamps, `date(start_ts, 'localtime') = date('now', 'localtime')` selects today's queries in the current local timezone.

For unknown installations, inspect open database file paths of the running Warp process rather than dumping its logs or settings. Linux, other release channels, and configurable roots have not been verified.

## Fetch

Use `mode=ro` and a read transaction for related queries. The CLI can keep multiple processes and WAL writers open. Do not copy only the live main DB, use `immutable=1`, checkpoint it, or delete sidecars. Follow [SQLite safe copy](../collect/sqlite-safe-copy.md) for a consistent snapshot outside the repository. A full backup includes unrelated sensitive tables.

## Parse

Verified tables and fields:

- `agent_conversations`: `id`, `conversation_id`, `conversation_data` (JSON text), `last_modified_at`, `summary`.
- `agent_tasks`: `id`, `conversation_id`, `task_id`, `task` (BLOB), `last_modified_at`.
- `ai_queries`: `id`, `exchange_id`, `conversation_id`, `start_ts`, `input`, `working_directory`, `output_status`, `model_id`, `planning_model_id`, `coding_model_id`.
- `commands`: shell command history, including `is_agent_executed`; this is not an assistant-message transcript.
- `blocks`: terminal block schema exists, but was empty in this CLI store. Do not assume terminal output is recoverable there.

Join conversation-related records by `conversation_id`. `ai_queries.input` is query text, not an assistant reply. Query timestamps support activity ordering; task row IDs and modification timestamps do not establish conversation turn order.

Observed `conversation_data` keys: `autoexecute_override`, `conversation_usage_metadata`, `run_id`, `server_conversation_token`, and optional `forked_from_server_conversation_token`. This is metadata, not a JSON message array. Conversation tokens may grant access; avoid exposing them. Installed CLI help advertises `--resume <RESUME>` for a server conversation token, but server recovery was not tested.

All sampled `task` BLOBs passed a protobuf wire-format structural probe. Observed top-level field numbers were 1, 2, 3, 5, and 8, all wire type 2 (length-delimited). Field names, nested messages, roles, tool results, compression of nested fields, and ordering remain unknown. Wire compatibility alone is not a verified protobuf schema; do not extract printable strings and present them as a reconstructed transcript.

## Normalize

Preserve `conversation_id`, query `exchange_id`, and task `task_id` as native provenance. Until task decoding is verified, report query-only evidence as partial history; do not infer assistant turns, branch replay, attachments, or tool-call mappings.

## Source-specific hazards

Query inputs, summaries, commands, working directories, task BLOBs, and conversation tokens are private. Adjacent tables include account identities, team information, and MCP environment/configuration values that may contain secrets.

## Gaps

- A verified task decoder and native message ordering are still needed for full transcripts.
- Local retention/completeness, deletion behavior, and cloud synchronization are unverified.
- No synthetic marker round-trip or server resume/export was performed.
- Platform and channel coverage is limited to the observed macOS stable CLI.

## Evidence

Local structural validation: repository note `evidence/warp-cli-local.md` (not bundled with the history skill). Only metadata/schema/count probes were performed; no full transcript decoding was verified.
