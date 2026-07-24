import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { CliProcess, CliStarter } from "./cli.js";
import { processFailure, tokenizeArguments } from "./cli.js";

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
