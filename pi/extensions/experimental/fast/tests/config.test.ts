import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { loadFastDefault } from "../config.js";

describe("Fast read-only default", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "fast-config-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns off for a missing file without creating directories", async () => {
    await expect(
      loadFastDefault(path.join(root, "agent", "fast.json"))
    ).resolves.toBe(false);
    await expect(readdir(root)).resolves.toStrictEqual([]);
  });

  it.each([
    ['{"fast":true}', true],
    ['{"fast":false}', false],
    ['{"fast":true,"other":{"preserve":1}}', true],
  ] as const)("reads %s without altering its bytes", async (text, expected) => {
    const configPath = path.join(root, "fast.json");
    await writeFile(configPath, text);
    await expect(loadFastDefault(configPath)).resolves.toBe(expected);
    await expect(readFile(configPath, "utf-8")).resolves.toBe(text);
  });

  it.each(['{"fast":"true"}', "{}", "not json", "null", "[]", "true"])(
    "rejects malformed default %s without rewriting it",
    async (text) => {
      const configPath = path.join(root, "fast.json");
      await writeFile(configPath, text);

      await expect(loadFastDefault(configPath)).rejects.toThrow(
        /Expected an object with "fast": boolean|is not valid JSON/u
      );
      await expect(readFile(configPath, "utf-8")).resolves.toBe(text);
    }
  );

  it("reports a real I/O failure", async () => {
    const configPath = path.join(root, "fast.json");
    await mkdir(configPath);

    await expect(loadFastDefault(configPath)).rejects.toThrow("EISDIR");
    await expect(readdir(root)).resolves.toStrictEqual(["fast.json"]);
  });
});
