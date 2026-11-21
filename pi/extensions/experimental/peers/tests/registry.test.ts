import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createTempDir } from "../../../../tests/helpers/fs.js";
import { claim, livePeers, lookup, release } from "../registry.js";
import type { Peer } from "../registry.js";

const DEAD_PID = 999_999;

const peer = (name: string, sessionId: string, pid = process.pid): Peer => ({
  name,
  sessionId,
  pid,
  cwd: "/work",
});

describe("the peer registry", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await createTempDir("peers-registry-");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds a claimed name and forgets it once released", async () => {
    await expect(claim(dir, peer("b", "s1"))).resolves.toBeUndefined();
    await expect(lookup(dir, "b")).resolves.toStrictEqual(peer("b", "s1"));

    await release(dir, "b", "s1");

    await expect(lookup(dir, "b")).resolves.toBeUndefined();
  });

  it("refuses a name another live session holds, and names the holder", async () => {
    await claim(dir, peer("b", "s1"));

    await expect(claim(dir, peer("b", "s2"))).resolves.toStrictEqual(
      peer("b", "s1")
    );
    await expect(lookup(dir, "b")).resolves.toStrictEqual(peer("b", "s1"));
  });

  it("treats a name left by a dead process as free", async () => {
    await claim(dir, peer("b", "s1", DEAD_PID));

    await expect(lookup(dir, "b")).resolves.toBeUndefined();
    await expect(claim(dir, peer("b", "s2"))).resolves.toBeUndefined();
    await expect(lookup(dir, "b")).resolves.toStrictEqual(peer("b", "s2"));
  });

  it("does not release a name that another session has since taken", async () => {
    await claim(dir, peer("b", "s1", DEAD_PID));
    await claim(dir, peer("b", "s2"));

    await release(dir, "b", "s1");

    await expect(lookup(dir, "b")).resolves.toStrictEqual(peer("b", "s2"));
  });

  it("lists live peers by name, skipping dead ones and stray files", async () => {
    await claim(dir, peer("zed", "s1"));
    await claim(dir, peer("Refactor the login page", "s2"));
    await claim(dir, peer("gone", "s3", DEAD_PID));
    await writeFile(path.join(dir, "junk.json"), "{not json");

    const live = await livePeers(dir);
    const files = await readdir(dir);

    expect(live.map((p) => p.name)).toStrictEqual([
      "Refactor the login page",
      "zed",
    ]);
    expect(files.filter((file) => file.endsWith(".tmp"))).toStrictEqual([]);
  });
});
