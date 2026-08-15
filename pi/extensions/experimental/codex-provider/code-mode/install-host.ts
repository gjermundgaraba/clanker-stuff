/* oxlint-disable eslint/no-use-before-define, eslint/no-await-in-loop -- lock polling and cleanup are deliberately sequential */
// Adapted from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  codeModeHostBinaryName,
  hostAssetUrl,
  resolveCodeModeHostAsset,
} from "./host-assets.ts";

const DOWNLOAD_TIMEOUT_MS = 120_000;
const INSTALL_LOCK_POLL_MS = 200;
const INSTALL_LOCK_TIMEOUT_MS = 125_000;
const INSTALL_LOCK_STALE_MS = 180_000;

export interface InstallCodeModeHostOptions {
  arch: string;
  destination: string;
  platform: string;
  signal?: AbortSignal;
}

export const installCodeModeHost = async ({
  arch,
  destination: destinationInput,
  platform,
  signal,
}: InstallCodeModeHostOptions): Promise<void> => {
  const [assetName, expectedSha256] = resolveCodeModeHostAsset(platform, arch);
  const binaryName = codeModeHostBinaryName(platform);
  const destination = path.resolve(destinationInput);
  if (path.basename(destination) !== binaryName) {
    throw new Error(`Code-mode host destination must end with ${binaryName}`);
  }
  if (existsSync(destination)) {
    return;
  }
  mkdirSync(path.resolve(destination, ".."), { recursive: true });
  const lockPath = `${destination}.lock`;
  if (!(await acquireInstallLock(lockPath, destination, signal))) {
    return;
  }

  let temporary: string | undefined;
  const staged = `${destination}.${process.pid}.tmp`;
  try {
    temporary = mkdtempSync(
      path.join(tmpdir(), "pi-codex-provider-code-mode-")
    );
    const url = hostAssetUrl(assetName);
    let bytes: Buffer;
    try {
      const timeout = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
      const response = await fetch(url, {
        redirect: "follow",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) {
        throw new Error(
          `download failed: ${response.status} ${response.statusText}`
        );
      }
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error: unknown) {
      throw new Error(
        `Failed to download ${url}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
    const actualSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualSha256 !== expectedSha256) {
      throw new Error(`Checksum mismatch for ${assetName}`);
    }

    if (platform === "win32") {
      writeFileSync(staged, bytes);
    } else {
      const archive = path.join(temporary, path.basename(assetName));
      const extracted = path.join(temporary, "extracted");
      writeFileSync(archive, bytes);
      mkdirSync(extracted);
      const result = spawnSync("tar", ["-xzf", archive, "-C", extracted]);
      signal?.throwIfAborted();
      if (result.status !== 0) {
        throw new Error(
          `Failed to extract code-mode host archive${
            result.stderr?.length ? `: ${result.stderr.toString().trim()}` : ""
          }`
        );
      }
      const candidates = walk(extracted).filter((candidatePath) =>
        path.basename(candidatePath).startsWith("codex-code-mode-host")
      );
      if (candidates.length !== 1) {
        throw new Error(
          `Expected one code-mode host binary, found ${candidates.length}`
        );
      }
      const [candidate] = candidates;
      if (!candidate) {
        throw new Error("Code-mode host binary was not extracted");
      }
      copyFileSync(candidate, staged);
      chmodSync(staged, 0o755);
    }
    renameSync(staged, destination);
  } finally {
    rmSync(staged, { force: true });
    if (temporary !== undefined) {
      rmSync(temporary, { force: true, recursive: true });
    }
    rmSync(lockPath, { force: true, recursive: true });
  }
};

const acquireInstallLock = async (
  lockPath: string,
  destination: string,
  signal: AbortSignal | undefined
): Promise<boolean> => {
  const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (existsSync(destination)) {
      return false;
    }
    try {
      mkdirSync(lockPath);
      return true;
    } catch (error: unknown) {
      if (
        error === null ||
        error === undefined ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > INSTALL_LOCK_STALE_MS) {
          rmSync(lockPath, { force: true, recursive: true });
          continue;
        }
      } catch (statError: unknown) {
        if (
          statError === null ||
          statError === undefined ||
          typeof statError !== "object" ||
          !("code" in statError) ||
          statError.code !== "ENOENT"
        ) {
          throw statError;
        }
      }
      await delay(
        INSTALL_LOCK_POLL_MS,
        undefined,
        signal ? { signal } : undefined
      );
    }
  }
  if (existsSync(destination)) {
    return false;
  }
  throw new Error(
    `Timed out waiting for code-mode host install lock: ${lockPath}`
  );
};

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(entryPath) : [entryPath];
  });
