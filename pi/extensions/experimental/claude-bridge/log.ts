// Opt-in debug logging. CLAUDE_BRIDGE_DEBUG=1 writes the bridge's own trace and,
// per query, Claude Code's CLI debug log beside it; nothing is written otherwise.
// The log carries prompts and conversation text, so it is never on by default.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";

export const EXTENSION_ID = "claude-bridge";

// Unique per module evaluation: shows whether subagents share module state.
const moduleInstanceId = Math.random().toString(36).slice(2, 8);

export const isDebugEnabled = (): boolean => process.env.CLAUDE_BRIDGE_DEBUG === "1";

const logsDir = (): string => path.join(getExtensionStoragePaths(EXTENSION_ID).dataDir, "logs");

/** Paths resolve per call so tests can swap the environment mid-process. */
export function debugLogPath(): string {
  const override = process.env.CLAUDE_BRIDGE_DEBUG_PATH;

  return override !== undefined && override !== "" ? override : path.join(logsDir(), "debug.log");
}

const format = (value: unknown): string => {
  if (typeof value === "string") return value;

  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack === undefined ? "" : `\n${value.stack}`}`;
  }

  return JSON.stringify(value) ?? String(value);
};

export function debug(...args: unknown[]): void {
  if (!isDebugEnabled()) return;

  const logPath = debugLogPath();

  mkdirSync(path.dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    `[${new Date().toISOString()}] [${moduleInstanceId}] ${args.map(format).join(" ")}\n`,
  );
}

/** Snapshot for a "should never happen" path, kept in the debug log under one greppable tag. */
export function diagDump(
  label: string,
  data: Record<string, string | number | boolean | null>,
): void {
  debug(`DIAG ${label}`, data);
}

export interface CliDebugOptions {
  debug?: boolean;
  debugFile?: string;
  stderr?: (data: string) => void;
}

let nextCliDebugSeq = 1;

/** Claude Code's own debug log for one query, plus its stderr in the bridge trace. Without
 *  it, "No conversation found" and empty-error reports are unactionable. */
export function cliDebugOptions(tag: string): CliDebugOptions {
  if (!isDebugEnabled()) return {};

  const seq = nextCliDebugSeq++;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = path.join(path.dirname(debugLogPath()), "cc-cli");

  mkdirSync(logDir, { recursive: true });

  const debugFile = path.join(logDir, `${stamp}-${tag}-${seq}.log`);

  debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);

  return {
    debug: true,
    debugFile,
    stderr: (data) => {
      for (const line of data.split(/\r?\n/)) {
        if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
      }
    },
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") return error.message;

    if ("error" in error && typeof error.error === "string") return error.error;
  }

  return format(error);
}
