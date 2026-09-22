import { rm } from "node:fs/promises";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { patchEnv } from "../../../tests/helpers/env.js";
import { createTempDir } from "../../../tests/helpers/fs.js";
import { loadHistory, openHistoryDatabase, saveHistoryBatch, saveHistoryItem } from "../storage.js";

describe("history storage", () => {
  it("stores history by most recent use", async () => {
    const agentDir = await createTempDir("history-");
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
  });
  it("rolls back an entire failed batch and does not replace newer timestamps", async () => {
    const agentDir = await createTempDir("history-storage-");
    const restoreAgentDir = patchEnv({ PI_CODING_AGENT_DIR: agentDir });
    const database = openHistoryDatabase();
    onTestFinished(async () => {
      database.close();
      restoreAgentDir();
      await rm(agentDir, { force: true, recursive: true });
    });
    saveHistoryItem(database, { text: "existing", timestamp: 300 });
    saveHistoryItem(database, { text: "existing", timestamp: 100 });
    database.exec(`CREATE TRIGGER reject_bad BEFORE INSERT ON history
      WHEN NEW.text = 'bad' BEGIN SELECT RAISE(FAIL, 'bad row'); END;`);
    expect(() =>
      saveHistoryBatch(database, [
        { text: "rolled back", timestamp: 400 },
        { text: "bad", timestamp: 500 },
      ]),
    ).toThrow("bad row");
    expect(loadHistory(database)).toEqual([{ text: "existing", timestamp: 300 }]);
  });
});
