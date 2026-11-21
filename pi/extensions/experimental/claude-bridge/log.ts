import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";

const EXTENSION_ID = "claude-bridge";

const moduleInstanceId = Math.random().toString(36).slice(2, 8);

const isDebugEnabled = (): boolean =>
  process.env["CLAUDE_BRIDGE_DEBUG"] === "1";

export const debugLogPath = (): string => {
  const override = process.env["CLAUDE_BRIDGE_DEBUG_PATH"];

  return override !== undefined && override !== ""
    ? override
    : path.join(
        getExtensionStoragePaths(EXTENSION_ID).dataDir,
        "logs",
        "debug.log"
      );
};

const formatInFull = (value: unknown): string =>
  typeof value === "string"
    ? value
    : inspect(value, {
        breakLength: Number.POSITIVE_INFINITY,
        compact: true,
        depth: Number.POSITIVE_INFINITY,
        maxArrayLength: Number.POSITIVE_INFINITY,
        maxStringLength: Number.POSITIVE_INFINITY,
      });

/** Best effort: a trace that cannot be formatted or written never fails the request. */
export const debug = (...args: unknown[]): void => {
  if (!isDebugEnabled()) {
    return;
  }

  try {
    const logPath = debugLogPath();
    const prefix = `[${new Date().toISOString()}] [${moduleInstanceId}] `;
    const lines = args.map(formatInFull).join(" ").split("\n");

    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, lines.map((line) => `${prefix}${line}\n`).join(""));
  } catch {
    return;
  }
};

type CliDebugOptions = Pick<Options, "debug" | "debugFile" | "stderr">;

let nextCliDebugSeq = 1;

/** Claude Code's own debug log for one query, plus its stderr in the bridge trace. Without
 *  it, "No conversation found" and empty-error reports are unactionable. If the log
 *  directory cannot be created, the query runs without SDK diagnostics. */
export const cliDebugOptions = (tag: string): CliDebugOptions => {
  if (!isDebugEnabled()) {
    return {};
  }

  const seq = nextCliDebugSeq;
  nextCliDebugSeq += 1;
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const logDir = path.resolve(path.dirname(debugLogPath()), "cc-cli");

  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    return {};
  }

  const debugFile = path.join(
    logDir,
    `${stamp}-${moduleInstanceId}-${tag}-${seq}.log`
  );

  debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);

  return {
    debug: true,
    debugFile,
    stderr: (data) => {
      for (const line of data.split(/\r?\n/u)) {
        if (line) {
          debug(`[cli-stderr ${tag}#${seq}] ${line}`);
        }
      }
    },
  };
};

export const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") {
      return error.message;
    }

    if ("error" in error && typeof error.error === "string") {
      return error.error;
    }
  }

  return formatInFull(error);
};
