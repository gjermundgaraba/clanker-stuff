import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { installTransportProbe } from "../scripts/live-multi-compaction.js";

const originalFetch = globalThis.fetch;
const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

describe("live stream-fault probe", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebSocket === undefined) {
      Reflect.deleteProperty(globalThis, "WebSocket");
    } else {
      Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
    }
  });

  it("observes multiline SSE failures across byte and CRLF boundaries without consuming the response", async () => {
    const body =
      ': heartbeat\r\ndata:{"type":"response.failed",\r\ndata: "response":{"error":{"code":"€_failure"}}}\r\n\r\ndata: [DONE]\r\n\r\n';
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const byte of Buffer.from(body)) {
              controller.enqueue(new Uint8Array([byte]));
            }
            controller.close();
          },
        }),
      );
    const probe = installTransportProbe("sse", true);

    const response = await fetch("https://api.openai.com/v1/responses");

    expect(await response.text()).toBe(body);
    await expect(probe.failures()).resolves.toStrictEqual(["€_failure"]);
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
          }),
        );
      }
      return new Response(
        'data: {"type":"response.failed","response":{"error":{"code":"ordinary_failure"}}}\n\n',
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
      ]),
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
