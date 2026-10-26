import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const PUBLISH_PACKAGES_PATH = path.join(import.meta.dirname, "publish-packages.ts");

const tempDirs: string[] = [];

describe("package publication", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it.each([
    {
      names: ["@clanker-stuff/pi-tones", "@clanker-stuff/pi-tones"],
      message: "Duplicate package in publish list: @clanker-stuff/pi-tones",
    },
    {
      names: ["first", "second", "second", "first", "second"],
      message: "Duplicate packages in publish list: second, first",
    },
  ])("rejects duplicates before invoking pnpm: $names", async ({ names, message }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "publish-packages-"));
    tempDirs.push(directory);
    const marker = path.join(directory, "pnpm-called");
    const pnpm = path.join(directory, "pnpm");
    await writeFile(pnpm, `#!/bin/sh\nprintf called > "${marker}"\n`, "utf-8");
    await chmod(pnpm, 0o755);

    const result = spawnSync(process.execPath, [PUBLISH_PACKAGES_PATH, ...names, "--dry-run"], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: `${directory}${path.delimiter}${process.env["PATH"] ?? ""}`,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    await expect(readFile(marker, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
