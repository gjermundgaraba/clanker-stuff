import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type { RpcClient } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  abortRpcCompaction,
  removeCopiedAuth,
  waitForCrashCheckpoint,
} from "../scripts/live-chaos.js";

class FakeChild extends EventEmitter {
  readonly signals: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals) {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("exit", null, signal));

    return true;
  }
}

const watch = (
  child: FakeChild,
  stdout: PassThrough,
  find: (root: string) => Promise<object | undefined>,
  timeoutMs = 1000,
) =>
  waitForCrashCheckpoint({
    child,
    find,
    pollIntervalMs: 10,
    stdout,
    timeoutMs,
  });

const captureError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
};

const rpcCompactionHarness = () => {
  type Listener = Parameters<RpcClient["onEvent"]>[0];

  const compaction = Promise.withResolvers<Awaited<ReturnType<RpcClient["compact"]>>>();
  const listeners = new Set<Listener>();

  const client = {
    abort: vi.fn(async () => {}),
    compact: vi.fn(() => compaction.promise),
    onEvent: vi.fn((listener: Listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    }),
  } satisfies Pick<RpcClient, "abort" | "compact" | "onEvent">;

  const start = () => {
    for (const listener of listeners) {
      listener({ type: "compaction_start", reason: "manual" });
    }
  };

  return { client, compaction, listeners, start };
};

describe("live chaos infrastructure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows help instead of starting a paid RPC run", () => {
    const result = spawnSync("vp", ["run", "test:live:rpc", "--help"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf-8",
      killSignal: "SIGKILL",
      timeout: 10_000,
    });

    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(0);
    expect(output).toContain("Usage:");
    expect(output).not.toContain("Live artifacts:");
  });

  it("waits for a complete artifact line before polling", async () => {
    const child = new FakeChild();
    const stdout = new PassThrough();

    const find = vi.fn<(root: string) => Promise<object | undefined>>(async () => ({
      checkpoint: true,
    }));

    const result = watch(child, stdout, find);

    stdout.write("Live artifacts: /tmp/part");
    await delay(20);
    expect(find).not.toHaveBeenCalled();

    stdout.write("ial\n");
    await expect(result).resolves.toStrictEqual({
      killed: true,
      root: "/tmp/partial",
    });
    expect(find).toHaveBeenCalledWith("/tmp/partial");
  });

  it("propagates polling errors and stops all later polling", async () => {
    const child = new FakeChild();
    const stdout = new PassThrough();

    const find = vi
      .fn<(root: string) => Promise<object | undefined>>()
      .mockRejectedValue(new Error("unreadable session"));

    const result = watch(child, stdout, find);
    const rejection = captureError(result);

    stdout.write("Live artifacts: /tmp/artifacts\n");
    await expect(rejection).resolves.toMatchObject({
      message: "unreadable session",
    });
    await delay(120);

    expect(find).toHaveBeenCalledOnce();
    expect(child.signals).toStrictEqual(["SIGKILL"]);
  });

  it("cleans up polling and timeout work after a spawn error", async () => {
    const child = new FakeChild();
    const stdout = new PassThrough();
    const find = vi.fn<(root: string) => Promise<object | undefined>>(async () => {});
    const result = watch(child, stdout, find);
    const rejection = captureError(result);

    child.emit("error", new Error("spawn failed"));
    await expect(rejection).resolves.toMatchObject({ message: "spawn failed" });
    await delay(120);

    expect(find).not.toHaveBeenCalled();
    expect(child.signals).toStrictEqual(["SIGKILL"]);
  });

  it.each([undefined, { checkpoint: true }])(
    "does not resume polling or kill an exited child after a pending lookup returns %j",
    async (checkpoint) => {
      const child = new FakeChild();
      const stdout = new PassThrough();
      const lookup = Promise.withResolvers<object | undefined>();
      const lookupStarted = Promise.withResolvers<void>();

      const find = vi.fn<(root: string) => Promise<object | undefined>>(() => {
        lookupStarted.resolve();

        return lookup.promise;
      });

      const result = watch(child, stdout, find);

      stdout.write("Live artifacts: /tmp/artifacts\n");
      await lookupStarted.promise;
      expect(find).toHaveBeenCalledOnce();
      child.emit("exit", 0, null);
      lookup.resolve(checkpoint);
      await expect(result).resolves.toStrictEqual({ killed: false, root: "/tmp/artifacts" });
      await delay(120);

      expect(find).toHaveBeenCalledOnce();
      expect(child.signals).toStrictEqual([]);
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("error")).toBe(0);
      expect(stdout.listenerCount("data")).toBe(0);
    },
  );

  it("consumes a pending lookup rejection after the child has exited", async () => {
    const child = new FakeChild();
    const stdout = new PassThrough();
    const lookup = Promise.withResolvers<object | undefined>();
    const lookupStarted = Promise.withResolvers<void>();

    const find = vi.fn<(root: string) => Promise<object | undefined>>(() => {
      lookupStarted.resolve();

      return lookup.promise;
    });

    const result = watch(child, stdout, find);

    stdout.write("Live artifacts: /tmp/artifacts\n");
    await lookupStarted.promise;
    expect(find).toHaveBeenCalledOnce();
    child.emit("exit", 0, null);
    lookup.reject(new Error("late lookup failure"));
    await expect(result).resolves.toMatchObject({ killed: false });
    await delay(120);

    expect(child.signals).toStrictEqual([]);
    expect(find).toHaveBeenCalledOnce();
  });

  it("preserves a child error when a checkpoint lookup completes in the same turn", async () => {
    const child = new FakeChild();
    const stdout = new PassThrough();
    const lookup = Promise.withResolvers<object | undefined>();
    const lookupStarted = Promise.withResolvers<void>();

    const find = vi.fn<(root: string) => Promise<object | undefined>>(() => {
      lookupStarted.resolve();

      return lookup.promise;
    });

    const rejection = captureError(watch(child, stdout, find));
    const failure = new Error("child failed");

    stdout.write("Live artifacts: /tmp/artifacts\n");
    await lookupStarted.promise;
    child.emit("error", failure);
    lookup.resolve({ checkpoint: true });

    await expect(rejection).resolves.toBe(failure);
    await delay(120);
    expect(child.signals).toStrictEqual(["SIGKILL"]);
    expect(find).toHaveBeenCalledOnce();
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("bounds a stalled checkpoint lookup and does not kill again when it completes", async () => {
    const child = new FakeChild();
    const stdout = new PassThrough();
    const lookup = Promise.withResolvers<object | undefined>();
    const find = vi.fn<(root: string) => Promise<object | undefined>>(() => lookup.promise);
    const rejection = captureError(watch(child, stdout, find, 100));

    stdout.write("Live artifacts: /tmp/artifacts\n");
    await expect(rejection).resolves.toMatchObject({
      message: "Crash canary did not persist a checkpoint within 100ms",
    });
    lookup.resolve({ checkpoint: true });
    await delay(120);

    expect(child.signals).toStrictEqual(["SIGKILL"]);
    expect(find).toHaveBeenCalledOnce();
    expect(child.listenerCount("exit")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
  });

  it("removes copied auth while retaining diagnostic artifacts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "live-chaos-test-"));
    const agentDir = path.join(root, "agent");
    await mkdir(agentDir);
    await Promise.all([
      writeFile(path.join(agentDir, "auth.json"), "secret"),
      writeFile(path.join(agentDir, "settings.json"), "settings"),
    ]);

    try {
      await removeCopiedAuth(agentDir);
      await expect(readFile(path.join(agentDir, "auth.json"))).rejects.toThrow("ENOENT");
      await expect(readFile(path.join(agentDir, "settings.json"), "utf-8")).resolves.toBe(
        "settings",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("cleans up RPC compaction startup while cancellation remains pending", async () => {
    vi.useFakeTimers();
    const { client, compaction, listeners, start } = rpcCompactionHarness();
    const aborting = Promise.withResolvers<void>();
    const abortCalled = Promise.withResolvers<void>();
    const cancellation = new Error("Compaction cancelled");
    client.abort.mockImplementation(() => {
      abortCalled.resolve();

      return aborting.promise;
    });

    const result = abortRpcCompaction(client);
    start();
    await abortCalled.promise;

    expect(client.abort).toHaveBeenCalledOnce();
    expect(listeners).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    compaction.reject(cancellation);
    aborting.resolve();
    await expect(result).resolves.toStrictEqual([
      { reason: cancellation, status: "rejected" },
      { status: "fulfilled", value: undefined },
    ]);
  });

  it("stops waiting and removes its listener when RPC compaction fails before starting", async () => {
    const { client, compaction, listeners } = rpcCompactionHarness();
    const failure = new Error("RPC process exited");
    const rejection = captureError(abortRpcCompaction(client));

    compaction.reject(failure);

    await expect(rejection).resolves.toBe(failure);
    expect(client.abort).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
  });

  it("bounds a stalled RPC compaction start and removes its event listener", async () => {
    vi.useFakeTimers();
    const { client, listeners } = rpcCompactionHarness();
    const rejection = captureError(abortRpcCompaction(client, 25));

    await vi.advanceTimersByTimeAsync(25);

    await expect(rejection).resolves.toMatchObject({
      message: "RPC compaction did not start within 25ms",
    });
    expect(client.abort).not.toHaveBeenCalled();
    expect(listeners).toHaveLength(0);
  });
});
