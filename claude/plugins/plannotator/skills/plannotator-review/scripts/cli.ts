import { spawn } from "node:child_process";

export type CliCompletion =
  | {
      code: number;
      kind: "exited";
      stderr: string;
      stdout: string;
    }
  | { kind: "cancelled" }
  | { kind: "signaled"; signal: NodeJS.Signals };

export interface CliProcess {
  cancel: () => void;
  completion: Promise<CliCompletion>;
  readonly signal: AbortSignal;
}

export interface CliStartOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onStderr?: (chunk: string) => void;
  stdin?: string;
}

export type CliStarter = (
  args: string[],
  options: CliStartOptions
) => CliProcess;

export const processFailure = (
  completion: Extract<CliCompletion, { kind: "exited" }>
): Error => {
  const detail =
    completion.stderr.trim() ||
    completion.stdout.trim() ||
    `exited with code ${completion.code}`;
  return new Error(detail);
};

export const startCli = (
  executable: string,
  args: string[],
  options: CliStartOptions
): CliProcess => {
  const child = spawn(executable, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf-8");
  child.stderr.setEncoding("utf-8");

  const controller = new AbortController();
  let stdout = "";
  let stderr = "";
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
  controller.signal.addEventListener("abort", terminate, { once: true });

  const {
    promise: completion,
    reject,
    resolve,
  } = Promise.withResolvers<CliCompletion>();
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    options.onStderr?.(chunk);
  });
  child.once("error", reject);
  child.stdin.once("error", reject);
  child.once("spawn", () => {
    child.stdin.end(options.stdin);
  });
  child.once("close", (code, signal) => {
    controller.signal.removeEventListener("abort", terminate);
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
    if (controller.signal.aborted) {
      resolve({ kind: "cancelled" });
      return;
    }
    if (code !== null) {
      resolve({ code, kind: "exited", stderr, stdout });
      return;
    }
    if (signal) {
      resolve({ kind: "signaled", signal });
      return;
    }
    reject(new Error(`${executable} closed without an exit code or signal`));
  });

  return {
    cancel() {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    },
    completion,
    signal: controller.signal,
  };
};
