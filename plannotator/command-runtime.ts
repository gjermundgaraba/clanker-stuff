import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { CliProcess, CliStarter } from "./cli.js";
import { processFailure } from "./cli.js";

interface ActiveRun {
  cancelled: boolean;
  process: CliProcess;
  settled: Promise<void>;
}

interface LaunchOptions {
  failureLabel: string;
  onOutput: (stdout: string) => void;
  openedMessage: string;
  stdin?: string;
}

export interface CommandRuntime {
  launch: (
    args: string[],
    ctx: ExtensionCommandContext,
    options: LaunchOptions
  ) => void;
  parseArguments: (
    args: string,
    ctx: ExtensionCommandContext
  ) => string[] | undefined;
  shutdown: () => Promise<void>;
}

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

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const notifyError = (
  ctx: ExtensionCommandContext,
  label: string,
  error: unknown
): void => {
  ctx.ui.notify(`${label}: ${errorMessage(error)}`, "error");
};

export const createCommandRuntime = (startCli: CliStarter): CommandRuntime => {
  const activeRuns = new Set<ActiveRun>();

  const launch = (
    args: string[],
    ctx: ExtensionCommandContext,
    options: LaunchOptions
  ): void => {
    let cliProcess: CliProcess;
    try {
      cliProcess = startCli(args, { cwd: ctx.cwd, stdin: options.stdin });
    } catch (error) {
      notifyError(ctx, options.failureLabel, error);
      return;
    }

    const run: ActiveRun = {
      cancelled: false,
      process: cliProcess,
      settled: Promise.resolve(),
    };
    activeRuns.add(run);

    const settleRun = async (): Promise<void> => {
      try {
        const completion = await cliProcess.completion;
        if (run.cancelled || completion.kind === "cancelled") {
          return;
        }
        if (completion.kind === "signaled") {
          throw new Error(`terminated by ${completion.signal}`);
        }
        if (completion.code !== 0) {
          throw processFailure(completion);
        }
        options.onOutput(completion.stdout);
      } catch (error) {
        if (!run.cancelled) {
          notifyError(ctx, options.failureLabel, error);
        }
      } finally {
        activeRuns.delete(run);
      }
    };
    run.settled = settleRun();

    ctx.ui.notify(options.openedMessage, "info");
  };

  const parseArguments = (
    args: string,
    ctx: ExtensionCommandContext
  ): string[] | undefined => {
    try {
      return tokenizeArguments(args);
    } catch (error) {
      notifyError(ctx, "Invalid Plannotator arguments", error);
      return undefined;
    }
  };

  const shutdown = async (): Promise<void> => {
    const runs = [...activeRuns];
    for (const run of runs) {
      run.cancelled = true;
      try {
        run.process.cancel();
      } catch {
        // Completion handling below owns process cleanup errors.
      }
    }
    await Promise.allSettled(runs.map((run) => run.settled));
  };

  return { launch, parseArguments, shutdown };
};
