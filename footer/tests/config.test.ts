import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFooterConfigStore,
  DEFAULT_CONFIG,
  parseFooterConfig,
} from "../config.js";

describe("footer config store", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) {
      await rm(directory, { force: true, recursive: true });
    }
    directory = undefined;
  });

  it("preserves invalid input until an explicit atomic save", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "footer-config-"));
    const configPath = path.join(directory, "footer.json");
    await writeFile(configPath, '{"version":1,"unknown":true}\n');
    const store = createFooterConfigStore(configPath);

    const loaded = await store.load();
    expect(loaded.error).toContain("Invalid");
    await expect(readFile(configPath, "utf-8")).resolves.toContain('"unknown"');

    await store.save(DEFAULT_CONFIG);
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toStrictEqual(
      DEFAULT_CONFIG
    );
  });

  it("uses an absolute mutation-queue key", () => {
    expect(createFooterConfigStore("relative/footer.json").path).toBe(
      path.resolve("relative/footer.json")
    );
  });
});

describe(parseFooterConfig, () => {
  it("rejects unknown config fields", () => {
    expect(() =>
      parseFooterConfig({
        enabled: true,
        iconFamily: "unicode",
        rows: [{ center: [], left: [], right: [] }],
        separator: "·",
        unknown: true,
        version: 1,
        widgets: {},
      })
    ).toThrow("strict object");
  });

  it("rejects control-bearing widget IDs in configuration", () => {
    const nativeId = "status:line\n\u001B[31m";
    expect(() =>
      parseFooterConfig({
        enabled: true,
        iconFamily: "unicode",
        rows: [{ center: [], left: [nativeId], right: [] }],
        separator: "·",
        version: 1,
        widgets: {},
      })
    ).toThrow("terminal controls");
    expect(() =>
      parseFooterConfig({
        enabled: true,
        iconFamily: "unicode",
        rows: [{ center: [], left: [], right: [] }],
        separator: "·",
        version: 1,
        widgets: { [nativeId]: { enabled: false } },
      })
    ).toThrow("terminal controls");
  });
});
