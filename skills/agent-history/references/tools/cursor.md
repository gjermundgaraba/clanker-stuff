# Cursor

## Operator Summary

Primary source: JSONL agent transcripts under `$HOME/.cursor/projects`, plus mixed Cursor app support state.

Collect: explicit agent transcript JSONL first; use workspace/global SQLite state and ACP metadata only when needed.

Parse: [../parse/jsonl.md](../parse/jsonl.md) for agent transcripts and [../parse/sqlite.md](../parse/sqlite.md) for app state, with opaque blob handling.

Ignore first: auth tokens, editor history, checkpoint contents, logs, and raw key-value blobs.

Status: verified storage; parser state is partial with some opaque blobs.

History scope: default-local.

Last verified: local macOS, structural inspection only.

## Sources

| Priority | Location                                                                                       | Kind   | Authority               | Contains                                                       | Parser State | Collection Policy | Sensitivity |
| -------- | ---------------------------------------------------------------------------------------------- | ------ | ----------------------- | -------------------------------------------------------------- | ------------ | ----------------- | ----------- |
| 1        | `$HOME/.cursor/projects/<encoded-workspace>/agent-transcripts/<session-id>/<session-id>.jsonl` | JSONL  | primary transcript      | ordered user/assistant messages with text and tool-call blocks | schema_known | collect           | private     |
| 1        | `$HOME/Library/Application Support/Cursor/User/workspaceStorage/<workspace-id>/state.vscdb`    | SQLite | primary candidate       | workspace AI/editor state                                      | partial      | collect           | private     |
| 1        | `$HOME/Library/Application Support/Cursor/User/globalStorage/state.vscdb`                      | SQLite | primary candidate/index | global AI state and blobs                                      | partial      | collect           | private     |
| 2        | `$HOME/.cursor/acp-sessions/<session-id>/meta.json`                                            | JSON   | metadata                | cwd/session metadata                                           | schema_known | collect           | private     |
| 2        | `$HOME/.cursor/projects/<encoded-workspace>/`                                                  | mixed  | agent workspace state   | logs/text/cache                                                | partial      | collect           | private     |

## Find

Check the exact `agent-transcripts/<session-id>/<session-id>.jsonl` pattern first. Cursor also uses VS Code-style `state.vscdb` files and key-value tables under app support roots.

## Fetch

Read selected transcript JSONL directly. For relevant app state, use read-only SQLite access or a [consistent backup](../collect/sqlite-safe-copy.md); inspect separate session metadata only when needed. Exclude auth/session secrets.

## Parse

Each transcript line has `role` and `message` keys. `message.content` is an ordered array containing `{"type":"text","text":...}` and `{"type":"tool_use","name":...,"input":...}` blocks. The verified format has no record IDs, timestamps, tool-call IDs, or tool-result records; use the enclosing directory name as the session ID and do not infer missing results or event times.

SQLite state needs key-specific handling for AI/composer/agent values. Some global key-value blobs are opaque and should not be treated as decoded transcripts.

## Source-specific hazards

App-state databases can mix transcript data with auth keys, unrelated key-value blobs, file snapshots, editor history, checkpoints, and worker logs.

## Gaps

Need reliable decoding of current Cursor agent blobs and composer state, plus verification of whether other Cursor versions include tool results or timestamps in agent transcript JSONL.

## Evidence

Local schema/key verification and public Cursor policy docs.
