import { ok as assert } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import type { EventEmitter } from "node:events";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { getAgentDir, RpcClient } from "@earendil-works/pi-coding-agent";

import { CHECKPOINT_CUSTOM_TYPE, parseCheckpoint } from "../checkpoint.ts";
import { isWireRecord as isRecord } from "./wire.ts";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");
const EXTENSION_PATH = path.join(PACKAGE_ROOT, "index.ts");
const LIVE_RUNNER = path.join(import.meta.dirname, "live-multi-compaction.ts");
const JITI_CLI = path.join(
  path.dirname(createRequire(import.meta.url).resolve("jiti/package.json")),
  "lib/jiti-cli.mjs",
);
const configuredModel = process.env.CODEX_COMPACTION_LIVE_MODEL?.trim();
const LIVE_MODEL =
  configuredModel !== undefined && configuredModel.length > 0 ? configuredModel : "gpt-5.6-sol";

interface CrashChild extends EventEmitter {
  kill(signal: "SIGKILL"): boolean;
}

export const removeCopiedAuth = (agentDir: string) =>
  rm(path.join(agentDir, "auth.json"), { force: true });

export const abortRpcCompaction = async (
  client: Pick<RpcClient, "abort" | "compact" | "onEvent">,
  timeoutMs = 30_000,
) => {
  const started = Promise.withResolvers<void>();
  const unsubscribe = client.onEvent((event) => {
    if (event.type === "compaction_start" && event.reason === "manual") {
      started.resolve();
    }
  });
  const timeout = setTimeout(() => {
    started.reject(new Error(`RPC compaction did not start within ${timeoutMs}ms`));
  }, timeoutMs);
  try {
    const compacting = client.compact("aborted RPC compaction");
    await Promise.race([
      started.promise,
      compacting.then(() => {
        throw new Error("RPC compaction completed before compaction_start");
      }),
    ]);
    return Promise.allSettled([compacting, client.abort()]);
  } finally {
    clearTimeout(timeout);
    unsubscribe();
  }
};

const runRpc = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-provider-rpc-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  const sessionDir = path.join(root, "sessions");
  await Promise.all([
    mkdir(agentDir, { mode: 0o700, recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
  ]);
  const authFile = path.join(agentDir, "auth.json");
  let client: RpcClient | undefined;
  try {
    await copyFile(path.join(getAgentDir(), "auth.json"), authFile);
    await chmod(authFile, 0o600);
    await writeFile(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({
        compaction: {
          enabled: true,
          keepRecentTokens: 1,
          reserveTokens: 1000,
        },
      })}\n`,
      { mode: 0o600 },
    );
    client = new RpcClient({
      args: [
        "--session-dir",
        sessionDir,
        "--no-extensions",
        "--extension",
        EXTENSION_PATH,
        "--no-tools",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--approve",
        "--thinking",
        "minimal",
      ],
      cliPath: path.join(
        PACKAGE_ROOT,
        "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      ),
      cwd,
      env: { PI_CODING_AGENT_DIR: agentDir },
      model: LIVE_MODEL,
      provider: "openai-codex",
    });

    console.log(`Live RPC artifacts: ${root}`);
    await client.start();
    await client.promptAndWait(
      `RPC ABORT RECOVERY SOURCE. Reply only READY.\n${"r".repeat(20_000)}`,
      undefined,
      120_000,
    );
    const cancelled = await abortRpcCompaction(client);
    const cancelledResults = cancelled.map((result) =>
      result.status === "rejected" ? String(result.reason) : "fulfilled",
    );
    assert(
      cancelled[0]?.status === "rejected" &&
        String(cancelled[0].reason).includes("Compaction cancelled") &&
        cancelled[1]?.status === "fulfilled",
      `Aborted RPC results were ${cancelledResults.join(", ")}`,
    );
    const cancelledEntries = await client.getEntries();
    assert(
      cancelledEntries.entries.every((entry) => entry.type !== "compaction"),
      "Cancelled RPC compaction persisted a compaction entry",
    );

    await client.compact("recovery RPC compaction");
    const recoveredEntries = await client.getEntries();
    const compactions = recoveredEntries.entries.filter((entry) => entry.type === "compaction");
    assert(compactions.length === 1, "RPC recovery did not persist once");
    const [compaction] = compactions;
    assert(
      compaction !== undefined &&
        isRecord(compaction.details) &&
        compaction.details.type === CHECKPOINT_CUSTOM_TYPE,
      "RPC recovery checkpoint details are missing",
    );
    const parsed = parseCheckpoint(compaction.details.checkpoint);
    assert(parsed.ok, "RPC recovery checkpoint is invalid");
    await client.promptAndWait("RPC RECOVERY REPLAY. Reply only RECOVERED.", undefined, 120_000);
    const state = await client.getState();
    console.log(
      JSON.stringify(
        {
          cancelledCompactions: 1,
          checkpointResponseId: parsed.checkpoint.response.id,
          model: `openai-codex/${LIVE_MODEL}`,
          sessionFile: state.sessionFile,
          status: "passed",
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await client?.stop();
    } finally {
      await removeCopiedAuth(agentDir);
    }
  }
};

const findCheckpoint = async (
  root: string,
): Promise<
  | {
      readonly count: number;
      readonly responseId: string;
      readonly sessionFile: string;
    }
  | undefined
> => {
  const sessionDir = path.join(root, "sessions");
  const names = await readdir(sessionDir, { recursive: true });
  for (const name of names) {
    if (!name.endsWith(".jsonl")) {
      continue;
    }
    const sessionFile = path.join(sessionDir, name);
    const contents = await readFile(sessionFile, "utf-8");
    const entries = contents
      .trim()
      .split("\n")
      .flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return isRecord(value) ? [value] : [];
        } catch {
          return [];
        }
      });
    const checkpoints = entries.filter(
      (entry) => entry.type === "custom" && entry.customType === CHECKPOINT_CUSTOM_TYPE,
    );
    const latest = checkpoints.at(-1);
    if (latest === undefined) {
      continue;
    }
    const parsed = parseCheckpoint(latest.data);
    if (parsed.ok) {
      return {
        count: checkpoints.length,
        responseId: parsed.checkpoint.response.id,
        sessionFile,
      };
    }
  }
  return undefined;
};

export const waitForCrashCheckpoint = async ({
  child,
  find,
  pollIntervalMs = 250,
  stdout,
  timeoutMs = 600_000,
}: {
  readonly child: CrashChild;
  readonly find: (root: string) => Promise<object | undefined>;
  readonly pollIntervalMs?: number;
  readonly stdout: Readable;
  readonly timeoutMs?: number;
}): Promise<{ readonly killed: boolean; readonly root?: string }> => {
  const controller = new AbortController();
  const { signal } = controller;
  let root: string | undefined;
  const lines = createInterface({ input: stdout });
  lines.on("line", (line) => {
    if (root === undefined && line.startsWith("Live artifacts: ")) {
      const candidate = line.slice("Live artifacts: ".length).trim();
      if (candidate.length > 0) {
        root = candidate;
      }
    }
  });
  const exited = once(child, "exit", { signal }).then(([, exitSignal]: readonly unknown[]) => ({
    killed: exitSignal === "SIGKILL",
    root,
  }));
  // Stop synchronously: events.once() propagates its result through later microtasks.
  const stop = () => controller.abort();
  child.once("exit", stop);
  child.once("error", stop);
  const poll = async () => {
    while (true) {
      await delay(pollIntervalMs, undefined, { signal });
      if (root !== undefined) {
        const checkpoint = await find(root);
        // An uncancellable file lookup may finish after the child has exited.
        signal.throwIfAborted();
        if (checkpoint !== undefined) {
          child.kill("SIGKILL");
          return exited;
        }
      }
    }
  };
  const timeout = delay(timeoutMs, undefined, { signal }).then(() => {
    throw new Error(`Crash canary did not persist a checkpoint within ${timeoutMs}ms`);
  });
  try {
    return await Promise.race([exited, poll(), timeout]).catch((error) => {
      // Cancellation can reach the polling loop before events.once() has settled.
      if (signal.aborted) {
        return exited;
      }
      throw error;
    });
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  } finally {
    child.off("exit", stop);
    child.off("error", stop);
    controller.abort();
    lines.close();
  }
};

const runCrash = async () => {
  const child = spawn(process.execPath, [JITI_CLI, LIVE_RUNNER, "--sse"], {
    env: {
      ...process.env,
      CODEX_COMPACTION_LIVE_ROUNDS: "3",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  assert(child.stdout !== null, "Crash child stdout is unavailable");
  child.stdout.pipe(process.stdout, { end: false });
  const { killed, root } = await waitForCrashCheckpoint({
    child,
    find: findCheckpoint,
    stdout: child.stdout,
  });
  assert(killed && root !== undefined, "Crash child was not killed after persistence");
  const persisted = await findCheckpoint(root);
  assert(persisted !== undefined, "Killed child left no durable checkpoint");

  const resultFile = path.join(root, "crash-restart-result.json");
  execFileSync(process.execPath, [JITI_CLI, LIVE_RUNNER, "--restart-child"], {
    env: {
      ...process.env,
      CODEX_COMPACTION_RESTART_AGENT_DIR: path.join(root, "agent"),
      CODEX_COMPACTION_RESTART_CWD: path.join(root, "workspace"),
      CODEX_COMPACTION_RESTART_MODEL: LIVE_MODEL,
      CODEX_COMPACTION_RESTART_RESPONSE: persisted.responseId,
      CODEX_COMPACTION_RESTART_RESULT: resultFile,
      CODEX_COMPACTION_RESTART_ROUNDS: String(persisted.count),
      CODEX_COMPACTION_RESTART_SESSION_DIR: path.join(root, "sessions"),
      CODEX_COMPACTION_RESTART_SESSION_FILE: persisted.sessionFile,
      CODEX_COMPACTION_RESTART_TRANSPORT: "sse",
    },
    stdio: "inherit",
  });
  const result: unknown = JSON.parse(await readFile(resultFile, "utf-8"));
  assert(isRecord(result) && result.status === "passed", "Crash restart failed");
  console.log(
    JSON.stringify(
      {
        checkpointsAtKill: persisted.count,
        killedWith: "SIGKILL",
        restart: result,
        sessionFile: persisted.sessionFile,
        status: "passed",
      },
      null,
      2,
    ),
  );
};

const main = async () => {
  const rpc = process.argv.includes("--rpc");
  const crash = process.argv.includes("--crash");
  if (process.argv.includes("--help") || (!rpc && !crash)) {
    console.log(`Usage:
  vp run @clanker-stuff/codex-provider#test:live:rpc
  vp run @clanker-stuff/codex-provider#test:live:crash`);
    return;
  }
  if (rpc) {
    await runRpc();
  } else {
    await runCrash();
  }
};

if (process.argv[1] === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
