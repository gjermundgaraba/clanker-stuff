import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

describe("fast package", () => {
  it("packs the documented assets and loads its production command", async () => {
    const root = mkdtempSync(path.join(PACKAGE_ROOT, ".package-smoke-"));

    try {
      const tarball = path.join(root, "fast.tgz");
      execFileSync("pnpm", ["pack", "--out", tarball], { cwd: PACKAGE_ROOT, stdio: "pipe" });

      const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
        .trim()
        .split("\n");

      expect(entries).toContain("package/docs/behavior.md");
      expect(entries).not.toContain("package/docs/verification.md");
      expect(entries.some((entry) => entry.startsWith("package/scripts/"))).toBe(false);
      expect(entries.some((entry) => entry.startsWith("package/tests/"))).toBe(false);
      const extracted = path.join(root, "extracted");
      mkdirSync(extracted);
      execFileSync("tar", ["-xzf", tarball, "-C", extracted]);

      const loader = new DefaultResourceLoader({
        agentDir: path.join(root, "agent"),
        cwd: root,
        noSkills: true,
        noThemes: true,
        settingsManager: SettingsManager.inMemory({ packages: [path.join(extracted, "package")] }),
      });

      await loader.reload();
      const loaded = loader.getExtensions();
      expect(loaded.errors).toStrictEqual([]);
      expect(loaded.extensions).toHaveLength(1);
      expect(loaded.extensions[0]?.commands.has("fast")).toBe(true);
      expect(loaded.extensions[0]?.flags.has("fast")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
