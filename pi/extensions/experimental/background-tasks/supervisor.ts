import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TaskLogs, safeText } from "./logs.js";
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
export type Outcome =
  | "completed"
  | "result"
  | "result_missing"
  | "process_error"
  | "spawn_error"
  | "protocol_error"
  | "timeout"
  | "cancelled";
export interface Task {
  id: string;
  spec: StartTask;
  startedAt: number;
  outcome?: Outcome;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  cleanup: "pending" | "clean" | "failed";
  diagnostic?: string;
  result?: unknown;
  abandoned: boolean;
  child?: ChildProcess;
  logs?: TaskLogs;
  ready: Promise<void>;
  cleanupPromise?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}
export interface SupervisorHooks {
  reserve(id: string): void;
  protected(id: string): boolean;
  progress(task: Task, data: unknown, key?: string): void;
  terminal(task: Task, outcome: Outcome): void;
  changed(): void;
}
export interface ProcessLimits {
  concurrency: number;
  history: number;
  graceMs: number;
  killMs: number;
}
const defaults: ProcessLimits = { concurrency: 8, history: 32, graceMs: 1000, killMs: 1000 };

/** Owns processes, never Pi contexts. Notifications are plain observations. */
export class Supervisor {
  private tasks = new Map<string, Task>();
  private directory?: Promise<string>;
  private closing = false;
  private shutdownPromise?: Promise<void>;
  evicted = 0;
  constructor(
    private hooks: SupervisorHooks,
    private limits: ProcessLimits = defaults,
  ) {}

  async start(spec: StartTask, signal?: AbortSignal): Promise<Task> {
    if (process.platform === "win32")
      throw new Error("Background tasks require POSIX process groups.");
    signal?.throwIfAborted();
    if (this.closing) throw new Error("Session is shutting down");
    await Promise.all(
      this.list()
        .filter((t) => t.cleanup === "failed")
        .map((t) => this.reconcile(t)),
    );
    signal?.throwIfAborted();
    if (this.closing) throw new Error("Session is shutting down");
    if (this.activeCount >= this.limits.concurrency)
      throw new Error("Concurrent task limit reached (including cleanup failures)");
    await this.prune();
    signal?.throwIfAborted();
    // Recheck after pruning: sibling starts execute concurrently.
    if (this.closing || this.activeCount >= this.limits.concurrency)
      throw new Error("Task admission unavailable");
    const id = `t_${randomUUID()}`;
    this.hooks.reserve(id);
    const task: Task = {
      id,
      spec,
      startedAt: Date.now(),
      cleanup: "pending",
      abandoned: false,
      ready: Promise.resolve(),
    };
    this.tasks.set(id, task);
    task.ready = this.launch(task, signal);
    await task.ready;
    if (signal?.aborted || task.outcome === "spawn_error" || task.outcome === "cancelled") {
      await this.stop(task.id);
      throw new Error(
        `Task ${id} did not start: ${task.outcome ?? "cancelled"}. Inspect it for diagnostics.`,
      );
    }
    return task;
  }

  private async launch(task: Task, signal?: AbortSignal): Promise<void> {
    try {
      this.directory ??= mkdtemp(join(tmpdir(), "pi-background-tasks-"));
      const root = await this.directory;
      const directory = await mkdtemp(join(root, `${task.id}-`));
      task.logs = new TaskLogs(directory);
      if (this.closing || task.outcome || signal?.aborted) {
        this.finish(task, "cancelled");
        return;
      }
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
          task.logs?.append(stream, chunk);
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
              this.hooks.progress(task, record.data, record.key);
              return !task.outcome;
            });
          }
        } catch (error) {
          task.diagnostic = safeText(String(error)).slice(0, 500);
          this.finish(task, "protocol_error");
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
      child.on("error", (error) => {
        task.diagnostic = safeText(error.message).slice(0, 500);
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
            task.diagnostic = safeText(String(error)).slice(0, 500);
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
      this.changed();
    } catch (error) {
      task.diagnostic = safeText(String(error)).slice(0, 500);
      this.finish(task, "spawn_error");
    }
  }

  private finish(task: Task, outcome: Outcome): void {
    if (task.outcome) return;
    task.outcome = outcome;
    task.endedAt = Date.now();
    clearTimeout(task.timer);
    // Defer until launch has returned, avoiding a ready/cleanup promise cycle.
    task.cleanupPromise = Promise.resolve()
      .then(async () => {
        await task.ready;
        await this.cleanup(task);
        if (!this.closing && !task.abandoned) this.hooks.terminal(task, outcome);
        this.changed();
      })
      .catch((error) => {
        if (task.cleanup === "pending") task.cleanup = "failed";
        task.diagnostic = safeText(String(error)).slice(0, 500);
        this.changed();
      });
    this.changed();
  }

  private async cleanup(task: Task): Promise<void> {
    const child = task.child;
    const pid = child?.pid;
    if (child && pid) {
      const alive = () => {
        try {
          process.kill(-pid, 0);
          return true;
        } catch (error) {
          return !(error instanceof Error && "code" in error && error.code === "ESRCH");
        }
      };
      const kill = (signal: NodeJS.Signals) => {
        try {
          process.kill(-pid, signal);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
            task.diagnostic = safeText(String(error)).slice(0, 500);
          }
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
      task.cleanup = alive() ? "failed" : "clean";
      // Allow close/data callbacks to drain. Never wait forever for inherited pipes.
      if (!child.stdout?.destroyed || !child.stderr?.destroyed) {
        await Promise.race([
          new Promise<void>((resolve) => child.once("close", () => resolve())),
          delay(100),
        ]);
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    } else {
      task.cleanup = "clean";
    }
    await task.logs?.close();
  }

  private changed(): void {
    if (!this.closing) this.hooks.changed();
  }
  get activeCount(): number {
    return [...this.tasks.values()].filter((t) => !t.outcome || t.cleanup !== "clean").length;
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
    await task.cleanupPromise;
    await this.reconcile(task);
    return task;
  }
  private async reconcile(task: Task): Promise<void> {
    if (task.cleanup !== "failed") return;
    // Cleanup assigns its status before draining pipes and closing logs.
    await task.cleanupPromise;
    const child = task.child;
    if (!child?.pid || (child.exitCode === null && child.signalCode === null)) return;
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        task.cleanup = "clean";
        this.changed();
      }
    }
  }
  async prune(): Promise<void> {
    const retained = this.list().filter(
      (t) => t.outcome && t.cleanup === "clean" && !this.hooks.protected(t.id),
    );
    const victims = retained.slice(0, Math.max(0, retained.length - this.limits.history));
    // Claim every victim before filesystem work can yield to another prune.
    for (const task of victims) this.tasks.delete(task.id);
    this.evicted += victims.length;
    for (const task of victims) {
      if (task.logs) await rm(task.logs.directory, { recursive: true, force: true });
    }
  }
  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.close();
    return this.shutdownPromise;
  }
  private async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.list().map((t) => this.stop(t.id)));
    if (this.directory && this.list().every((t) => t.cleanup === "clean")) {
      const directory = await this.directory.catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}

export function taskSummary(task: Task) {
  return {
    id: task.id,
    name: safeText(task.spec.name),
    pid: task.child?.pid,
    status: task.outcome ?? "running",
    cleanup: task.cleanup,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    exitCode: task.exitCode,
    signal: task.signal,
    abandoned: task.abandoned,
  };
}
