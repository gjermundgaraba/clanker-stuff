import { spawn } from "node:child_process";
import { once } from "node:events";

export interface CheckInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}

/** The condition's exit code, or "timeout" when its check ran out of time. */
export type CheckResult = number | "timeout";

/**
 * Runs a condition with `/bin/sh -c` in its own process group, output
 * discarded. Abort and timeout kill the whole group, or the shell when the
 * group cannot be signalled (macOS refuses a group of zombies with EPERM).
 * Rejects when the shell cannot start or something else kills it.
 */
export const runCondition = async (
  input: CheckInput,
  signal: AbortSignal
): Promise<CheckResult> => {
  const child = spawn("/bin/sh", ["-c", input.command], {
    cwd: input.cwd,
    detached: true,
    stdio: "ignore",
  });

  let timedOut = false;

  const killGroupOrShell = (): void => {
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      return;
    }

    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killGroupOrShell();
  }, input.timeoutMs);

  signal.addEventListener("abort", killGroupOrShell, { once: true });

  try {
    await once(child, "close");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", killGroupOrShell);
  }

  if (timedOut) {
    return "timeout";
  }

  if (child.exitCode === null) {
    throw new Error("The condition's shell was killed by a signal");
  }

  return child.exitCode;
};
