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
}

export interface CliStartOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
}

export type CliStarter = (
  args: string[],
  options: CliStartOptions
) => CliProcess;

export const tokenizeArguments = (input: string): string[] => {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let started = false;

  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      started = true;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      started = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }

    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += character;
    started = true;
  }

  if (escaping) {
    throw new Error("Arguments end with an incomplete escape");
  }
  if (quote) {
    throw new Error(`Arguments contain an unterminated ${quote} quote`);
  }
  if (started) {
    tokens.push(current);
  }

  return tokens;
};

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

  let cancelled = false;
  let stdout = "";
  let stderr = "";

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
  });
  child.once("error", reject);
  child.stdin.once("error", reject);
  child.once("spawn", () => {
    child.stdin.end(options.stdin);
  });
  child.once("close", (code, signal) => {
    if (cancelled) {
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
      cancelled = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    },
    completion,
  };
};
