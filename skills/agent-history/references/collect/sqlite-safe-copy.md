# SQLite Safe Copy

Many agents use SQLite for transcript, index, or app state.

## Preferred Backup

Prefer direct read-only queries when a copy is unnecessary. For a stable copy of a live database, use SQLite's backup mechanism with a new destination outside the repository. This example handles paths without embedding them in SQLite shell commands:

```sh
python3 - "$SOURCE" "$DEST" <<'PY'
from pathlib import Path
import sqlite3
import sys

source = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
if destination.exists():
    raise SystemExit("Choose a new destination path")
with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as reader:
    with sqlite3.connect(destination) as copy:
        reader.backup(copy)
PY
```

The backup contains the committed state available to its read transaction, including committed rows still in the WAL. The resulting database is a standalone snapshot; do not attach separately copied source WAL/SHM files to it. If read-only access fails, report the obstacle rather than opening the source for writes or discarding its WAL.

Do not checkpoint, vacuum, or otherwise alter the source to obtain a copy.

## Sidecar Copy

Copy files directly only while all writers are stopped, or from a filesystem snapshot that captures the database and sidecars consistently. Sequential copies from a live writer are not a consistent backup. Under those conditions, preserve the main DB and any present sidecars together:

```text
database.db
database.db-wal
database.db-shm
```

Omitting the WAL can lose recent committed rows. The SHM file is a coordination index, not the transcript data; preserve it when present for this file-copy route rather than assuming it always exists. Never combine files from different snapshots.

## Safe Probe

To identify relevant tables and columns:

```sh
sqlite3 "file:$SOURCE?mode=ro" ".tables"
sqlite3 "file:$SOURCE?mode=ro" "pragma table_info(<table>);"
```

After identifying transcript tables, query or search relevant bodies. Arbitrary `value` or BLOB columns in mixed application-state databases may contain credentials rather than messages.
