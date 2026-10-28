import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import { safeText } from "@clanker-stuff/pi-tool-rendering/text";
import type { JsonValue } from "@earendil-works/pi-ai";

import { TaskLogs } from "./logs.js";
import { TaskNotices } from "./notices.js";
import type { Unread } from "./notices.js";
import type { Outcome, TaskSummary } from "./output.js";
import { WatchDecoder } from "./protocol.js";

export interface StartTask {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  origin: string;
  protocol?: "events-v1";
  timeoutMs?: number;
}

export interface Task {
  id: string;
  spec: StartTask;
  startedAt: number;
  outcome?: Outcome;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  cleanup: TaskSummary["cleanup"];
  diagnostic?: string;
  result?: JsonValue;
  notices: TaskNotices;
  logs: TaskLogs;
  child?: ChildProcessByStdio<null, Readable, Readable>;
  ready: Promise<void>;
  cleanupPromise?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ProcessLimits {
  concurrency: number;
  history: number;
  unread: number;
  graceMs: number;
  killMs: number;
}

export const DEFAULT_LIMITS: ProcessLimits = {
  concurrency: 8,
  history: 32,
  unread: 32,
  graceMs: 1000,
  killMs: 1000,
};

export const unread = (task: Task): Unread | undefined =>
  task.notices.unread(task.cleanup === "pending" ? undefined : task.outcome);

const describe = (error: unknown) =>
  safeText(error instanceof Error ? error.message : String(error)).slice(
    0,
    500
  );

export class Supervisor {
  private readonly tasks = new Map<string, Task>();
  private closing = false;
  private shutdownPromise?: Promise<void>;
  private readonly changed: () => void;
  private readonly limits: ProcessLimits;

  constructor(changed: () => void, limits: ProcessLimits = DEFAULT_LIMITS) {
    this.changed = changed;
    this.limits = limits;
  }

  async start(spec: StartTask, signal?: AbortSignal): Promise<Task> {
    if (process.platform === "win32") {
      throw new Error("Background tasks require POSIX process groups.");
    }

    signal?.throwIfAborted();

    if (this.closing) {
      throw new Error("Session is shutting down");
    }

    if (this.activeCount >= this.limits.concurrency) {
      throw new Error(
        "Concurrent task limit reached (including cleanup failures); stopping a task whose cleanup failed checks it again"
      );
    }

    this.prune();

    if (
      this.list().filter((t) => t.outcome && unread(t)).length >=
      this.limits.unread
    ) {
      throw new Error(
        "Too many finished tasks have unread notifications; inspect them before starting more."
      );
    }

    const task: Task = {
      id: `t_${randomUUID()}`,
      spec,
      startedAt: Date.now(),
      cleanup: "pending",
      notices: new TaskNotices(),
      logs: new TaskLogs(),
      ready: Promise.resolve(),
    };

    this.tasks.set(task.id, task);
    task.ready = this.launch(task, signal);
    await task.ready;

    if (
      signal?.aborted === true ||
      task.outcome === "spawn_error" ||
      task.outcome === "cancelled"
    ) {
      await this.stop(task.id);
      const kept = task.cleanup !== "clean";

      if (!kept) {
        this.tasks.delete(task.id);
      }

      throw new Error(
        `Task did not start (${task.outcome ?? "cancelled"})${task.diagnostic !== undefined && task.diagnostic !== "" ? `: ${task.diagnostic}` : ""}${kept ? `; cleanup failed, see task ${task.id}` : ""}`
      );
    }

    return task;
  }

  private async launch(task: Task, signal?: AbortSignal): Promise<void> {
    try {
      const child = spawn(task.spec.command, task.spec.args, {
        cwd: task.spec.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      task.child = child;
      const decoder = task.spec.protocol ? new WatchDecoder() : undefined;
      let windowStart = Date.now();
      let records = 0;

      const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
        try {
          task.logs.append(stream, chunk);

          if (stream === "stdout" && decoder && !task.outcome) {
            decoder.push(chunk, (record) => {
              if (Date.now() - windowStart >= 1000) {
                windowStart = Date.now();
                records = 0;
              }

              records += 1;

              if (records > 256) {
                throw new Error("Watcher exceeded 256 records per second");
              }

              if (record.type === "result") {
                task.result = record.data;
                this.finish(task, "result");
              } else {
                task.notices.record(record.data, record.key);
                this.notify();
              }
            });
          }
        } catch (error) {
          task.diagnostic = describe(error);
          this.finish(task, "protocol_error");
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        capture("stdout", chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        capture("stderr", chunk);
      });
      child.on("error", (error) => {
        task.diagnostic = describe(error);
        this.finish(task, "spawn_error");
      });
      let drainTimer: ReturnType<typeof setTimeout> | undefined;

      const exited = (
        code: number | null,
        exitSignal: NodeJS.Signals | null
      ) => {
        clearTimeout(drainTimer);
        task.exitCode = code;
        task.signal = exitSignal;

        if (!task.outcome) {
          try {
            decoder?.finish();
          } catch (error) {
            task.diagnostic = describe(error);
            this.finish(task, "protocol_error");

            return;
          }

          if (code === 0) {
            this.finish(task, decoder ? "result_missing" : "completed");
          } else {
            this.finish(task, "process_error");
          }
        }
      };

      child.on("close", exited);
      child.on("exit", (code, exitSignal) => {
        drainTimer = setTimeout(() => {
          exited(code, exitSignal);
        }, 100);
        drainTimer.unref();
      });

      const abort = () => {
        this.finish(task, "cancelled");
      };

      signal?.addEventListener("abort", abort, { once: true });

      try {
        const spawned = Promise.withResolvers<undefined>();
        child.once("spawn", () => {
          spawned.resolve(undefined);
        });
        child.once("error", () => {
          spawned.resolve(undefined);
        });
        await spawned.promise;

        if (signal?.aborted === true) {
          this.finish(task, "cancelled");
        }
      } finally {
        signal?.removeEventListener("abort", abort);
      }

      if (!task.outcome) {
        task.timer = setTimeout(() => {
          this.finish(task, "timeout");
        }, task.spec.timeoutMs ?? 3_600_000);
        task.timer.unref();
      }

      this.notify();
    } catch (error) {
      task.diagnostic = describe(error);
      this.finish(task, "spawn_error");
    }
  }

  private finish(task: Task, outcome: Outcome): void {
    if (task.outcome) {
      return;
    }

    task.outcome = outcome;
    task.endedAt = Date.now();
    clearTimeout(task.timer);
    this.reap(task);
  }

  private reap(task: Task): void {
    task.cleanup = "pending";
    task.cleanupPromise = (async () => {
      await Promise.resolve();

      try {
        await task.ready;
        await this.cleanup(task);
        this.notify();
      } catch (error) {
        if (task.cleanup === "pending") {
          task.cleanup = "failed";
        }

        task.diagnostic = describe(error);
        this.notify();
      }
    })();
    this.notify();
  }

  private async cleanup(task: Task): Promise<void> {
    const { child } = task;
    const pid = child?.pid;

    if (!child || pid === undefined || pid === 0) {
      task.cleanup = "clean";

      return;
    }

    const alive = () => {
      try {
        process.kill(-pid, 0);

        return true;
      } catch (error) {
        return !(
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        );
      }
    };

    let refusal: string | undefined;

    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if (
          !(error instanceof Error && "code" in error && error.code === "ESRCH")
        ) {
          refusal = describe(error);
        }
      }
    };

    const wait = async (ms: number) => {
      const deadline = Date.now() + ms;

      while (alive() && Date.now() < deadline) {
        await delay(25);
      }
    };

    if (alive()) {
      kill("SIGTERM");
      await wait(this.limits.graceMs);
    }

    if (alive()) {
      kill("SIGKILL");
      await wait(this.limits.killMs);
    }

    const verdict = alive() ? "failed" : "clean";

    if (verdict === "failed" && refusal !== undefined) {
      task.diagnostic ??= refusal;
    }

    if (!child.stdout.destroyed || !child.stderr.destroyed) {
      const closed = Promise.withResolvers<undefined>();
      child.once("close", () => {
        closed.resolve(undefined);
      });
      await Promise.race([closed.promise, delay(100)]);
    }

    child.stdout.destroy();
    child.stderr.destroy();
    task.cleanup = verdict;
  }

  private notify(): void {
    if (!this.closing) {
      this.changed();
    }
  }
  get activeCount(): number {
    return this.list().filter((t) => !t.outcome || t.cleanup !== "clean")
      .length;
  }
  get(id: string): Task {
    const task = this.tasks.get(id);

    if (!task) {
      throw new Error(
        "Unknown or evicted task ID; task_list shows retained tasks."
      );
    }

    return task;
  }
  list(): Task[] {
    return [...this.tasks.values()];
  }
  async stop(id: string): Promise<Task> {
    const task = this.get(id);
    this.finish(task, "cancelled");

    if (task.cleanup === "failed") {
      this.reap(task);
    }

    await task.cleanupPromise;

    return task;
  }
  async discard(orphaned: (task: Task) => boolean): Promise<void> {
    const tasks = this.list().filter(orphaned);

    for (const task of tasks) {
      this.tasks.delete(task.id);
    }

    await Promise.all(
      tasks.map(async (task) => {
        this.finish(task, "cancelled");
        await task.cleanupPromise;

        if (task.cleanup !== "clean") {
          this.tasks.set(task.id, task);
        }
      })
    );
  }
  private prune(): void {
    const finished = this.list().filter(
      (t) => t.outcome !== undefined && t.cleanup === "clean" && !unread(t)
    );

    for (const task of finished.slice(
      0,
      Math.max(0, finished.length - this.limits.history)
    )) {
      this.tasks.delete(task.id);
    }
  }
  async shutdown(): Promise<void> {
    this.shutdownPromise ??= this.close();

    await this.shutdownPromise;
  }
  private async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.list().map(async (t) => await this.stop(t.id)));
  }
}

export const taskSummary = (task: Task): TaskSummary => ({
  id: task.id,
  name: safeText(task.spec.name),
  ...(task.child?.pid === undefined ? {} : { pid: task.child.pid }),
  status: task.outcome ?? "running",
  cleanup: task.cleanup,
  startedAt: task.startedAt,
  ...(task.endedAt === undefined ? {} : { endedAt: task.endedAt }),
  ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
  ...(task.signal === undefined ? {} : { signal: task.signal }),
});
