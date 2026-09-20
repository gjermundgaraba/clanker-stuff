import { normalizeContext } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CodexObservability } from "../observability.js";
import { createCodexProviderRuntime } from "../provider.js";
import { makeCodexApiKey, responseEvents, SPIKE_MODEL, sse } from "./fixtures.js";

const RoutingFrameSchema = Type.Object({
  generate: Type.Optional(Type.Boolean()),
  client_metadata: Type.Optional(Type.Record(Type.String(), Type.String())),
  previous_response_id: Type.Optional(Type.String()),
});

type RoutingFrame = Static<typeof RoutingFrameSchema>;

const context = normalizeContext({
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
});

const compactionEvents = [
  { type: "response.created", response: { id: "compact", status: "in_progress" } },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: { type: "compaction", encrypted_content: "opaque" },
  },
  {
    type: "response.completed",
    response: {
      id: "compact",
      status: "completed",
      output: [],
      usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
    },
  },
];

afterEach(() => vi.unstubAllGlobals());

describe("Codex account ownership", () => {
  for (const terminal of ["inference", "mid-turn", "standalone"] as const) {
    it(`clears sticky HTTP routing on owner changes before ${terminal} while retaining same-owner refresh`, async () => {
      const observations = new CodexObservability(":memory:");
      const runtime = createCodexProviderRuntime(observations);
      vi.stubGlobal("WebSocket", undefined);
      const headers: Headers[] = [];
      let responseIndex = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: Parameters<typeof fetch>[0], init: RequestInit) => {
          headers.push(new Headers(init.headers));
          responseIndex += 1;

          const response = sse(
            responseIndex === 3 && terminal !== "inference"
              ? compactionEvents
              : responseEvents(`response-${responseIndex}`, "ok"),
          );

          response.headers.set("x-codex-turn-state", `sticky-${responseIndex}`);

          return response;
        }),
      );
      const account = makeCodexApiKey("account-a");
      runtime.beginTurn("session");
      const window = runtime.getWindow("session");

      const first = await runtime.provider
        .streamSimple(SPIKE_MODEL, context, {
          apiKey: account,
          sessionId: "session",
          transport: "sse",
        })
        .result();

      expect(first.stopReason).toBe("stop");
      const refreshed = `${account.slice(0, account.lastIndexOf("."))}.rotated-signature`;

      const second = await runtime.provider
        .streamSimple(SPIKE_MODEL, context, {
          apiKey: refreshed,
          sessionId: "session",
          transport: "sse",
        })
        .result();

      expect(second.stopReason).toBe("stop");

      if (terminal === "inference") {
        expect(
          (
            await runtime.provider
              .streamSimple(SPIKE_MODEL, context, {
                apiKey: makeCodexApiKey("account-b"),
                sessionId: "session",
                transport: "sse",
              })
              .result()
          ).stopReason,
        ).toBe("stop");
      } else {
        await runtime.compact({
          apiKey: makeCodexApiKey("account-b"),
          model: SPIKE_MODEL,
          context,
          sessionId: "session",
          signal: new AbortController().signal,
          inputPrefix: [],
          effectiveTokenLimit: 1000,
          reason: "manual",
          phase: terminal,
          thinkingLevel: "low",
        });
      }

      expect(headers.map((value) => value.get("chatgpt-account-id"))).toEqual([
        "account-a",
        "account-a",
        "account-b",
      ]);
      expect(headers.map((value) => value.get("x-codex-turn-state"))).toEqual([
        null,
        "sticky-1",
        null,
      ]);
      expect(runtime.getWindow("session")).toEqual(window);
      runtime.closeSession("session");
      observations.close();
    });
  }

  it("resets WebSocket handshake and prewarm routing on owner switches while preserving same-owner refresh routing", async () => {
    const observations = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observations);
    const handshakes: Headers[] = [];
    const frames: RoutingFrame[] = [];
    let closes = 0;
    vi.stubGlobal(
      "WebSocket",
      function WebSocket(_url: string, options: { headers: Record<string, string> }) {
        const headers = new Headers(options.headers);
        handshakes.push(headers);

        const socket = Object.assign(new EventTarget(), {
          readyState: 1,
          close() {
            closes += 1;
            socket.readyState = 3;
          },
          send(data: string) {
            const frame: unknown = JSON.parse(data);

            if (!Value.Check(RoutingFrameSchema, frame)) throw new Error("Invalid routing frame");
            frames.push(frame);

            const events = responseEvents(
              `response-${frames.length}`,
              frame.generate === false ? "" : "ok",
            );

            const raw =
              frame.generate === false
                ? events
                : [
                    {
                      type: "response.metadata",
                      headers: {
                        "x-codex-turn-state": `owned-${headers.get("chatgpt-account-id")}`,
                      },
                    },
                    ...events,
                  ];

            for (const event of raw)
              queueMicrotask(() =>
                socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })),
              );
          },
        });

        queueMicrotask(() => socket.dispatchEvent(new Event("open")));

        return socket;
      },
    );
    const key = makeCodexApiKey("account-a");
    const refreshed = `${key.slice(0, key.lastIndexOf("."))}.new-signature`;

    try {
      for (const apiKey of [key, refreshed, makeCodexApiKey("account-b")]) {
        expect(
          (
            await runtime.provider
              .streamSimple(SPIKE_MODEL, context, {
                apiKey,
                sessionId: "session",
                transport: "websocket",
              })
              .result()
          ).stopReason,
        ).toBe("stop");
      }

      expect(handshakes.map((headers) => headers.get("x-codex-turn-state"))).toEqual([
        null,
        "owned-account-a",
        null,
      ]);
      expect(frames.map((frame) => frame.generate === false)).toEqual([
        true,
        false,
        false,
        true,
        false,
      ]);
      expect(
        frames.slice(-2).map((frame) => frame.client_metadata?.["x-codex-turn-state"]),
      ).toEqual([undefined, undefined]);
      expect(frames.at(-1)).not.toHaveProperty("previous_response_id");
      expect(closes).toBe(2);
    } finally {
      runtime.closeSession("session");
      observations.close();
    }
  });

  it("does not let a late old-account HTTP header reinstate routing for the new owner", async () => {
    const observations = new CodexObservability(":memory:");
    const runtime = createCodexProviderRuntime(observations);
    const oldReply = Promise.withResolvers<Response>();
    const headers: Headers[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: Parameters<typeof fetch>[0], init: RequestInit) => {
        headers.push(new Headers(init.headers));

        if (headers.length === 1) return await oldReply.promise;

        return sse(responseEvents(`new-${headers.length}`, "ok"));
      }),
    );

    const old = runtime.provider.streamSimple(SPIKE_MODEL, context, {
      apiKey: makeCodexApiKey("a"),
      sessionId: "session",
      transport: "sse",
    });

    await vi.waitFor(() => expect(headers).toHaveLength(1));
    await runtime.provider
      .streamSimple(SPIKE_MODEL, context, {
        apiKey: makeCodexApiKey("b"),
        sessionId: "session",
        transport: "sse",
      })
      .result();
    const oldResponse = sse(responseEvents("old", "ok"));
    oldResponse.headers.set("x-codex-turn-state", "old-account-sticky");
    oldReply.resolve(oldResponse);
    await old.result();
    await runtime.provider
      .streamSimple(SPIKE_MODEL, context, {
        apiKey: makeCodexApiKey("b"),
        sessionId: "session",
        transport: "sse",
      })
      .result();
    expect(headers[2]?.get("x-codex-turn-state")).toBeNull();
    runtime.closeSession("session");
    observations.close();
  });
});
