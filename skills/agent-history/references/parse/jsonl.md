# Read JSONL history

Prefer the requested file or the tool card's transcript patterns over a broad search. A `.jsonl` or `.log` suffix alone does not establish that a file is a canonical conversation.

## Inspect structure

When the record shape is unknown, a bounded key/type probe can help:

```sh
head -20 "$FILE" | jq -c 'keys' | sort | uniq -c
head -100 "$FILE" | jq -r '.type // .role // empty' | sort | uniq -c
```

These are bounded probes, not a complete search. An actively written file can end with a partial JSON record; report an incomplete tail and retain the complete records rather than treating the whole file as unreadable.

## Read the relevant records

Use the tool card's known fields and verify their presence and types in the selected file. Read or search message/content fields and tool results as needed for the task, using session, project, time, or topic filters when useful.

Preserve file position as evidence of record order. Use native session IDs, roles, timestamps, message IDs, and parent references where they exist; do not invent missing values. Parent links or branch records may mean append order is not the active conversation. Keep tool calls and results associated by their recorded IDs where available, and retain ordered content blocks instead of treating tool payloads as ordinary user text.

Distinguish complete message snapshots from deltas and telemetry. Do not concatenate repeated snapshots or replay unknown update formats as if their semantics were established. If branch reconstruction, delta replay, or a record variant is unsupported, say what can be read and which part of the answer remains unresolved. Native-field inspection does not require building a normalized data model.
