import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { Tree } from "../protocol.js";
import { openTree } from "../store.js";

const tree: Tree = {
  nodes: [
    {
      model: "provider/model",
      path: "/root/worker",
      sessionFile: "/sessions/worker.jsonl",
      startedAt: 1,
      status: "completed",
      thinking: "off",
      tools: ["read"],
      usage: { cacheRead: 0, cacheWrite: 0, cost: 0, input: 0, output: 0 },
    },
  ],
  outbox: [
    {
      content: "done",
      from: "/root/worker",
      id: "mail",
      kind: "FINAL_ANSWER",
      to: "/root",
    },
  ],
  version: 4,
};

describe(openTree, () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "subagents-store-"));
  });

  afterEach(async () => {
    await rm(dataDir, { force: true, recursive: true });
  });

  const treeFiles = async () => {
    try {
      const names = await readdir(path.join(dataDir, "trees-v4"));

      return names.map((name) => path.join(dataDir, "trees-v4", name));
    } catch {
      return [];
    }
  };

  it("writes nothing until the first save, then persists privately and round-trips", async () => {
    const opened = await openTree(dataDir, "session-1", true);
    expect(opened).toMatchObject({
      tree: { nodes: [], outbox: [], version: 4 },
      warning: undefined,
    });
    await expect(treeFiles()).resolves.toStrictEqual([]);

    await opened.store.save(tree);
    const [file] = await treeFiles();
    expect(file).toBeDefined();
    const fileStats = await stat(file!);
    expect(fileStats.mode & 0o777).toBe(0o600);
    const dirStats = await stat(path.dirname(file!));
    expect(dirStats.mode & 0o777).toBe(0o700);

    await expect(openTree(dataDir, "session-1", true)).resolves.toMatchObject({
      tree,
      warning: undefined,
    });
    const other = await openTree(dataDir, "session-2", true);
    expect(other.tree.nodes).toStrictEqual([]);
  });

  it("keeps the newest of overlapping saves", async () => {
    const { store } = await openTree(dataDir, "session", true);
    const later = { ...tree, outbox: [] };
    await Promise.all([store.save(tree), store.save(later)]);

    const reopened = await openTree(dataDir, "session", true);
    expect(reopened.tree).toStrictEqual(later);
  });

  it.each([
    ["malformed JSON", "{"],
    ["an earlier version", JSON.stringify({ ...tree, version: 2 })],
    ["an unknown field", JSON.stringify({ ...tree, revision: 1 })],
  ])("starts a fresh tree with a warning for %s", async (_label, contents) => {
    const { store } = await openTree(dataDir, "session", true);
    await store.save(tree);
    const [file] = await treeFiles();
    await writeFile(file!, contents);

    const reopened = await openTree(dataDir, "session", true);
    expect(reopened.tree).toStrictEqual({ nodes: [], outbox: [], version: 4 });
    expect(reopened.warning).toContain("Starting a new subagent tree");
  });

  it("keeps in-memory root sessions off disk", async () => {
    const { store } = await openTree(dataDir, "session", false);
    await store.save(tree);

    await expect(treeFiles()).resolves.toStrictEqual([]);
    await expect(readFile(path.join(dataDir, "trees-v4"))).rejects.toThrow(
      "ENOENT"
    );
  });
});
