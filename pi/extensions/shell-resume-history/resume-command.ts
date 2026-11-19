import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

export const INBOX_ENV = "PI_SHELL_RESUME_HISTORY_DIR";

export const enqueueResumeHistory = async (
  inbox: string,
  sessionFile: string
): Promise<void> => {
  const name = `${Date.now()}-${randomUUID()}.session-path`;
  const finalPath = path.join(inbox, name);
  const temporaryPath = path.join(inbox, `.${name}.tmp`);

  await writeFile(temporaryPath, `${sessionFile}\0`, {
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

  const sessionFile = ctx.sessionManager.getSessionFile();

  if (sessionFile === undefined || !existsSync(sessionFile)) {
    return;
  }

  await enqueueResumeHistory(inbox, path.resolve(sessionFile)).catch(
    (): undefined => undefined
  );
};
