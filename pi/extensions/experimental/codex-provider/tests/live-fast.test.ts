import { ok as assert } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { installWebSocketProbe } from "../scripts/live-fast.js";
import type { WireValue } from "./fixtures.js";

const packageRoot = path.resolve(import.meta.dirname, "..");

const invoke = (seed: string) => {
  const env = { ...process.env };
  delete env.CODEX_FAST_LIVE_PAID;
  return spawnSync("pnpm", ["run", "test:live:fast", "--", "--seed", seed], {
    cwd: packageRoot,
    encoding: "utf-8",
    env,
  });
};

describe("live fast runner", () => {
  it("keeps late messages with the sample that created the socket", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    class FakeWebSocket {
      static readonly instances: FakeWebSocket[] = [];
      readonly listeners = new Set<(event: { data: WireValue }) => void>();
      readonly sent: WireValue[] = [];

      constructor() {
        FakeWebSocket.instances.push(this);
      }

      addEventListener(type: string, listener: (event: { data: WireValue }) => void) {
        if (type === "message") {
          this.listeners.add(listener);
        }
      }

      emitMessage(data: WireValue) {
        for (const listener of this.listeners) {
          listener({ data });
        }
      }

      send(data: WireValue) {
        this.sent.push(data);
      }
    }
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: FakeWebSocket,
      writable: true,
    });
    let probe: ReturnType<typeof installWebSocketProbe> | undefined;

    try {
      probe = installWebSocketProbe();
      probe.begin();
      new WebSocket("ws://example.test");
      const firstSocket = FakeWebSocket.instances.at(-1);
      assert(firstSocket !== undefined);
      const first = await probe.finish();

      probe.begin();
      const delayed = Promise.withResolvers<string>();
      firstSocket.emitMessage(Object.assign(new Blob([]), { text: () => delayed.promise }));

      expect(first.pending).toHaveLength(1);
      delayed.resolve(
        JSON.stringify({
          response: {
            id: "late-first",
            service_tier: "default",
            status: "completed",
          },
          type: "response.completed",
        }),
      );
      await Promise.all(first.pending);
      const second = await probe.finish();

      expect(first.terminalResponses.map(({ responseId }) => responseId)).toStrictEqual([
        "late-first",
      ]);
      expect(second.terminalResponses).toStrictEqual([]);
    } finally {
      probe?.restore();
      if (original === undefined) {
        Reflect.deleteProperty(globalThis, "WebSocket");
      } else {
        Object.defineProperty(globalThis, "WebSocket", original);
      }
    }
  });

  it("accepts seed zero before enforcing the paid opt-in", () => {
    const result = invoke("0");
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("Paid live requests are disabled");
    expect(output).not.toContain("--seed must");
  });

  it("rejects values outside uint32", () => {
    const result = invoke("4294967296");
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("--seed must be an unsigned 32-bit integer");
  });
});
