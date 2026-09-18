import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const MAX_BYTES = 1024 * 1024;

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const NOTICE = Buffer.from("\n\n[MCP persisted output truncated]\n");

export const createOutputStore = () => {
  let cleanup: Promise<void> | undefined;

  const prune = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
      const file = path.join(directory, entry.name);
      await withFileMutationQueue(file, async () => {
        const metadata = await stat(file);

        if (metadata.mtimeMs < Date.now() - MAX_AGE_MS) await rm(file, { force: true });
      }).catch(() => {
        /* Expiry is best-effort; another process may have removed the file. */
      });
    }
  };

  return async (text: string): Promise<string> => {
    const directory = path.resolve(getExtensionStoragePaths("mcp").dataDir, "results");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await (cleanup ??= prune(directory).catch(() => {
      /* Cleanup never determines tool success. */
    }));
    const file = path.join(directory, `${randomUUID()}.txt`);
    const bytes = Buffer.from(text);
    let output = bytes;

    if (bytes.length > MAX_BYTES) {
      let end = MAX_BYTES - NOTICE.length;

      while ((bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1;
      output = Buffer.concat([bytes.subarray(0, end), NOTICE]);
    }

    await withFileMutationQueue(file, () => writeFile(file, output, { mode: 0o600, flag: "wx" }));

    return file;
  };
};
