import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

export const INBOX_ENV = "PI_SHELL_RESUME_HISTORY_DIR";

const quoteShellArgument = (value: string): string => {
  if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
};

export const getDefaultSessionDirectory = (cwd: string): string => {
  const resolvedCwd = path.resolve(cwd);
  const safePath = `--${resolvedCwd
    .replace(/^[/\\]/u, "")
    .replaceAll(/[/\\:]/gu, "-")}--`;
  return path.join(path.resolve(getAgentDir()), "sessions", safePath);
};

export interface ResumeCommandSession {
  cwd: string;
  sessionDir: string;
  sessionFile: string | undefined;
  sessionId: string;
}

export const formatResumeCommand = ({
  cwd,
  sessionDir,
  sessionFile,
  sessionId,
}: ResumeCommandSession): string | undefined => {
  if (!sessionFile || !existsSync(sessionFile)) {
    return undefined;
  }

  const args = ["pi"];
  if (path.resolve(sessionDir) !== getDefaultSessionDirectory(cwd)) {
    args.push("--session-dir", quoteShellArgument(sessionDir));
  }
  args.push("--session", quoteShellArgument(sessionId));
  return args.join(" ");
};

export const enqueueResumeCommand = async (
  command: string,
  inbox = process.env[INBOX_ENV]
): Promise<void> => {
  if (!inbox) {
    return;
  }

  const name = `${Date.now()}-${process.pid}-${randomUUID()}.command`;
  const finalPath = path.join(inbox, name);
  const temporaryPath = path.join(inbox, `.${name}.tmp`);

  await writeFile(temporaryPath, `${command}\n`, {
    encoding: "utf-8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
};

export const recordResumeCommand = async (
  reason: SessionShutdownEvent["reason"],
  ctx: ExtensionContext
): Promise<void> => {
  if (reason !== "quit" || ctx.mode !== "tui") {
    return;
  }

  const { sessionManager } = ctx;
  const command = formatResumeCommand({
    cwd: ctx.cwd,
    sessionDir: sessionManager.getSessionDir(),
    sessionFile: sessionManager.getSessionFile(),
    sessionId: sessionManager.getSessionId(),
  });
  if (!command) {
    return;
  }

  try {
    await enqueueResumeCommand(command);
  } catch {
    // History integration must never block pi from shutting down.
  }
};
