import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DefaultResourceLoader, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";

const TARGET_PATH = realpathSync(path.join(import.meta.dirname, "index.ts"));
const SUPPORTED_PI_VERSION = "0.84.2";

export interface LocalOrderAuditResult {
  readonly count: number;
  readonly extensions: readonly {
    readonly path: string;
  }[];
  readonly finalPath: string;
  readonly piVersion: string;
  readonly sdkVersion: string;
}

export const auditLocalOrder = async (options?: {
  readonly agentDir?: string;
  readonly cwd?: string;
  readonly piVersion?: string;
}): Promise<LocalOrderAuditResult> => {
  if (VERSION !== SUPPORTED_PI_VERSION) {
    throw new Error(`Unsupported audit SDK version ${VERSION}; expected ${SUPPORTED_PI_VERSION}`);
  }
  const piVersion =
    options?.piVersion ?? execFileSync("pi", ["--version"], { encoding: "utf-8" }).trim();
  if (piVersion !== SUPPORTED_PI_VERSION) {
    throw new Error(
      `Unsupported Pi executable version ${piVersion}; expected ${SUPPORTED_PI_VERSION}`,
    );
  }
  const cwd = path.resolve(options?.cwd ?? process.cwd());
  const agentDir = path.resolve(
    options?.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  );
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: true,
  });
  const loader = new DefaultResourceLoader({
    agentDir,
    cwd,
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
  });

  const resolveExtensions = async () => {
    await loader.reload();
    const result = loader.getExtensions();
    if (result.errors.length > 0) {
      throw new Error(
        `Extension loading diagnostics:\n${result.errors
          .map(({ error, path: diagnosticPath }) => `${diagnosticPath}: ${error}`)
          .join("\n")}`,
      );
    }
    return result.extensions.map((extension) => ({
      path: realpathSync(extension.resolvedPath),
    }));
  };

  const extensions = await resolveExtensions();
  const reloaded = await resolveExtensions();
  if (
    JSON.stringify(extensions.map(({ path: extensionPath }) => extensionPath)) !==
    JSON.stringify(reloaded.map(({ path: extensionPath }) => extensionPath))
  ) {
    throw new Error("Resolved extension order changed after reload");
  }
  const targetCount = extensions.filter(
    ({ path: extensionPath }) => extensionPath === TARGET_PATH,
  ).length;
  const finalPath = extensions.at(-1)?.path;
  if (targetCount !== 1 || finalPath !== TARGET_PATH) {
    throw new Error(
      `Expected ${TARGET_PATH} exactly once and last; resolved ${targetCount} occurrence(s), final path ${finalPath ?? "(none)"}`,
    );
  }
  return {
    count: extensions.length,
    extensions,
    finalPath,
    piVersion,
    sdkVersion: VERSION,
  };
};

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    const result = await auditLocalOrder({ cwd: process.argv[2] });
    console.log(`Pi version: ${result.piVersion}`);
    console.log(`Audit SDK version: ${result.sdkVersion}`);
    console.log(`Resolved ${result.count} extensions`);
    console.log(`Final extension: ${result.finalPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
