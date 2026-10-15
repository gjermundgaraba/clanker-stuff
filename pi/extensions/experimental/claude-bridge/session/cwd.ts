// Pi session id → cwd. In the pi CLI process.cwd() is the session's cwd, but a host
// serving many sessions from one process (pi-web) has a single process cwd, so Claude
// Code would run in, and load project instructions from, the host's directory.

import { shared } from "../shared.js";

export function rememberSessionCwd(sessionId: string, cwd: string): void {
  shared().sessionCwds.set(sessionId, cwd);
}

export function forgetSessionCwd(sessionId: string): void {
  shared().sessionCwds.delete(sessionId);
}

export function sessionCwdFor(sessionId: string | null | undefined): string {
  return (sessionId == null ? undefined : shared().sessionCwds.get(sessionId)) ?? process.cwd();
}
