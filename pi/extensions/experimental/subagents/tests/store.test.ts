import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      status: "completed",
      thinking: "off",
      tools: ["read"],
    },
  ],
  outbox: [
    { content: "done", from: "/root/worker", id: "mail", kind: "FINAL_ANSWER", to: "/root" },
  ],
  version: 3,
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
      return (await readdir(path.join(dataDir, "trees-v3"))).map((name) =>
        path.join(dataDir, "trees-v3", name),
      );
    } catch {
      return [];
    }
  };

  it("writes nothing until the first save, then persists privately and round-trips", async () => {
    const opened = await openTree(dataDir, "session-1", true);
    expect(opened).toMatchObject({
      tree: { nodes: [], outbox: [], version: 3 },
      warning: undefined,
    });
    expect(await treeFiles()).toStrictEqual([]);

    await opened.store.save(tree);
    const [file] = await treeFiles();
    expect(file).toBeDefined();
    expect((await stat(file!)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file!))).mode & 0o777).toBe(0o700);

    expect(await openTree(dataDir, "session-1", true)).toMatchObject({ tree, warning: undefined });
    expect((await openTree(dataDir, "session-2", true)).tree.nodes).toStrictEqual([]);
  });

  it("keeps the newest of overlapping saves", async () => {
    const { store } = await openTree(dataDir, "session", true);
    const later = { ...tree, outbox: [] };
    await Promise.all([store.save(tree), store.save(later)]);

    expect((await openTree(dataDir, "session", true)).tree).toStrictEqual(later);
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
    expect(reopened.tree).toStrictEqual({ nodes: [], outbox: [], version: 3 });
    expect(reopened.warning).toContain("Starting a new subagent tree");
  });

  it("keeps in-memory root sessions off disk", async () => {
    const { store } = await openTree(dataDir, "session", false);
    await store.save(tree);

    expect(await treeFiles()).toStrictEqual([]);
    await expect(readFile(path.join(dataDir, "trees-v3"))).rejects.toThrow();
  });
});
