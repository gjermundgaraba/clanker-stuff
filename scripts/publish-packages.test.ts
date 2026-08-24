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

  it("rejects duplicate packages before invoking pnpm", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "publish-packages-"));
    tempDirs.push(directory);
    const marker = path.join(directory, "pnpm-called");
    const pnpm = path.join(directory, "pnpm");
    await writeFile(pnpm, `#!/bin/sh\nprintf called > "${marker}"\n`, "utf-8");
    await chmod(pnpm, 0o755);

    const result = spawnSync(
      process.execPath,
      [
        PUBLISH_PACKAGES_PATH,
        "@clanker-stuff/footer-protocol",
        "@clanker-stuff/footer-protocol",
        "--dry-run",
      ],
      {
        cwd: path.join(import.meta.dirname, ".."),
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${directory}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Duplicate package in publish list: @clanker-stuff/footer-protocol",
    );
    await expect(readFile(marker, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
