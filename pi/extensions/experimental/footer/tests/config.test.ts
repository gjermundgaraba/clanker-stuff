import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createFooterConfigStore, DEFAULT_CONFIG, parseFooterConfig } from "../config.js";

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
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toStrictEqual(DEFAULT_CONFIG);
  });

  it("uses an absolute mutation-queue key", () => {
    expect(createFooterConfigStore("relative/footer.json").path).toBe(
      path.resolve("relative/footer.json"),
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
      }),
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
      }),
    ).toThrow("terminal controls");
    expect(() =>
      parseFooterConfig({
        enabled: true,
        iconFamily: "unicode",
        rows: [{ center: [], left: [], right: [] }],
        separator: "·",
        version: 1,
        widgets: { [nativeId]: { enabled: false } },
      }),
    ).toThrow("terminal controls");
  });
});

describe("footer config constraints and copying", () => {
  it.each([
    { ...DEFAULT_CONFIG, rows: [] },
    {
      ...DEFAULT_CONFIG,
      rows: Array.from({ length: 4 }, () => ({ left: [], center: [], right: [] })),
    },
    { ...DEFAULT_CONFIG, separator: "🦄".repeat(9) },
    { ...DEFAULT_CONFIG, rows: [{ left: ["x".repeat(257)], center: [], right: [] }] },
    { ...DEFAULT_CONFIG, widgets: { ["🦄".repeat(257)]: {} } },
  ])("enforces structural limits on load and typed save", async (config) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "footer-limits-"));
    try {
      const configPath = path.join(directory, "footer.json");
      const text = JSON.stringify(config);
      await writeFile(configPath, text);
      const store = createFooterConfigStore(configPath);
      expect((await store.load()).error).toContain("Invalid");
      await expect(store.save(config)).rejects.toThrow();
      await expect(readFile(configPath, "utf-8")).resolves.toBe(text);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses code-point limits and copies rows and overrides", () => {
    const source = {
      ...DEFAULT_CONFIG,
      separator: "🦄".repeat(8),
      rows: [{ left: ["🦄".repeat(256)], center: [], right: [] }],
      widgets: { ["🦄".repeat(256)]: { enabled: false } },
    };
    const config = parseFooterConfig(source);
    source.rows[0].left[0] = "changed";
    source.widgets["🦄".repeat(256)].enabled = true;
    expect(config.rows[0]?.left[0]).toBe("🦄".repeat(256));
    expect(config.widgets["🦄".repeat(256)]).toStrictEqual({ enabled: false });
    expect(config.separator).toBe("🦄".repeat(8));
  });

  it("retains semantic separator diagnostics", () => {
    expect(() => parseFooterConfig({ ...DEFAULT_CONFIG, separator: "\u0085" })).toThrow(
      "printable code points",
    );
  });
});
