import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
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

/** Pi opens a session file in the session's own working directory, from any shell directory. */
export const formatResumeCommand = (
  sessionManager: ExtensionContext["sessionManager"]
): string | undefined => {
  const sessionFile = sessionManager.getSessionFile();

  // Pi creates the file with the first user message; until then there is nothing to resume.
  if (sessionFile === undefined || !existsSync(sessionFile)) {
    return undefined;
  }

  return `pi --session ${quoteShellArgument(path.resolve(sessionFile))}`;
};

export const enqueueResumeCommand = async (
  inbox: string,
  command: string
): Promise<void> => {
  const name = `${Date.now()}-${randomUUID()}.command`;
  const finalPath = path.join(inbox, name);
  const temporaryPath = path.join(inbox, `.${name}.tmp`);

  await writeFile(temporaryPath, `${command}\n`, {
    encoding: "utf-8",
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporaryPath, finalPath);
};

export const recordResumeCommand = async (
  reason: SessionShutdownEvent["reason"],
  ctx: ExtensionContext
): Promise<void> => {
  const inbox = process.env[INBOX_ENV];

  if (
    reason !== "quit" ||
    ctx.mode !== "tui" ||
    inbox === undefined ||
    inbox.length === 0
  ) {
    return;
  }

  const command = formatResumeCommand(ctx.sessionManager);

  if (command === undefined) {
    return;
  }

  try {
    await enqueueResumeCommand(inbox, command);
  } catch {
    // History integration must never block pi from shutting down.
  }
};
