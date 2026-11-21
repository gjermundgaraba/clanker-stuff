import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createTempDir } from "../../../../tests/helpers/fs.js";
import { post, take } from "../mailbox.js";

describe("the mailbox", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await createTempDir("peers-mailbox-");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hands each letter over once, oldest first, to its own session only", async () => {
    const later = await post(dir, "s1", {
      from: "a",
      to: "b",
      text: "second",
      sentAt: 2000,
    });

    const earlier = await post(dir, "s1", {
      from: "a",
      to: "b",
      text: "first",
      sentAt: 1000,
    });

    await post(dir, "s2", { from: "a", to: "c", text: "other", sentAt: 1 });

    await expect(take(dir, "s1")).resolves.toStrictEqual([earlier, later]);
    await expect(take(dir, "s1")).resolves.toStrictEqual([]);
    await expect(take(dir, "s2")).resolves.toHaveLength(1);
  });

  it("deletes and skips a file that is not a letter", async () => {
    const inbox = path.join(dir, "s1");
    await mkdir(inbox, { recursive: true });
    await writeFile(path.join(inbox, "000000000000001-bad.json"), "{nope");

    const letter = await post(dir, "s1", {
      from: "a",
      to: "b",
      text: "ok",
      sentAt: 5,
    });

    await expect(take(dir, "s1")).resolves.toStrictEqual([letter]);
    await expect(readdir(inbox)).resolves.toStrictEqual([]);
  });

  it("has nothing for a session that never got mail", async () => {
    await expect(take(dir, "nobody")).resolves.toStrictEqual([]);
  });
});
