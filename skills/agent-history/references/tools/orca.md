# Orca

## Operator Summary

Primary source: Orca app support state and orchestration DB, when Orca-orchestrated agent interactions are in scope.

Collect: orchestration DB, app data JSON, terminal histories/scrollback when relevant to the task.

Parse: [../parse/sqlite.md](../parse/sqlite.md), JSON.

Ignore first: cookies, Local Storage, Session Storage, keypairs, tokens, logs, embedded agent runtime homes, and caches.

Status: verified storage, partial parser contract.

History scope: default-local.

Last verified: local macOS, structural inspection only.

## Sources

| Priority | Location                                                  | Kind       | Authority         | Contains                          | Parser State  | Collection Policy   | Sensitivity |
| -------- | --------------------------------------------------------- | ---------- | ----------------- | --------------------------------- | ------------- | ------------------- | ----------- |
| 1        | `$HOME/Library/Application Support/orca/orchestration.db` | SQLite     | primary candidate | tasks/messages/dispatch context   | partial       | collect             | private     |
| 1        | `$HOME/Library/Application Support/orca/orca-data.json`   | JSON       | app state         | projects/workspaces/session state | partial       | collect             | private     |
| 2        | terminal history/scrollback dirs                          | text/files | secondary         | terminal interactions             | partial       | collect_when_needed | private     |
| 2        | agent overlay/hook dirs                                   | files      | support           | agent integration state           | schema_known  | collect_when_needed | private     |
| 3        | browser/Electron stores and keypairs                      | mixed      | auth/cache        | secrets/cache                     | metadata_only | ignore_by_default   | secret      |

## Find

Use app support root and `$HOME/.orca` for hooks/integration state. Orca may contain traces for other agents; do not confuse embedded runtime homes with primary Orca transcripts.

## Fetch

Use read-only SQLite access or a [consistent backup](../collect/sqlite-safe-copy.md) for the selected orchestration data. Read app-state JSON only when it identifies relevant work; collect terminal history when relevant to the task.

## Parse

Inspect native task/message/dispatch relationships in the selected schema and use explicit workspace/session links from app-state JSON. Exact table names, content paths, and message ordering are not established in this card. Distinguish Orca orchestration records from a nested agent conversation and terminal scrollback; neither a task result nor app-state metadata proves that the full conversation was captured.

## Source-specific hazards

Terminal scrollback and nested agent histories are distinct from orchestration messages. Adjacent browser storage, keypairs, and tokens are not conversation sources.

## Gaps

The exact orchestration schema and boundaries with adjacent agent stores are not fully documented. Report the source actually read and any missing conversation data.

## Evidence

Local app support verification.
