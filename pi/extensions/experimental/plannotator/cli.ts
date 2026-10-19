import { spawn } from "node:child_process";

export type CliCompletion =
  | {
      code: number;
      kind: "exited";
      stdout: string;
    }
  | { kind: "signaled"; signal: NodeJS.Signals };

export interface CliStartOptions {
  cwd: string;
  onStderr: (chunk: string) => void;
  signal: AbortSignal;
  stdin?: string | undefined;
}

export type CliStarter = (args: string[], options: CliStartOptions) => Promise<CliCompletion>;

export const startPlannotatorCli: CliStarter = (args, options) => {
  const child = spawn("plannotator", args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      PLANNOTATOR_CWD: options.cwd,
      PLANNOTATOR_ORIGIN: "pi",
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");

  let stdout = "";
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const terminate = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }

    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Cancellation is best-effort and must not throw.
        }
      }
    }, 1000);
    killTimer.unref();
  };

  options.signal.addEventListener("abort", terminate, { once: true });

  const { promise: completion, reject, resolve } = Promise.withResolvers<CliCompletion>();
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", options.onStderr);
  child.once("error", reject);
  child.stdin.once("error", reject);
  child.once("spawn", () => {
    child.stdin.end(options.stdin);
  });
  child.once("close", (code, signal) => {
    options.signal.removeEventListener("abort", terminate);
    clearTimeout(killTimer);

    if (code !== null) {
      resolve({ code, kind: "exited", stdout });

      return;
    }

    if (signal) {
      resolve({ kind: "signaled", signal });

      return;
    }

    reject(new Error("plannotator closed without an exit code or signal"));
  });

  return completion;
};
