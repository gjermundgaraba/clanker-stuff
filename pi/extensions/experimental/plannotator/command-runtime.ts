import { setTimeout as delay } from "node:timers/promises";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { CliStarter } from "./cli.js";
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
  /** Aborted at shutdown, which ends every run; Pi builds a new runtime for the next session. */
  const lifetime = new AbortController();
  const activeRuns = new Set<Promise<void>>();

  const launch = (args: string[], ctx: ExtensionCommandContext, options: LaunchOptions): void => {
    const { signal } = lifetime;

    const completion = starter(args, {
      cwd: ctx.cwd,
      onStderrLine: (line) => {
        const message = line.trim();

        if (message !== "" && !signal.aborted) ctx.ui.notify(message, "info");
      },
      signal,
      stdin: options.stdin,
    });

    const settleRun = async (): Promise<void> => {
      try {
        const { code, signal: exitSignal, stdout } = await completion;

        if (signal.aborted) return;

        if (code === 0) options.onOutput(stdout);
        else
          notifyError(
            ctx,
            options.failureLabel,
            exitSignal ? `terminated by ${exitSignal}` : `exited with code ${code}`,
          );
      } catch (error) {
        if (!signal.aborted) notifyError(ctx, options.failureLabel, error);
      }
    };

    const run = settleRun().finally(() => activeRuns.delete(run));
    activeRuns.add(run);

    ctx.ui.notify(options.openedMessage, "info");
  };

  const shutdown = async (): Promise<void> => {
    lifetime.abort();

    await Promise.race([
      Promise.allSettled(activeRuns),
      delay(SHUTDOWN_TIMEOUT_MS, undefined, { ref: false }),
    ]);
  };

  return { launch, shutdown };
};
