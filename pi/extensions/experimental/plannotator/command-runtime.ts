import { setTimeout as delay } from "node:timers/promises";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { CliCompletion, CliStarter } from "./cli.js";
import { startPlannotatorCli } from "./cli.js";

const SHUTDOWN_TIMEOUT_MS = 2500;

interface LaunchOptions {
  failureLabel: string;
  onOutput: (stdout: string) => void;
  openedMessage: string;
  stdin?: string;
}

export interface CommandRuntime {
  launch: (args: string[], ctx: ExtensionCommandContext, options: LaunchOptions) => void;
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

const notifyError = (ctx: ExtensionCommandContext, label: string, cause: unknown): void => {
  const message = cause instanceof Error ? cause.message : String(cause);
  ctx.ui.notify(`${label}: ${message}`, "error");
};

export const parseArguments = (
  args: string,
  ctx: ExtensionCommandContext,
): string[] | undefined => {
  try {
    return tokenizeArguments(args);
  } catch (error) {
    notifyError(ctx, "Invalid Plannotator arguments", error);

    return undefined;
  }
};

export const createCommandRuntime = (starter: CliStarter = startPlannotatorCli): CommandRuntime => {
  const activeRuns = new Map<AbortController, Promise<void>>();

  const launch = (args: string[], ctx: ExtensionCommandContext, options: LaunchOptions): void => {
    let pendingStderr = "";

    const notifyLines = (lines: string[]): void => {
      for (const line of lines) {
        const message = line.trim();

        if (message !== "") {
          ctx.ui.notify(message, "info");
        }
      }
    };

    const streamStderr = (chunk: string): void => {
      const lines = (pendingStderr + chunk).split("\n");
      pendingStderr = lines.pop() ?? "";
      notifyLines(lines);
    };

    const flushStderr = (): void => {
      notifyLines([pendingStderr]);
      pendingStderr = "";
    };

    const controller = new AbortController();
    let completion: Promise<CliCompletion>;

    try {
      completion = starter(args, {
        cwd: ctx.cwd,
        onStderr: streamStderr,
        signal: controller.signal,
        stdin: options.stdin,
      });
    } catch (error) {
      notifyError(ctx, options.failureLabel, error);

      return;
    }

    const settleRun = async (): Promise<void> => {
      try {
        const result = await completion;

        if (controller.signal.aborted) {
          return;
        }

        flushStderr();

        if (result.kind === "signaled") {
          throw new Error(`terminated by ${result.signal}`);
        }

        if (result.code !== 0) {
          throw new Error(`exited with code ${result.code}`);
        }

        options.onOutput(result.stdout);
      } catch (error) {
        if (!controller.signal.aborted) {
          // Stderr was shown as it arrived, so a failure only adds how the CLI ended.
          flushStderr();
          notifyError(ctx, options.failureLabel, error);
        }
      } finally {
        activeRuns.delete(controller);
      }
    };

    activeRuns.set(controller, settleRun());

    ctx.ui.notify(options.openedMessage, "info");
  };

  const shutdown = async (): Promise<void> => {
    const runs = [...activeRuns];

    for (const [controller] of runs) {
      controller.abort();
    }

    await Promise.race([
      Promise.allSettled(runs.map(([, settled]) => settled)),
      delay(SHUTDOWN_TIMEOUT_MS, undefined, { ref: false }),
    ]);
  };

  return { launch, shutdown };
};
