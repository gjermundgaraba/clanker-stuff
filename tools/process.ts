/* oxlint-disable promise/avoid-new -- child-process events require one shared completion promise */
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type {
  ExtensionContext,
  TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, getShellConfig } from "@earendil-works/pi-coding-agent";

import { ProcessOutput } from "./process-output.js";

type ExitReason = "exit" | "killed" | "timeout";

interface ShellResult {
  exitCode: number | null;
  reason: ExitReason;
}

interface RunningShell {
  completion: Promise<ShellResult>;
  kill: () => void;
  write: (chars: string) => void;
}

interface ProcessSession {
  createdAt: number;
  exitPromise: Promise<void>;
  output: { current: ProcessOutput };
  process: RunningShell;
  status: {
    exitCode: number | null;
    exited: boolean;
    reason: ExitReason;
  };
}

export interface ProcessResult {
  durationMs: number;
  exitCode: number | null;
  fullOutputPath?: string;
  output: string;
  running: boolean;
  sessionId?: number;
  status: "exited" | "killed" | "running" | "timed_out";
  truncation?: TruncationResult;
}

// ponytail: global cap; add per-profile limits or TTL eviction only if real workloads need them.
const MAX_SESSIONS = 32;
const MAX_TIMEOUT_MS = 2_147_483_647;
const PROCESS_CLOSE_GRACE_MS = 1000;

const throwIfAborted = (signal: AbortSignal | undefined) => {
  if (signal?.aborted === true) {
    throw new Error("Operation aborted");
  }
};

const killProcessTree = (child: ChildProcessWithoutNullStreams) => {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    const taskkill = spawn(
      "taskkill",
      ["/F", "/T", "/PID", String(child.pid)],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }
    );
    taskkill.on("error", () => {
      child.kill("SIGKILL");
    });
    taskkill.unref();
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
};

const createShellEnvironment = (ctx: ExtensionContext) => {
  const env = { ...process.env };
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const binDirectory = path.join(getAgentDir(), "bin");
  const pathEntries = (env[pathKey] ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  if (!pathEntries.includes(binDirectory)) {
    env[pathKey] = [binDirectory, ...pathEntries].join(path.delimiter);
  }

  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;
  env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile !== undefined && sessionFile.length > 0) {
    env.PI_SESSION_FILE = sessionFile;
  }
  if (ctx.model) {
    env.PI_PROVIDER = ctx.model.provider;
    env.PI_MODEL = ctx.model.id;
  }
  if (ctx.thinkingLevel) {
    env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  }
  return env;
};

const spawnShell = async (options: {
  command: string;
  ctx: ExtensionContext;
  cwd: string;
  onData: (chunk: Buffer) => void;
  timeoutMs?: number;
}): Promise<RunningShell> => {
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) ||
      options.timeoutMs <= 0 ||
      options.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new Error(
      `Invalid timeout: must be between 1 and ${MAX_TIMEOUT_MS} milliseconds`
    );
  }
  try {
    await access(options.cwd);
  } catch {
    throw new Error(`Working directory does not exist: ${options.cwd}`);
  }

  const shell = getShellConfig();
  if (shell.commandTransport === "stdin") {
    throw new Error("Shell stdin command transport is not supported");
  }
  const child = spawn(shell.shell, [...shell.args, options.command], {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: createShellEnvironment(options.ctx),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdin.on("error", () => {
    // The process may exit before a queued write reaches stdin.
  });
  child.stdout.on("data", options.onData);
  child.stderr.on("data", options.onData);

  let reason: ExitReason = "exit";
  let settled = false;
  let finishAfterGrace: (() => void) | undefined;
  const kill = () => {
    if (settled) {
      return;
    }
    killProcessTree(child);
    finishAfterGrace?.();
  };
  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          reason = "timeout";
          kill();
        }, options.timeoutMs);
  const completion = new Promise<ShellResult>((resolve, reject) => {
    let exitCode: number | null = null;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (grace !== undefined) {
        clearTimeout(grace);
      }
      child.removeAllListeners("exit");
      child.removeAllListeners("close");
    };
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ exitCode, reason });
    };
    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(error);
    };
    finishAfterGrace = () => {
      grace ??= setTimeout(() => {
        killProcessTree(child);
        finish();
      }, PROCESS_CLOSE_GRACE_MS);
    };
    child.once("error", fail);
    child.once("exit", (code) => {
      exitCode = code;
      finishAfterGrace?.();
    });
    child.once("close", (code) => {
      exitCode = code;
      finish();
    });
  });

  return {
    completion,
    kill() {
      if (reason === "exit") {
        reason = "killed";
      }
      kill();
    },
    write(chars) {
      child.stdin.write(chars);
    },
  };
};

const wait = async (
  session: ProcessSession,
  yieldMs: number | undefined,
  signal: AbortSignal | undefined
) => {
  if (signal?.aborted === true) {
    session.process.kill();
    throw new Error("Operation aborted");
  }
  const abort = () => {
    session.process.kill();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (!session.status.exited) {
      await (yieldMs === undefined
        ? session.exitPromise
        : Promise.race([session.exitPromise, delay(Math.max(0, yieldMs))]));
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  throwIfAborted(signal);
};

const drainOutput = async (session: ProcessSession, exited: boolean) => {
  const output = session.output.current;
  if (!exited) {
    session.output.current = new ProcessOutput();
  }
  return await output.snapshot();
};

const formatOutput = async (
  session: ProcessSession
): Promise<ProcessResult> => {
  // Freeze status before the async file flush. If the process exits during the
  // flush, keep the session for one final poll so no late output is dropped.
  const { exitCode, exited, reason } = session.status;
  const snapshot = await drainOutput(session, exited);
  let processStatus: ProcessResult["status"] = "running";
  let status = "Process is still running.";
  if (reason === "timeout") {
    processStatus = "timed_out";
    status = "Process timed out.";
  } else if (reason === "killed") {
    processStatus = "killed";
    status = "Process was killed.";
  } else if (exited) {
    processStatus = "exited";
    status = `Process exited with code ${exitCode ?? "unknown"}.`;
  }
  const notices = [
    snapshot.truncation.truncated
      ? `Output truncated to the last ${snapshot.truncation.outputLines} lines.`
      : undefined,
    snapshot.fullOutputPath !== undefined && snapshot.fullOutputPath.length > 0
      ? `Full output: ${snapshot.fullOutputPath}`
      : undefined,
  ].filter((notice): notice is string => notice !== undefined);
  return {
    durationMs: Date.now() - session.createdAt,
    exitCode,
    fullOutputPath: snapshot.fullOutputPath,
    output: `${snapshot.content.length > 0 ? `${snapshot.content}\n\n` : ""}${status}${
      notices.length > 0 ? `\n\n[${notices.join(" ")}]` : ""
    }`,
    running: !exited,
    status: processStatus,
    truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
  };
};

const identifySession = (
  result: ProcessResult,
  sessionId: number
): ProcessResult => ({
  ...result,
  output: `${result.output}\n\nSession ID: ${sessionId}`,
  sessionId,
});

export class ProcessManager {
  private nextSessionId = 1;
  private readonly sessions = new Map<number, ProcessSession>();

  async start(options: {
    command: string;
    ctx: ExtensionContext;
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    yieldMs?: number;
  }): Promise<ProcessResult> {
    throwIfAborted(options.signal);
    const output = { current: new ProcessOutput() };
    let process: RunningShell;
    try {
      process = await spawnShell({
        ...options,
        onData: (chunk) => {
          output.current.append(chunk);
        },
      });
    } catch (error) {
      await output.current.discard();
      throw error;
    }
    const status: ProcessSession["status"] = {
      exitCode: null,
      exited: false,
      reason: "exit",
    };
    const exitPromise = (async () => {
      try {
        const result = await process.completion;
        status.exitCode = result.exitCode;
        status.exited = true;
        status.reason = result.reason;
      } catch (error) {
        output.current.append(
          Buffer.from(
            `${error instanceof Error ? error.message : String(error)}\n`
          )
        );
        status.exited = true;
        status.reason = "killed";
      }
    })();
    const session: ProcessSession = {
      createdAt: Date.now(),
      exitPromise,
      output,
      process,
      status,
    };

    try {
      await wait(session, options.yieldMs, options.signal);
    } catch (error) {
      process.kill();
      await exitPromise;
      await output.current.discard();
      throw error;
    }
    const result = await formatOutput(session);
    if (!result.running) {
      return result;
    }

    const sessionId = this.nextSessionId;
    this.nextSessionId += 1;
    if (this.sessions.size >= MAX_SESSIONS) {
      const entries = [...this.sessions];
      const candidate =
        entries.find(([, storedSession]) => storedSession.status.exited) ??
        entries[0];
      if (candidate) {
        const [candidateId, candidateSession] = candidate;
        this.sessions.delete(candidateId);
        candidateSession.process.kill();
        await candidateSession.exitPromise;
        await candidateSession.output.current.discard();
      }
    }
    this.sessions.set(sessionId, session);
    return identifySession(result, sessionId);
  }

  async continue(options: {
    chars?: string;
    sessionId: number;
    signal?: AbortSignal;
    yieldMs: number;
  }): Promise<ProcessResult> {
    const session = this.sessions.get(options.sessionId);
    if (!session) {
      throw new Error(`Unknown process session: ${options.sessionId}`);
    }
    if (options.signal?.aborted === true) {
      session.process.kill();
    } else if (options.chars !== undefined && options.chars.length > 0) {
      session.process.write(options.chars);
    }

    try {
      await wait(session, options.yieldMs, options.signal);
    } catch (error) {
      this.sessions.delete(options.sessionId);
      session.process.kill();
      await session.exitPromise;
      await session.output.current.discard();
      throw error;
    }
    const result = await formatOutput(session);
    if (!result.running) {
      this.sessions.delete(options.sessionId);
      return result;
    }
    return identifySession(result, options.sessionId);
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      session.process.kill();
    }
    await Promise.all(
      sessions.map(async (session) => {
        await session.exitPromise;
        await session.output.current.discard();
      })
    );
  }
}
