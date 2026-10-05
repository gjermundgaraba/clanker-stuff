# Devin CLI

## Operator Summary

Primary source: Devin CLI session database and transcript sidecars.

Collect: CLI session DB with sidecars, transcript JSON, and summary files only if needed.

Parse: [../parse/sqlite.md](../parse/sqlite.md) and JSON.

Ignore first: credentials, logs, app profile, caches, and rendered HTML unless needed.

Status: verified storage, partial parser contract.

History scope: default-local.

Last verified: local macOS, schema inspected without transcript bodies.

## Sources

| Priority | Location                                          | Kind     | Authority       | Contains               | Parser State  | Collection Policy   | Sensitivity |
| -------- | ------------------------------------------------- | -------- | --------------- | ---------------------- | ------------- | ------------------- | ----------- |
| 1        | `$HOME/.local/share/devin/cli/sessions.db`        | SQLite   | primary         | sessions/message graph | partial       | collect             | private     |
| 1        | `$HOME/.local/share/devin/cli/transcripts/*.json` | JSON     | primary/sidecar | exported-like steps    | partial       | collect             | private     |
| 2        | `$HOME/.local/share/devin/cli/summaries/`         | Markdown | derived         | summaries              | schema_known  | collect_when_needed | private     |
| 3        | credentials/logs/cache                            | mixed    | support         | secrets/logs           | metadata_only | ignore_by_default   | secret      |

## Find

Use the CLI data root under `$HOME/.local/share/devin/cli`.

## Fetch

Use read-only SQLite access or a [consistent backup](../collect/sqlite-safe-copy.md). Read only transcript JSON sidecars associated with the requested session; use summaries as derived context when relevant.

## Parse

Inspect the selected database schema for session and message relationships, and inspect the associated transcript JSON structure. Follow explicit native parent links and step order where present. This card does not establish exact table names, content paths, or precedence between DB graph and JSON sidecars. If they disagree, identify both sources and the unresolved precedence; do not merge them into an invented authoritative sequence.

## Source-specific hazards

Adjacent stores can contain credentials, cookies, logs, and rendered HTML; these are not interchangeable with transcript records.

## Gaps

Exact fields and source precedence between the DB graph and transcript sidecars are not established here. A summary or rendered artifact is not evidence of a complete transcript.

## Evidence

Local schema verification.
