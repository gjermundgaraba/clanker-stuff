import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { DEFAULT_CONFIG } from "@clanker-stuff/footer-protocol/config";
import { createFooterConfigStore } from "../config.js";

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

  it("saves through a symlinked config without replacing the link", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "footer-config-"));
    const targetPath = path.join(directory, "managed", "footer.json");
    const linkPath = path.join(directory, "footer.json");
    await mkdir(path.dirname(targetPath));
    await writeFile(targetPath, "{}\n");
    await symlink(targetPath, linkPath);

    await createFooterConfigStore(linkPath).save(DEFAULT_CONFIG);

    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(targetPath, "utf-8"))).toStrictEqual(DEFAULT_CONFIG);
  });

  it("relies on Pi serializing existing symlink and target aliases in one mutation queue", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "footer-config-"));
    const targetPath = path.join(directory, "target.json");
    const linkPath = path.join(directory, "footer.json");
    await writeFile(targetPath, "{}");
    await symlink(targetPath, linkPath);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const order: string[] = [];

    const target = withFileMutationQueue(targetPath, async () => {
      entered.resolve();
      await release.promise;
      order.push("target");
    });

    await entered.promise;

    const alias = withFileMutationQueue(linkPath, async () => {
      order.push("alias");
    });

    try {
      // Pi registers queue keys in order; an unrelated queue is a deterministic barrier.
      await withFileMutationQueue(path.join(directory, "unrelated"), async () => {
        expect(order).toStrictEqual([]);
      });
    } finally {
      release.resolve();
      await Promise.all([target, alias]);
    }

    expect(order).toStrictEqual(["target", "alias"]);
  });

  it("creates a missing config and its parent directory", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "footer-config-"));
    const configPath = path.join(directory, "new", "footer.json");
    await createFooterConfigStore(configPath).save(DEFAULT_CONFIG);
    expect(JSON.parse(await readFile(configPath, "utf-8"))).toStrictEqual(DEFAULT_CONFIG);
  });

  it("rejects a dangling relative symlink without replacing it or creating its target", async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "footer-config-"));
    const linkPath = path.join(directory, "footer.json");
    const destination = "missing/footer.json";
    await symlink(destination, linkPath);

    await expect(createFooterConfigStore(linkPath).save(DEFAULT_CONFIG)).rejects.toThrow(
      "dangling symlink",
    );
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(linkPath)).toBe(destination);
    await expect(lstat(path.join(directory, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses an absolute mutation-queue key", () => {
    expect(createFooterConfigStore("relative/footer.json").path).toBe(
      path.resolve("relative/footer.json"),
    );
  });
});

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
