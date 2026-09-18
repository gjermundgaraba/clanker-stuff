import path from "node:path";
import { mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import { patchEnv } from "../../../tests/helpers/env.js";
import { createTempDir } from "../../../tests/helpers/fs.js";
import { userEntry } from "./fixtures.js";
import { importPersistentHistory } from "../import.js";
import { loadHistory, openHistoryDatabase } from "../storage.js";

const setup = async () => {
  const agentDir = await createTempDir("history-import-");
  const restoreAgentDir = patchEnv({ PI_CODING_AGENT_DIR: agentDir });
  const database = openHistoryDatabase();
  const abort = new AbortController();
  onTestFinished(async () => {
    vi.restoreAllMocks();
    database.close();
    restoreAgentDir();
    await rm(agentDir, { force: true, recursive: true });
  });

  return { agentDir, database, abort };
};

const session = (text: string) =>
  [
    JSON.stringify({
      type: "session",
      version: 3,
      id: text,
      cwd: "/project",
      timestamp: new Date(50).toISOString(),
    }),
    JSON.stringify(userEntry(text, null, text, 100)),
  ].join("\n");

describe("history import", () => {
  it("stops an import that has been cancelled", async () => {
    const { database, abort } = await setup();
    abort.abort();

    await expect(importPersistentHistory(database, "", () => {}, abort.signal)).rejects.toThrow(
      "This operation was aborted",
    );
  });
  it("stops between files while keeping already committed history", async () => {
    const { agentDir, database, abort } = await setup();
    const directory = path.join(agentDir, "sessions", "project");
    await mkdir(directory, { recursive: true });

    for (const id of ["a", "b"]) {
      await writeFile(path.join(directory, `${id}.jsonl`), session(id));
    }

    await expect(
      importPersistentHistory(
        database,
        directory,
        (status) => {
          if (status.startsWith("importing")) abort.abort();
        },
        abort.signal,
      ),
    ).rejects.toThrow("This operation was aborted");
    expect(loadHistory(database)).toHaveLength(1);
  });
  it("reads candidates once, validates headers and tolerates malformed lines", async () => {
    const { agentDir, database, abort } = await setup();
    const directory = path.join(agentDir, "sessions", "project");
    await mkdir(directory, { recursive: true });
    const valid = path.join(directory, "valid.jsonl");
    await writeFile(
      valid,
      [
        "{broken",
        "null",
        "",
        session("imported prompt"),
        "{broken after header",
        JSON.stringify({ message: { role: "assistant", content: "unused".repeat(10000) } }),
        JSON.stringify(userEntry("later", null, "later prompt", 200)),
      ].join("\r\n"),
    );
    await writeFile(
      path.join(directory, "missing-header.jsonl"),
      JSON.stringify(userEntry("missing", null, "must skip", 100)),
    );
    await writeFile(path.join(directory, "late-header.jsonl"), "{}\n" + session("must also skip"));
    await writeFile(path.join(directory, "empty.jsonl"), "{broken\nnull\n");
    await mkdir(path.join(directory, "directory.jsonl"));
    const parses = vi.spyOn(JSON, "parse");
    const progress: string[] = [];

    const count = await importPersistentHistory(
      database,
      directory,
      (status) => progress.push(status),
      abort.signal,
    );

    expect(count).toBe(1);
    expect(
      parses.mock.calls.filter(([line]) => line === session("imported prompt").split("\n")[1]),
    ).toHaveLength(1);
    expect(loadHistory(database).map(({ text }) => text)).toEqual([
      "later prompt",
      "imported prompt",
    ]);
    expect(progress.at(-1)).toBe("importing history: 5/5 files");
  });

  it("keeps valid prompts before and after malformed supported messages", async () => {
    const { agentDir, database, abort } = await setup();
    const directory = path.join(agentDir, "sessions", "project");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "mixed.jsonl"),
      [
        session("before malformed"),
        JSON.stringify({ message: { role: "user", content: 123, timestamp: 2 } }),
        JSON.stringify({ message: { role: "user", content: [null], timestamp: 2 } }),
        JSON.stringify({ message: { role: "bashExecution", command: 123, timestamp: 2 } }),
        JSON.stringify(userEntry("after", null, "after malformed", 200)),
      ].join("\n"),
    );
    expect(await importPersistentHistory(database, directory, () => {}, abort.signal)).toBe(1);
    expect(loadHistory(database)).toEqual([
      { text: "after malformed", timestamp: 200 },
      { text: "before malformed", timestamp: 100 },
    ]);
  });

  it("scans immediate project directories, symlinks and the custom directory only", async () => {
    const { agentDir, database, abort } = await setup();
    const root = path.join(agentDir, "sessions");
    const project = path.join(root, "project");
    const nested = path.join(project, "nested");
    const linked = path.join(agentDir, "linked");
    const custom = path.join(agentDir, "custom");

    for (const directory of [nested, linked, custom]) await mkdir(directory, { recursive: true });
    await symlink(linked, path.join(root, "symlink"));
    await symlink(path.join(agentDir, "missing"), path.join(root, "broken-symlink"));

    for (const [directory, text] of [
      [root, "root ignored"],
      [nested, "nested ignored"],
      [project, "project prompt"],
      [linked, "linked prompt"],
      [custom, "custom prompt"],
    ] as const) {
      await writeFile(path.join(directory, "session.jsonl"), session(text));
    }

    await writeFile(path.join(project, "ignored.txt"), session("non-jsonl ignored"));
    expect(await importPersistentHistory(database, custom, () => {}, abort.signal)).toBe(3);
    expect(
      loadHistory(database)
        .map(({ text }) => text)
        .sort(),
    ).toEqual(["custom prompt", "linked prompt", "project prompt"]);
  });

  it("cancels during a file read without committing a partial file", async () => {
    const { agentDir, database, abort } = await setup();
    const directory = path.join(agentDir, "sessions", "project");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "large.jsonl"),
      session("uncommitted prompt") + "\n" + " ".repeat(200000),
    );
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const entry: unknown = parse(text, reviver);

      if (text.includes('"content":"uncommitted prompt"')) abort.abort();

      return entry;
    });
    await expect(
      importPersistentHistory(database, directory, () => {}, abort.signal),
    ).rejects.toThrow("aborted");
    expect(loadHistory(database)).toEqual([]);
  });

  it("rolls back all prompts in a file when one write fails", async () => {
    const { agentDir, database, abort } = await setup();
    const directory = path.join(agentDir, "sessions", "project");
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "session.jsonl"),
      session("rolled back") + "\n" + JSON.stringify(userEntry("bad", null, "bad prompt", 200)),
    );
    database.exec(`CREATE TRIGGER reject_bad BEFORE INSERT ON history
      WHEN NEW.text = 'bad prompt' BEGIN SELECT RAISE(FAIL, 'bad row'); END;`);
    await expect(
      importPersistentHistory(database, directory, () => {}, abort.signal),
    ).rejects.toThrow("bad row");
    expect(loadHistory(database)).toEqual([]);
  });
});
