import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";

const EXTENSION_ID = "claude-bridge";

const moduleInstanceId = Math.random().toString(36).slice(2, 8);

const isDebugEnabled = (): boolean =>
  process.env["CLAUDE_BRIDGE_DEBUG"] === "1";

/** Paths resolve per call so tests can swap the environment mid-process. */
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

const format = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack === undefined ? "" : `\n${value.stack}`}`;
  }

  return JSON.stringify(value) ?? String(value);
};

/** Best effort, including formatting data used only for diagnostics. */
export const debugLines = (formatLines: () => readonly string[]): void => {
  if (!isDebugEnabled()) {
    return;
  }

  try {
    const lines = formatLines();

    if (lines.length === 0) {
      return;
    }

    const logPath = debugLogPath();
    const prefix = `[${new Date().toISOString()}] [${moduleInstanceId}] `;

    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, lines.map((line) => `${prefix}${line}\n`).join(""));
  } catch {
    return;
  }
};

export const debug = (...args: unknown[]): void => {
  debugLines(() => [args.map(format).join(" ")]);
};

type CliDebugOptions = Pick<Options, "debug" | "debugFile" | "stderr">;

let nextCliDebugSeq = 1;

/** Claude Code's own debug log for one query, plus its stderr in the bridge trace.
 *  If we cannot create the log file, run the query without SDK diagnostics. */
export const cliDebugOptions = (tag: string): CliDebugOptions => {
  if (!isDebugEnabled()) {
    return {};
  }

  try {
    const seq = nextCliDebugSeq;
    nextCliDebugSeq += 1;
    const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
    const logDir = path.resolve(path.dirname(debugLogPath()), "cc-cli");
    const debugFile = path.join(logDir, `${stamp}-${tag}-${seq}.log`);

    mkdirSync(logDir, { recursive: true });
    writeFileSync(debugFile, "", { flag: "wx" });

    debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);

    return {
      debug: true,
      debugFile,
      stderr: (data) => {
        debugLines(() =>
          data
            .split(/\r?\n/u)
            .flatMap((line) =>
              line === "" ? [] : [`[cli-stderr ${tag}#${seq}] ${line}`]
            )
        );
      },
    };
  } catch {
    return {};
  }
};

/** Failure text for Pi, even when a backend or hook throws an unserializable value. */
export const errorMessage = (error: unknown): string => {
  try {
    if (typeof error === "object" && error !== null) {
      const message = "message" in error ? error.message : undefined;

      if (typeof message === "string") {
        return message;
      }

      const text = "error" in error ? error.error : undefined;

      if (typeof text === "string") {
        return text;
      }
    }

    return format(error);
  } catch {
    return "Claude bridge failed without a readable error message";
  }
};
