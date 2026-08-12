import { existsSync } from "node:fs";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";

import { codeModeHostBinaryName, HOST_RELEASE } from "./host-assets.ts";
import { installCodeModeHost } from "./install-host.ts";

export const codeModeHostBinaryPath = (
  platform = process.platform,
  arch = process.arch
) =>
  path.join(
    getExtensionStoragePaths("codex-provider").cacheDir,
    "code-mode",
    HOST_RELEASE,
    `${platform}-${arch}`,
    codeModeHostBinaryName(platform)
  );

export const ensureCodeModeHostBinary = async (signal?: AbortSignal) => {
  const binaryPath = codeModeHostBinaryPath();
  if (!existsSync(binaryPath)) {
    await installCodeModeHost({
      arch: process.arch,
      destination: binaryPath,
      platform: process.platform,
      signal,
    });
  }
  return binaryPath;
};
