#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type {
  CliCompletion,
  CliProcess,
  CliStarter,
  CliStartOptions,
} from "./cli.ts";
import { processFailure, startCli } from "./cli.ts";

const READY_TIMEOUT_MS = 30_000;
const NOOP_BROWSERS = new Set(["true", "false", "none", ":", "0", "1"]);
const HELP = `Usage:
  plannotator-review [--base <git-ref>] [plannotator review options]

Options:
  --base <git-ref>  Review all committed and working-tree changes since this ref

All other options are forwarded to \`plannotator review\`.
`;

interface ReadyMetadata {
  isRemote: boolean;
  url: string;
}

interface BrowserChoice {
  plannotatorStyle: boolean;
  value: string;
}

interface LauncherDependencies {
  fetch?: typeof fetch;
  openUrl?: (url: string) => Promise<void>;
  readyTimeoutMs?: number;
}

interface ParsedReview {
  args: string[];
  base?: string;
  browser?: string;
}

const parseReview = (args: string[]): ParsedReview => {
  if (args[0] !== "review") {
    return { args };
  }

  const forwarded: string[] = [];
  const positional: string[] = [];
  let base: string | undefined;
  let browser: string | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--base") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--base requires a Git ref");
      }
      if (base !== undefined) {
        throw new Error("--base may only be specified once");
      }
      base = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--base=")) {
      const value = token.slice("--base=".length);
      if (!value) {
        throw new Error("--base requires a Git ref");
      }
      if (base !== undefined) {
        throw new Error("--base may only be specified once");
      }
      base = value;
      continue;
    }

    forwarded.push(token);
    if (token === "--browser") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--browser requires a value");
      }
      browser = value;
      forwarded.push(value);
      index += 1;
    } else if (token.startsWith("--browser=")) {
      browser = token.slice("--browser=".length);
    } else if (!token.startsWith("-")) {
      positional.push(token);
    }
  }

  if (base === undefined) {
    return { args };
  }
  if (positional.length > 0) {
    throw new Error("--base cannot be combined with a pull request URL");
  }
  if (forwarded.includes("--gitbutler")) {
    throw new Error("--base is only supported for Git reviews");
  }
  if (!forwarded.includes("--git")) {
    forwarded.unshift("--git");
  }

  return { args: ["review", ...forwarded], base, browser };
};

const completionBeforeReady = async (
  completion: Promise<CliCompletion>
): Promise<never> => {
  const result = await completion;
  if (result.kind === "exited" && result.code !== 0) {
    throw processFailure(result);
  }
  if (result.kind === "signaled") {
    throw new Error(`Plannotator terminated by ${result.signal}`);
  }
  throw new Error("Plannotator exited before opening the review server");
};

const readReadyMetadata = (filePath: string): ReadyMetadata | undefined => {
  let text: string;
  try {
    text = readFileSync(filePath, "utf-8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }

  const line = text.trim().split(/\r?\n/u).at(-1);
  if (line === undefined || line.length === 0) {
    return undefined;
  }

  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value !== "object" ||
      value === null ||
      !("url" in value) ||
      !("isRemote" in value) ||
      typeof value.url !== "string" ||
      typeof value.isRemote !== "boolean"
    ) {
      return undefined;
    }
    return URL.canParse(value.url)
      ? { isRemote: value.isRemote, url: value.url }
      : undefined;
  } catch {
    return undefined;
  }
};

const waitForReady = async (
  readyFile: string,
  signal: AbortSignal,
  timeoutMs: number
): Promise<ReadyMetadata> => {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<ReadyMetadata> => {
    const metadata = readReadyMetadata(readyFile);
    if (metadata) {
      return metadata;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        "Timed out waiting for Plannotator to open the review server"
      );
    }
    await delay(25, undefined, { signal });
    return await poll();
  };
  return await poll();
};

const switchBase = async (
  url: string,
  base: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch
): Promise<void> => {
  const response = await fetchImpl(new URL("/api/diff/switch", url), {
    body: JSON.stringify({
      base,
      diffType: "since-base",
      explicitBase: true,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  const apiError =
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
      ? payload.error
      : undefined;
  if (!response.ok || apiError !== undefined) {
    const detail =
      apiError ?? (text.length > 0 ? text : `HTTP ${response.status}`);
    throw new Error(`Could not target base ${JSON.stringify(base)}: ${detail}`);
  }
};

const browserChoice = (
  browserArgument: string | undefined,
  env: NodeJS.ProcessEnv
): BrowserChoice | undefined => {
  const plannotatorBrowser = browserArgument ?? env.PLANNOTATOR_BROWSER;
  if (
    plannotatorBrowser !== undefined &&
    plannotatorBrowser.length > 0 &&
    !NOOP_BROWSERS.has(plannotatorBrowser.trim().toLowerCase())
  ) {
    return { plannotatorStyle: true, value: plannotatorBrowser };
  }
  const browser = env.BROWSER;
  return browser !== undefined &&
    browser.length > 0 &&
    !NOOP_BROWSERS.has(browser.trim().toLowerCase())
    ? { plannotatorStyle: false, value: browser }
    : undefined;
};

const spawnDetached = (command: string, args: string[]): Promise<null> => {
  const { promise, reject, resolve } = Promise.withResolvers<null>();
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.once("error", reject);
  child.once("spawn", () => {
    child.unref();
    resolve(null);
  });
  return promise;
};

const openBrowser = async (
  url: string,
  choice: BrowserChoice | undefined
): Promise<void> => {
  const isWindows = process.platform === "win32";
  const isWsl =
    process.platform === "linux" &&
    (Boolean(process.env.WSL_DISTRO_NAME) ||
      release().toLowerCase().includes("microsoft"));

  if (choice) {
    if (process.platform === "darwin" && choice.plannotatorStyle) {
      const [command, args]: [string, string[]] =
        choice.value.includes("/") && !choice.value.endsWith(".app")
          ? [choice.value, [url]]
          : ["open", ["-a", choice.value, url]];
      await spawnDetached(command, args);
      return;
    }
    if ((isWindows || isWsl) && choice.plannotatorStyle) {
      await spawnDetached("cmd.exe", ["/c", "start", "", choice.value, url]);
      return;
    }
    await spawnDetached(choice.value, [url]);
    return;
  }

  if (isWindows || isWsl) {
    await spawnDetached("cmd.exe", ["/c", "start", "", url]);
    return;
  }
  if (process.platform === "darwin") {
    await spawnDetached("open", [url]);
    return;
  }
  await spawnDetached("xdg-open", [url]);
};

const announceUrl = (url: string): void => {
  process.stderr.write(`\nPlannotator review ready: ${url}\n\n`);
};

export const createTargetedReviewStarter =
  (start: CliStarter, dependencies: LauncherDependencies = {}): CliStarter =>
  (args: string[], options: CliStartOptions): CliProcess => {
    const review = parseReview(args);
    const { base } = review;
    if (base === undefined) {
      return start(args, options);
    }

    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "plannotator-review-")
    );
    const readyFile = path.join(temporaryDirectory, "ready.jsonl");
    const controller = new AbortController();
    const env = { ...process.env, ...options.env };
    let child: CliProcess;

    try {
      child = start(review.args, {
        ...options,
        env: {
          ...options.env,
          PLANNOTATOR_READY_FILE: readyFile,
          PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
        },
      });
    } catch (error) {
      rmSync(temporaryDirectory, { force: true, recursive: true });
      throw error;
    }

    const completion = (async (): Promise<CliCompletion> => {
      try {
        const metadata = await Promise.race([
          waitForReady(
            readyFile,
            controller.signal,
            dependencies.readyTimeoutMs ?? READY_TIMEOUT_MS
          ),
          completionBeforeReady(child.completion),
        ]);
        await switchBase(
          metadata.url,
          base,
          controller.signal,
          dependencies.fetch ?? fetch
        );

        if (metadata.isRemote) {
          announceUrl(metadata.url);
        }
        try {
          const browser = browserChoice(review.browser, env);
          if (!metadata.isRemote || browser) {
            await (dependencies.openUrl
              ? dependencies.openUrl(metadata.url)
              : openBrowser(metadata.url, browser));
          }
        } catch {
          announceUrl(metadata.url);
        }

        return await child.completion;
      } catch (error) {
        if (!controller.signal.aborted) {
          child.cancel();
        }
        try {
          await child.completion;
        } catch {
          // Preserve the setup error below.
        }
        if (controller.signal.aborted) {
          return { kind: "cancelled" };
        }
        throw error;
      } finally {
        rmSync(temporaryDirectory, { force: true, recursive: true });
      }
    })();

    return {
      cancel() {
        if (!controller.signal.aborted) {
          controller.abort();
          child.cancel();
        }
      },
      completion,
      signal: controller.signal,
    };
  };

const startInstalledPlannotator: CliStarter = (args, options) =>
  startCli("plannotator", args, {
    ...options,
    env: { ...process.env, ...options.env, PLANNOTATOR_CWD: options.cwd },
    onStderr: (chunk) => {
      process.stderr.write(chunk);
    },
  });

const runCli = async (): Promise<void> => {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  const review = createTargetedReviewStarter(startInstalledPlannotator)(
    ["review", ...args],
    { cwd: process.cwd() }
  );
  const cancel = (): void => {
    review.cancel();
  };
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);

  try {
    const result = await review.completion;
    if (result.kind === "exited") {
      process.stdout.write(result.stdout);
      process.exitCode = result.code;
    } else if (result.kind === "signaled") {
      process.stderr.write(`Plannotator terminated by ${result.signal}\n`);
      process.exitCode = 1;
    } else {
      process.exitCode = 130;
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
};

const isMain = (): boolean => {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(import.meta.filename)
    );
  } catch {
    return false;
  }
};

if (isMain()) {
  await runCli();
}
