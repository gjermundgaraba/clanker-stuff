# GitHub Copilot

## Operator Summary

Primary source: editor chat/session stores when present; local samples may be metadata-only or empty.

Collect: VS Code chat session JSON and relevant `state.vscdb` entries only when sessions exist.

Parse: [../parse/sqlite.md](../parse/sqlite.md), JSON.

Ignore first: `$HOME/.copilot` metadata/logs, auth, extension code, secret rows, and empty session shells.

Status: partial.

History scope: default-local.

Last verified: local macOS/editor profile, sessions structurally inspected.

## Sources

| Priority | Location                                   | Kind       | Authority         | Contains          | Parser State  | Collection Policy | Sensitivity |
| -------- | ------------------------------------------ | ---------- | ----------------- | ----------------- | ------------- | ----------------- | ----------- |
| 1        | VS Code `chatSessions/*.json`              | JSON       | primary candidate | chat sessions     | partial       | collect           | private     |
| 1        | VS Code `chatEditingSessions/*/state.json` | JSON       | primary candidate | edit sessions     | partial       | collect           | private     |
| 2        | VS Code `state.vscdb`                      | SQLite     | state/index       | chat/editor state | partial       | collect           | private     |
| 3        | `$HOME/.copilot`                           | files/logs | support           | metadata/logs     | metadata_only | ignore_by_default | private     |

## Find

Check each editor profile separately. Copilot state can live in VS Code, Insiders, VSCodium, Cursor, JetBrains, or other host profiles depending on installation.

## Fetch

Read the selected editor session JSON directly. Use read-only SQLite queries or a [consistent backup](../collect/sqlite-safe-copy.md) only when needed to resolve that session. Exclude auth/secret rows.

## Parse

Inspect the selected session JSON for actual requests/messages rather than treating an empty session shell as a conversation. Follow fields and ordering present in that host editor/version. This card does not establish universal content paths or SQLite key names across editors; if only metadata is available, report that the message history was not recovered. Keep edit-session state separate from conversational messages.

## Source-specific hazards

Editor stores can mix chat state with auth/secret rows, extension logs, and unrelated editor/file history.

## Gaps

Host-specific content and ordering fields are not fully documented here. Some known locations contain only empty shells or metadata; absence of messages in one profile does not prove there is no history in another relevant profile.

## Evidence

Local editor profile verification.
