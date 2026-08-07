import { existsSync } from "node:fs";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { codeModeHostBinaryName, HOST_RELEASE } from "./host-assets.js";
import { installCodeModeHost } from "./install-host.js";

export const codeModeHostBinaryPath = (
  platform = process.platform,
  arch = process.arch
) =>
  path.join(
    getAgentDir(),
    "cache",
    "clanker-tools",
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
