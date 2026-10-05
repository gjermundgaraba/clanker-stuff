# Read SQLite history

SQLite stores may contain primary transcripts, indexes, UI state, or secrets. Classification matters before parsing.

## Safe Probe

```sh
sqlite3 "file:$DB?mode=ro" ".tables"
sqlite3 "file:$DB?mode=ro" "pragma table_info(<table>);"
```

Use schema inspection to identify transcript tables and relationships, then query or search relevant content. Mixed application-state databases may also contain unrelated key-value rows and credential tables.

## Query the selected history

Use the tool card's known table/field guidance, checking it against the selected database's schema. Bind session IDs, search terms, and other values as query parameters. Prefer targeted queries over unrestricted `SELECT *` across mixed application state.

Join through observed keys, and use an explicit native ordering column when one is established. Database row order without `ORDER BY`, arbitrary IDs, and storage offsets do not prove conversation order. Inspect relevant JSON payloads for roles and content blocks while preserving message/part relationships. Report missing relationships or ambiguous ordering rather than guessing a universal session/message schema.

Use read-only access for direct queries. When multiple queries must describe one consistent state, use a read transaction or a [consistent backup](../collect/sqlite-safe-copy.md). A standalone native query is enough for a focused answer; normalization is needed only when that is itself the task.

## Common Hazards

- A live database and separately copied WAL files may represent different moments; use the linked backup guidance when collecting a copy.
- FTS/search tables duplicate text but are not usually canonical.
- Key-value tables can mix UI state, secrets, and transcript-like blobs.
- Some stores use compressed or binary BLOB values.
