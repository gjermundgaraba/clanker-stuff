import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  removeCopiedAuth,
  waitForCrashCheckpoint,
} from "../scripts/live-chaos.js";

// oxlint-disable-next-line unicorn/prefer-event-target -- ChildProcess uses EventEmitter semantics
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
  find: (root: string) => Promise<unknown>
) =>
  waitForCrashCheckpoint({
    child: child as never,
    find,
    pollIntervalMs: 10,
    stdout,
    timeoutMs: 100,
  });

const captureError = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
};

describe("live crash infrastructure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a complete artifact line before polling", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const stdout = new PassThrough();
    const find = vi.fn<(root: string) => Promise<unknown>>(async () => ({
      checkpoint: true,
    }));
    const result = watch(child, stdout, find);

    stdout.write("Live artifacts: /tmp/part");
    await vi.advanceTimersByTimeAsync(10);
    expect(find).not.toHaveBeenCalled();

    stdout.write("ial\n");
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toStrictEqual({
      killed: true,
      root: "/tmp/partial",
    });
    expect(find).toHaveBeenCalledWith("/tmp/partial");
  });

  it("propagates polling errors and stops all later polling", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const stdout = new PassThrough();
    const find = vi
      .fn<(root: string) => Promise<unknown>>()
      .mockRejectedValue(new Error("unreadable session"));
    const result = watch(child, stdout, find);
    const rejection = captureError(result);

    stdout.write("Live artifacts: /tmp/artifacts\n");
    await vi.advanceTimersByTimeAsync(10);
    await expect(rejection).resolves.toMatchObject({
      message: "unreadable session",
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(find).toHaveBeenCalledOnce();
    expect(child.signals).toStrictEqual(["SIGKILL"]);
  });

  it("cleans up polling and timeout work after a spawn error", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const stdout = new PassThrough();
    const find = vi.fn<(root: string) => Promise<unknown>>(async () => {});
    const result = watch(child, stdout, find);
    const rejection = captureError(result);

    child.emit("error", new Error("spawn failed"));
    await expect(rejection).resolves.toMatchObject({ message: "spawn failed" });
    await vi.advanceTimersByTimeAsync(1000);

    expect(find).not.toHaveBeenCalled();
    expect(child.signals).toStrictEqual(["SIGKILL"]);
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
      await expect(readFile(path.join(agentDir, "auth.json"))).rejects.toThrow(
        "ENOENT"
      );
      await expect(
        readFile(path.join(agentDir, "settings.json"), "utf-8")
      ).resolves.toBe("settings");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
