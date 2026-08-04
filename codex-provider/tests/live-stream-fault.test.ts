import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import { installTransportProbe } from "../scripts/live-multi-compaction.js";

const originalFetch = globalThis.fetch;
const originalWebSocket = Object.getOwnPropertyDescriptor(
  globalThis,
  "WebSocket"
);

describe("live stream-fault probe", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebSocket === undefined) {
      Reflect.deleteProperty(globalThis, "WebSocket");
    } else {
      Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
    }
  });

  it("cancels the faulted response independently while observing ordinary failures", async () => {
    let cancelled = false;
    let request = 0;
    globalThis.fetch = async () => {
      request += 1;
      if (request === 1) {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
            },
          })
        );
      }
      return new Response(
        'data: {"type":"response.failed","response":{"error":{"code":"ordinary_failure"}}}\n\n'
      );
    };
    const probe = installTransportProbe("sse", true, true);

    const faulted = await fetch("https://api.openai.com/v1/responses", {
      body: JSON.stringify({ input: [{ type: "compaction_trigger" }] }),
      method: "POST",
    });
    await expect(
      Promise.race([
        faulted.text(),
        delay(100).then(() => {
          throw new Error("fault timed out");
        }),
      ])
    ).rejects.toThrow("Injected client-side stream fault");

    const ordinary = await fetch("https://api.openai.com/v1/responses", {
      body: JSON.stringify({ input: [] }),
      method: "POST",
    });
    await ordinary.text();

    expect(cancelled).toBeTruthy();
    await expect(probe.failures()).resolves.toStrictEqual(["ordinary_failure"]);
  });
});
