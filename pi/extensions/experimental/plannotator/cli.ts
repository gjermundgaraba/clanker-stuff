import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface CliCompletion {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
}

export interface CliStartOptions {
  cwd: string;
  onStderrLine: (line: string) => void;
  signal: AbortSignal;
  stdin?: string | undefined;
}

export type CliStarter = (
  args: string[],
  options: CliStartOptions
) => Promise<CliCompletion>;

/**
 * Async because `spawn` throws synchronously for some arguments, such as one with a null byte; this
 * way those failures reject like any other failed start.
 */
export const startPlannotatorCli: CliStarter = async (args, options) => {
  const child = spawn("plannotator", args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      PLANNOTATOR_CWD: options.cwd,
      PLANNOTATOR_ORIGIN: "pi",
    },
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  createInterface({ crlfDelay: Infinity, input: child.stderr }).on(
    "line",
    options.onStderrLine
  );

  const {
    promise: completion,
    reject,
    resolve,
  } = Promise.withResolvers<CliCompletion>();

  child.once("error", (error) => {
    if (error.name !== "AbortError") {
      reject(error);
    }
  });
  child.stdin.once("error", reject);
  child.once("spawn", () => {
    child.stdin.end(options.stdin);
  });
  child.once("close", (code, signal) => {
    resolve({ code, signal, stdout });
  });

  return await completion;
};
