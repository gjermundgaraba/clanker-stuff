import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

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

export interface ResumeCommandSession {
  sessionFile: string | undefined;
}

export const formatResumeCommand = ({
  sessionFile,
}: ResumeCommandSession): string | undefined => {
  if (
    sessionFile === undefined ||
    sessionFile.length === 0 ||
    !existsSync(sessionFile)
  ) {
    return undefined;
  }

  return `pi --session ${quoteShellArgument(path.resolve(sessionFile))}`;
};

export const enqueueResumeCommand = async (
  command: string,
  inbox = process.env[INBOX_ENV]
): Promise<void> => {
  if (inbox === undefined || inbox.length === 0) {
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
    sessionFile: sessionManager.getSessionFile(),
  });
  if (command === undefined) {
    return;
  }

  try {
    await enqueueResumeCommand(command);
  } catch {
    // History integration must never block pi from shutting down.
  }
};
