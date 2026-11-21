import { spawn } from "node:child_process";
import { once } from "node:events";

export interface CheckInput {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMs: number;
}

/** `exitCode` is null when the shell could not start or was killed. */
export interface CheckOutcome {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

/**
 * Runs a condition with `/bin/sh -c` in its own process group, output
 * discarded. Abort and timeout kill the whole group, or the shell when the
 * group cannot be signalled (macOS refuses a group of zombies with EPERM).
 * Killing never throws: it runs from timer and abort callbacks.
 */
export const runCondition = async (
  input: CheckInput,
  signal: AbortSignal
): Promise<CheckOutcome> => {
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

    return { exitCode: timedOut ? null : child.exitCode, timedOut };
  } catch {
    return { exitCode: null, timedOut };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", killGroupOrShell);
  }
};
