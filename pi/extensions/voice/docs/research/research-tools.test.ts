import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TargetAttachmentRegistry } from "./codex-runtime-recorder.mjs";

const temporaryDirectories: string[] = [];

const temporaryDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "voice-research-"));
  temporaryDirectories.push(directory);
  return directory;
};

const deferred = <Value>() => {
  let reject!: (error: unknown) => void;
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("TargetAttachmentRegistry", () => {
  it("claims overlapping polls once and clears a failed claim", async () => {
    const first = deferred<{ close: ReturnType<typeof vi.fn> }>();
    const secondClient = { close: vi.fn() };
    const attach = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(secondClient);
    const errors: unknown[] = [];
    const registry = new TargetAttachmentRegistry(attach, (error: unknown) => {
      errors.push(error);
    });
    const target = { id: "page-1", webSocketDebuggerUrl: "ws://first" };

    const firstClaim = registry.claim(target);
    const overlappingClaim = registry.claim(target);
    expect(firstClaim.claimed).toBe(true);
    expect(overlappingClaim.claimed).toBe(false);
    expect(overlappingClaim.promise).toBe(firstClaim.promise);

    const failure = new Error("attachment failed");
    first.reject(failure);
    await expect(firstClaim.promise).rejects.toBe(failure);
    await Promise.resolve();

    const retry = registry.claim(target);
    expect(retry.claimed).toBe(true);
    await retry.promise;
    expect(attach).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([failure]);
  });

  it("retires recreated IDs and closes an attachment that resolves after stop", async () => {
    const firstClient = { close: vi.fn() };
    const eventual = deferred<{ close: ReturnType<typeof vi.fn> }>();
    const eventualClient = { close: vi.fn() };
    const attach = vi
      .fn()
      .mockResolvedValueOnce(firstClient)
      .mockImplementationOnce(() => eventual.promise);
    const registry = new TargetAttachmentRegistry(attach, vi.fn());

    await registry.claim({
      id: "page-1",
      webSocketDebuggerUrl: "ws://first",
    }).promise;
    await Promise.resolve();
    const recreatedClaim = registry.claim({
      id: "page-1",
      webSocketDebuggerUrl: "ws://recreated",
    });
    expect(firstClient.close).toHaveBeenCalledOnce();

    registry.stop();
    eventual.resolve(eventualClient);
    await recreatedClaim.promise;
    await Promise.resolve();
    expect(eventualClient.close).toHaveBeenCalledOnce();
  });

  it("does not report a failed attachment after target ownership moves", async () => {
    const superseded = deferred<{ close: ReturnType<typeof vi.fn> }>();
    const replacementClient = { close: vi.fn() };
    const attach = vi
      .fn()
      .mockImplementationOnce(() => superseded.promise)
      .mockResolvedValueOnce(replacementClient);
    const onAttachError = vi.fn();
    const registry = new TargetAttachmentRegistry(attach, onAttachError);

    const first = registry.claim({
      id: "page-1",
      webSocketDebuggerUrl: "ws://first",
    });
    const replacement = registry.claim({
      id: "page-1",
      webSocketDebuggerUrl: "ws://replacement",
    });
    superseded.reject(new Error("old attachment failed"));

    await expect(first.promise).rejects.toThrow("old attachment failed");
    await replacement.promise;
    await Promise.resolve();
    expect(onAttachError).not.toHaveBeenCalled();
  });
});

describe("Pi capture extraction", () => {
  it("publishes a private fresh snapshot and preserves it after a failed refresh", () => {
    const captureDirectory = temporaryDirectory();
    const evidenceDirectory = path.join(captureDirectory, "evidence");
    mkdirSync(evidenceDirectory, { mode: 0o700 });
    writeFileSync(path.join(evidenceDirectory, "stale-user-file"), "keep out");

    const callRequest = {
      detail: {
        body: { session: { instructions: "test prompt" } },
        requestId: "request-1",
      },
      kind: "realtime.call.request",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(
      path.join(captureDirectory, "voice.ndjson"),
      `${JSON.stringify(callRequest)}\n`
    );
    writeFileSync(
      path.join(captureDirectory, "pi.ndjson"),
      `${JSON.stringify({
        detail: { request: "test" },
        kind: "before_provider_request",
        timestamp: "2026-01-01T00:00:01.000Z",
      })}\n`
    );

    const extractor = path.join(import.meta.dirname, "extract-pi-capture.mjs");
    const result = spawnSync(process.execPath, [extractor, captureDirectory], {
      encoding: "utf-8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ evidenceDirectory });
    expect(readdirSync(evidenceDirectory)).not.toContain("stale-user-file");
    expect(statSync(evidenceDirectory).mode & 0o777).toBe(0o700);

    const sums = readFileSync(
      path.join(evidenceDirectory, "SHA256SUMS"),
      "utf-8"
    ).trim();
    for (const line of sums.split("\n")) {
      const [expectedHash, name] = line.split("  ");
      const file = path.join(evidenceDirectory, name);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(
        createHash("sha256").update(readFileSync(file)).digest("hex")
      ).toBe(expectedHash);
    }
    const priorRequest = readFileSync(
      path.join(evidenceDirectory, "realtime-call-request.json"),
      "utf-8"
    );

    writeFileSync(path.join(captureDirectory, "voice.ndjson"), "{bad json\n");
    const failedRefresh = spawnSync(
      process.execPath,
      [extractor, captureDirectory],
      { encoding: "utf-8" }
    );
    expect(failedRefresh.status).not.toBe(0);
    expect(
      readFileSync(
        path.join(evidenceDirectory, "realtime-call-request.json"),
        "utf-8"
      )
    ).toBe(priorRequest);
    expect(
      readdirSync(captureDirectory).filter((name) =>
        name.startsWith(".evidence-tmp-")
      )
    ).toEqual([]);
  });
});

describe("Codex capture extraction", () => {
  it("replaces stale evidence with the generated snapshot", () => {
    const captureDirectory = temporaryDirectory();
    const evidenceDirectory = path.join(captureDirectory, "evidence");
    mkdirSync(evidenceDirectory, { mode: 0o700 });
    writeFileSync(path.join(evidenceDirectory, "stale-user-file"), "keep out");

    writeFileSync(
      path.join(captureDirectory, "app-server-1.rpc.ndjson"),
      `${JSON.stringify({
        message: { method: "thread/realtime/start", params: {} },
        timestamp: "2026-01-01T00:00:00.000Z",
      })}\n`
    );
    writeFileSync(
      path.join(captureDirectory, "renderer.ndjson"),
      `${JSON.stringify({
        detail: { data: JSON.stringify({ type: "session.started" }) },
        kind: "data-channel-received",
        timestamp: "2026-01-01T00:00:01.000Z",
      })}\n`
    );
    writeFileSync(
      path.join(captureDirectory, "app-server-1.stderr.bin"),
      `${JSON.stringify({
        fields: {
          message:
            'POST to https://chatgpt.com/backend-api/codex/realtime/calls: {"session":{"instructions":"test prompt"}}',
        },
        timestamp: "2026-01-01T00:00:02.000Z",
      })}\n`
    );

    const result = spawnSync(
      process.execPath,
      [
        path.join(import.meta.dirname, "extract-codex-capture.mjs"),
        captureDirectory,
      ],
      { encoding: "utf-8" }
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      evidenceDirectory,
      valid: true,
    });
    expect(readdirSync(evidenceDirectory)).not.toContain("stale-user-file");
    expect(readdirSync(evidenceDirectory)).toEqual(
      expect.arrayContaining(["RAW_SHA256SUMS", "SHA256SUMS"])
    );
    expect(statSync(evidenceDirectory).mode & 0o777).toBe(0o700);
  });
});
