import { readFile, readdir, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createOutputStore } from "../results.js";
import { setupMcpTest } from "./helpers.js";

describe("MCP overflow storage", () => {
  setupMcpTest();
  it("caps files without breaking UTF-8 and keeps parallel results available", async () => {
    const persist = createOutputStore();
    const paths = await Promise.all(
      Array.from({ length: 12 }, () => persist("😀".repeat(300_000))),
    );
    for (const file of paths) {
      const metadata = await stat(file);
      expect(metadata.size).toBeLessThanOrEqual(1024 * 1024);
      if (process.platform !== "win32") expect(metadata.mode & 0o777).toBe(0o600);
      const text = await readFile(file, "utf-8");
      expect(text).not.toContain("�");
      expect(text).toContain("[MCP persisted output truncated]");
    }
  });
  it("expires old output on first use without removing recent output", async () => {
    const persist = createOutputStore();
    const old = await persist("old");
    const recent = await persist("recent");
    await utimes(old, new Date(0), new Date(0));
    const latest = await createOutputStore()("latest");
    const names = await readdir(path.dirname(latest));
    expect(names).not.toContain(path.basename(old));
    expect(names).toContain(path.basename(recent));
    expect(names).toContain(path.basename(latest));
  });
});
