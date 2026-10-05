import type { JsonValue } from "@earendil-works/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { safeText } from "@clanker-stuff/pi-tool-rendering/text";
import { TaskLogs } from "./logs.js";
import { TaskNotices, type Unread } from "./notices.js";
import { WatchDecoder } from "./protocol.js";
import type { Outcome, TaskSummary } from "./output.js";

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
  child?: ChildProcess;
  ready: Promise<void>;
  cleanupPromise?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ProcessLimits {
  concurrency: number;
  /** Finished, cleaned and fully read tasks kept for inspection. */
  history: number;
  /** Finished tasks whose notice is still unread; bounds memory while delivery waits. */
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

/** A finished task announces its outcome only after cleanup, when its logs are complete. */
export const unread = (task: Task): Unread | undefined =>
  task.notices.unread(task.cleanup === "pending" ? undefined : task.outcome);

const describe = (error: unknown) =>
  safeText(error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Owns processes, never Pi contexts. */
export class Supervisor {
  private tasks = new Map<string, Task>();
  private closing = false;
  private shutdownPromise?: Promise<void>;
  constructor(
    private changed: () => void,
    private limits: ProcessLimits = DEFAULT_LIMITS,
  ) {}

  async start(spec: StartTask, signal?: AbortSignal): Promise<Task> {
    if (process.platform === "win32")
      throw new Error("Background tasks require POSIX process groups.");
    signal?.throwIfAborted();

    if (this.closing) throw new Error("Session is shutting down");

    if (this.activeCount >= this.limits.concurrency)
      throw new Error(
        "Concurrent task limit reached (including cleanup failures); stopping a task whose cleanup failed checks it again",
      );
    this.prune();

    if (this.list().filter((t) => t.outcome && unread(t)).length >= this.limits.unread)
      throw new Error(
        "Too many finished tasks have unread notifications; inspect them before starting more.",
      );

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

    if (signal?.aborted || task.outcome === "spawn_error" || task.outcome === "cancelled") {
      await this.stop(task.id);
      // A failed start leaves nothing to inspect unless its process may still be alive.
      const kept = task.cleanup !== "clean";

      if (!kept) this.tasks.delete(task.id);
      throw new Error(
        `Task did not start (${task.outcome ?? "cancelled"})${task.diagnostic ? `: ${task.diagnostic}` : ""}${kept ? `; cleanup failed, see task ${task.id}` : ""}`,
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

              if (++records > 256) throw new Error("Watcher exceeded 256 records per second");

              if (record.type === "result") {
                task.result = record.data;
                this.finish(task, "result");

                return false;
              }

              task.notices.record(record.data, record.key);
              this.notify();

              return !task.outcome;
            });
          }
        } catch (error) {
          task.diagnostic = describe(error);
          this.finish(task, "protocol_error");
        }
      };

      child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
      child.on("error", (error) => {
        task.diagnostic = describe(error);
        this.finish(task, "spawn_error");
      });
      let drainTimer: ReturnType<typeof setTimeout> | undefined;

      const exited = (code: number | null, exitSignal: NodeJS.Signals | null) => {
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

          this.finish(
            task,
            code === 0 ? (decoder ? "result_missing" : "completed") : "process_error",
          );
        }
      };

      child.on("close", exited);
      child.on("exit", (code, exitSignal) => {
        // Descendants can keep inherited pipes open after the direct child exits.
        drainTimer = setTimeout(() => exited(code, exitSignal), 100);
        drainTimer.unref();
      });
      const abort = () => this.finish(task, "cancelled");
      signal?.addEventListener("abort", abort, { once: true });

      try {
        await new Promise<void>((resolve) => {
          child.once("spawn", resolve);
          child.once("error", () => resolve());
        });

        if (signal?.aborted) this.finish(task, "cancelled");
      } finally {
        signal?.removeEventListener("abort", abort);
      }

      if (!task.outcome) {
        task.timer = setTimeout(() => this.finish(task, "timeout"), task.spec.timeoutMs ?? 3600000);
        task.timer.unref();
      }

      this.notify();
    } catch (error) {
      task.diagnostic = describe(error);
      this.finish(task, "spawn_error");
    }
  }

  private finish(task: Task, outcome: Outcome): void {
    if (task.outcome) return;
    task.outcome = outcome;
    task.endedAt = Date.now();
    clearTimeout(task.timer);
    this.reap(task);
  }

  /** Runs process cleanup; stop() also uses it to retry a cleanup that failed. */
  private reap(task: Task): void {
    task.cleanup = "pending";
    // Defer until launch has returned, avoiding a ready/cleanup promise cycle.
    task.cleanupPromise = Promise.resolve()
      .then(async () => {
        await task.ready;
        await this.cleanup(task);
        this.notify();
      })
      .catch((error: unknown) => {
        if (task.cleanup === "pending") task.cleanup = "failed";
        task.diagnostic = describe(error);
        this.notify();
      });
    this.notify();
  }

  private async cleanup(task: Task): Promise<void> {
    const child = task.child;
    const pid = child?.pid;

    if (!child || !pid) {
      task.cleanup = "clean";

      return;
    }

    const alive = () => {
      try {
        process.kill(-pid, 0);

        return true;
      } catch (error) {
        return !(error instanceof Error && "code" in error && error.code === "ESRCH");
      }
    };

    // macOS can transiently refuse to signal a group of exiting processes.
    let refusal: string | undefined;

    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
          refusal = describe(error);
      }
    };

    const wait = async (ms: number) => {
      const deadline = Date.now() + ms;

      while (alive() && Date.now() < deadline) await delay(25);
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

    if (verdict === "failed" && refusal !== undefined) task.diagnostic ??= refusal;

    // Allow close/data callbacks to drain. Never wait forever for inherited pipes.
    if (!child.stdout?.destroyed || !child.stderr?.destroyed) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        delay(100),
      ]);
    }

    child.stdout?.destroy();
    child.stderr?.destroy();
    // Published once cleanup is over: a stop that sees "failed" retries a finished cleanup.
    task.cleanup = verdict;
  }

  private notify(): void {
    if (!this.closing) this.changed();
  }
  get activeCount(): number {
    return this.list().filter((t) => !t.outcome || t.cleanup !== "clean").length;
  }
  get(id: string): Task {
    const task = this.tasks.get(id);

    if (!task) throw new Error("Unknown or evicted task ID; task_list shows retained tasks.");

    return task;
  }
  list(): Task[] {
    return [...this.tasks.values()];
  }
  async stop(id: string): Promise<Task> {
    const task = this.get(id);
    this.finish(task, "cancelled");

    // A failed cleanup may be stale: the group can exit after cleanup gives up.
    if (task.cleanup === "failed") this.reap(task);
    await task.cleanupPromise;

    return task;
  }
  /** Stops tasks a branch change orphaned and forgets those whose process group is gone. */
  async discard(orphaned: (task: Task) => boolean): Promise<void> {
    const tasks = this.list().filter(orphaned);

    // Forget them before awaiting cleanup, so no notice announces them meanwhile.
    for (const task of tasks) this.tasks.delete(task.id);
    await Promise.all(
      tasks.map(async (task) => {
        this.finish(task, "cancelled");
        await task.cleanupPromise;

        if (task.cleanup !== "clean") this.tasks.set(task.id, task);
      }),
    );
  }
  private prune(): void {
    const finished = this.list().filter((t) => t.outcome && t.cleanup === "clean" && !unread(t));

    for (const task of finished.slice(0, Math.max(0, finished.length - this.limits.history)))
      this.tasks.delete(task.id);
  }
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.close();

    return this.shutdownPromise;
  }
  private async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.list().map((t) => this.stop(t.id)));
  }
}

export function taskSummary(task: Task): TaskSummary {
  return {
    id: task.id,
    name: safeText(task.spec.name),
    ...(task.child?.pid !== undefined ? { pid: task.child.pid } : {}),
    status: task.outcome ?? "running",
    cleanup: task.cleanup,
    startedAt: task.startedAt,
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
    ...(task.signal !== undefined ? { signal: task.signal } : {}),
  };
}
