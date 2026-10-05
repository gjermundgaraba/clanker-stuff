import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  createFooterConfigStore,
  DEFAULT_CONFIG,
  formatFooterConfig,
  parseFooterConfig,
} from "../config.js";
import type { FooterConfig } from "../config.js";

describe("footer config store", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "footer-config-"));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("uses the default for a missing file without creating one", async () => {
    const configPath = path.join(directory, "footer.json");

    expect(await createFooterConfigStore(configPath).load()).toStrictEqual({
      config: DEFAULT_CONFIG,
    });
    await expect(lstat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an invalid file untouched and returns its text for editing", async () => {
    const configPath = path.join(directory, "footer.json");
    const previous = '{"version":1,"enabled":true}\n';
    await writeFile(configPath, previous);

    const loaded = await createFooterConfigStore(configPath).load();

    expect(loaded.config).toStrictEqual(DEFAULT_CONFIG);
    expect(loaded.error).toContain("Invalid");
    expect(loaded.text).toBe(previous);
    await expect(readFile(configPath, "utf-8")).resolves.toBe(previous);
  });

  it("writes through a dotfiles symlink without replacing the link", async () => {
    const targetPath = path.join(directory, "managed", "footer.json");
    const linkPath = path.join(directory, "footer.json");
    await mkdir(path.dirname(targetPath));
    await writeFile(targetPath, "{}\n");
    await symlink(targetPath, linkPath);

    await createFooterConfigStore(linkPath).save(DEFAULT_CONFIG);

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(targetPath, "utf-8")).resolves.toBe(formatFooterConfig(DEFAULT_CONFIG));
  });

  it("creates the parent directory on save", async () => {
    const configPath = path.join(directory, "new", "footer.json");

    await createFooterConfigStore(configPath).save(DEFAULT_CONFIG);

    expect((await createFooterConfigStore(configPath).load()).config).toStrictEqual(DEFAULT_CONFIG);
  });
});

describe(parseFooterConfig, () => {
  const text = (overrides: Partial<FooterConfig>) =>
    JSON.stringify({ ...DEFAULT_CONFIG, ...overrides });

  it("round-trips the default", () => {
    expect(parseFooterConfig(formatFooterConfig(DEFAULT_CONFIG))).toStrictEqual(DEFAULT_CONFIG);
  });

  it("accepts any number of rows", () => {
    for (const rows of [[], Array.from({ length: 4 }, () => ({ left: [], right: [] }))]) {
      expect(parseFooterConfig(text({ rows })).rows).toStrictEqual(rows);
    }
  });

  it("accepts built-ins in the border", () => {
    const border = ["footer.session", "status:vim"];

    expect(parseFooterConfig(text({ border })).border).toStrictEqual(border);
  });

  it.each([
    ["the previous shape", JSON.stringify({ ...DEFAULT_CONFIG, version: 1 }), "additional"],
    [
      "a center group",
      '{"iconFamily":"ascii","rows":[{"left":[],"center":[],"right":[]}],"border":[],"hidden":[]}',
      "additional",
    ],
    ["a control character", text({ hidden: ["status:a\u001B"] }), "/hidden/0"],
    [
      "a duplicate",
      text({ border: ["status:vim"], rows: [{ left: ["status:vim"], right: [] }] }),
      "listed twice",
    ],
    [
      "a hidden status placed in a row",
      text({ hidden: ["status:usage"] }),
      "status:usage is listed twice",
    ],
    [
      "hiding the status aggregate",
      text({ hidden: ["footer.statuses"], rows: [{ left: ["footer.cwd"], right: [] }] }),
      "hidden accepts only status:<key> IDs",
    ],
    [
      "the status aggregate in the border",
      text({ border: ["footer.statuses"], rows: [{ left: ["footer.cwd"], right: [] }] }),
      "footer.statuses can only be placed in a row",
    ],
  ])("rejects %s", (_name, source, message) => {
    expect(() => parseFooterConfig(source)).toThrow(message);
  });
});
