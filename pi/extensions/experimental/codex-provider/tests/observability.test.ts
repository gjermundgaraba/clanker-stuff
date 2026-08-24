import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { CodexObservability } from "../observability.js";

describe("SQLite observations", () => {
  it("stores session events and removes rows older than 30 days on open", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-observability-"));
    onTestFinished(() => rm(root, { force: true, recursive: true }));
    const databasePath = path.join(root, "codex-provider.sqlite");
    const stale = new DatabaseSync(databasePath);
    stale.exec("CREATE TABLE events (obsolete TEXT); PRAGMA user_version = 9");
    stale.close();
    const now = Date.now();
    const store = new CodexObservability(databasePath);

    expect([
      store.record("session-a", "request", { value: "old" }, now - 31 * 86_400_000),
      store.record("session-a", "request", { value: "new" }, now),
      store.record("session-b", "compaction", { value: "other" }, now),
      store.record("session-a", "request", { value: 1n }, now),
    ]).toStrictEqual([true, true, true, false]);
    const writeError = store.lastError;
    expect(writeError).toMatch(/BigInt/u);
    store.list("session-a");
    expect(store.lastError).toBe(writeError);
    store.close();

    const reopened = new CodexObservability(databasePath);
    expect(reopened.list("session-a")).toStrictEqual([
      {
        data: { value: "new" },
        kind: "request",
        timestamp: now,
      },
    ]);
    reopened.close();
  });
});
