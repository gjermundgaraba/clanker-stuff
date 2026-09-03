import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  boundDurableText,
  createControlStore,
  freshSnapshot,
  rootBinding,
  serializeSnapshot,
} from "../snapshot.js";

describe("atomic control store", () => {
  it("round-trips one authoritative snapshot", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "subagents-store-"));
    try {
      const root = rootBinding("root-id", path.join(directory, "root.jsonl"));
      const store = createControlStore(directory, root);
      const snapshot = freshSnapshot("v2", root);
      if (snapshot.protocolLatch !== "v2") {
        throw new Error("Expected V2");
      }
      snapshot.state.nodes.push({
        nickname: "worker",
        path: "/root/worker",
        sessionFile: "/sessions/worker.jsonl",
        status: "interrupted",
        tools: [],
      });
      snapshot.nicknames.push("worker");
      let committed = false;
      await store.write(JSON.stringify(snapshot), () => {
        committed = true;
      });

      await expect(store.load()).resolves.toStrictEqual(snapshot);
      expect(committed).toBeTruthy();
      const { readdir } = await import("node:fs/promises");
      const [file] = await readdir(path.join(directory, "trees"));
      assert.ok(file);
      const controlPath = path.join(directory, "trees", file);
      expect(JSON.parse(await readFile(controlPath, "utf-8"))).toStrictEqual(snapshot);
      const info = await lstat(controlPath);
      expect(info.isFile()).toBeTruthy();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("binds the file name to both root path and header id", () => {
    const first = rootBinding("one", "/tmp/root.jsonl");
    const second = rootBinding("two", "/tmp/root.jsonl");
    expect(first).not.toStrictEqual(second);
  });

  it("rejects a pending V2 node without its owned task mail", () => {
    const root = rootBinding("invalid");
    const snapshot = freshSnapshot("v2", root);
    if (snapshot.protocolLatch !== "v2") {
      throw new Error("Expected V2");
    }
    snapshot.nicknames.push("worker");
    snapshot.state.nodes.push({
      activeDeliveryId: "missing",
      nickname: "worker",
      path: "/root/worker",
      sessionFile: "/sessions/worker.jsonl",
      status: "pending",
      tools: [],
    });
    expect(() => serializeSnapshot(snapshot)).toThrow("has no task mail");
  });

  it("rejects notifications that reference no V1 agent", () => {
    const snapshot = freshSnapshot("v1", rootBinding("invalid"));
    if (snapshot.protocolLatch !== "v1") {
      throw new Error("Expected V1");
    }
    snapshot.state.notifications.push({
      agentId: "missing",
      content: "done",
      id: "notification",
    });
    expect(() => serializeSnapshot(snapshot)).toThrow("unknown agent");
  });

  it("bounds the serialized representation of durable text", () => {
    const result = boundDurableText("\0".repeat(100), 64);

    expect(Buffer.byteLength(JSON.stringify(result), "utf-8") - 2).toBeLessThanOrEqual(64);
    expect(result.endsWith("…")).toBeTruthy();
  });
});
