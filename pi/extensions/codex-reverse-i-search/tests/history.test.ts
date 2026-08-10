import { rm } from "node:fs/promises";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished } from "vitest";

import { patchEnv } from "../../../tests/helpers/env.js";
import { createTempDir } from "../../../tests/helpers/fs.js";
import {
  getDataVersion,
  historyFromEntries,
  importPersistentHistory,
  loadHistory,
  normalizeHistory,
  openHistoryDatabase,
  saveHistoryBatch,
  saveHistoryItem,
} from "../history.js";
import { userEntry } from "./fixtures.js";

describe("prompt history", () => {
  it("extracts, orders, and deduplicates session history", () => {
    const entries: SessionEntry[] = [
      userEntry("older", null, " Build Release ", 100),
      {
        id: "bash",
        message: {
          cancelled: false,
          command: "pnpm test",
          excludeFromContext: true,
          exitCode: 0,
          output: "",
          role: "bashExecution",
          timestamp: 200,
          truncated: false,
        },
        parentId: "older",
        timestamp: new Date(200).toISOString(),
        type: "message",
      },
      userEntry("newer", "bash", "Build Release", 300),
    ];

    expect(normalizeHistory(historyFromEntries(entries))).toStrictEqual([
      { text: "Build Release", timestamp: 300 },
      { text: "!!pnpm test", timestamp: 200 },
    ]);
  });

  it("stops an import that has been cancelled", async () => {
    const agentDir = await createTempDir("reverse-i-search-history-");
    const restoreAgentDir = patchEnv({ PI_CODING_AGENT_DIR: agentDir });
    const database = openHistoryDatabase();
    const abort = new AbortController();
    abort.abort();
    onTestFinished(async () => {
      database.close();
      restoreAgentDir();
      await rm(agentDir, { force: true, recursive: true });
    });

    await expect(
      importPersistentHistory(database, "", () => {}, abort.signal)
    ).rejects.toThrow("This operation was aborted");
  });

  it("stores history by most recent use", async () => {
    const agentDir = await createTempDir("reverse-i-search-history-");
    const restoreAgentDir = patchEnv({ PI_CODING_AGENT_DIR: agentDir });
    const database = openHistoryDatabase();
    onTestFinished(async () => {
      database.close();
      restoreAgentDir();
      await rm(agentDir, { force: true, recursive: true });
    });

    saveHistoryBatch(database, [
      { text: "first", timestamp: 100 },
      { text: "second", timestamp: 200 },
    ]);
    saveHistoryItem(database, { text: "first", timestamp: 300 });

    expect(loadHistory(database)).toStrictEqual([
      { text: "first", timestamp: 300 },
      { text: "second", timestamp: 200 },
    ]);
    expect(getDataVersion(database)).toBeTypeOf("number");
  });
});
