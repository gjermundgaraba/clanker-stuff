import { zstdDecompressSync } from "node:zlib";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getEncoding } from "js-tiktoken";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CodexObservability } from "../observability.js";
import { createCodexProviderRuntime } from "../provider.js";
import { CodexSamplingBound } from "../sampling-bound.js";
import { responseEvents, SPIKE_API_KEY, SPIKE_MODEL, wireRecord } from "./fixtures.js";

const model = {
  ...SPIKE_MODEL,
  id: "gpt-5.6-sol",
  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.5 },
};

const context: Context = { messages: [{ role: "user", content: "server input", timestamp: 0 }] };

const tokenizer = getEncoding("o200k_base");

const textOf = (message: AssistantMessage) =>
  message.content.map((part) => (part.type === "text" ? part.text : "")).join("");

const usage = {
  input_tokens: 14,
  output_tokens: 9,
  total_tokens: 23,
  output_tokens_details: { reasoning_tokens: 4 },
};

const fixture = async (fast = false) => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openai-codex", async () => ({ type: "api_key", key: SPIKE_API_KEY }));

  const models = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  });

  const registry = new ModelRegistry(models);
  const observations = new CodexObservability(":memory:");
  const runtime = createCodexProviderRuntime(observations, () => fast);
  registry.registerProvider(runtime.provider);
  const auth = await registry.getApiKeyAndHeaders(model);

  if (!auth.ok) throw new Error(auth.error);
  const provider = registry.getProvider(model.provider);

  if (!provider) throw new Error("Registry provider missing");

  return {
    runtime,
    observations,
    stream: (options: SimpleStreamOptions = {}) =>
      provider.streamSimple(model, context, { ...auth, ...options }),
  };
};

type Transport = "sse" | "websocket";

const transportFixture = (transport: Transport, events: readonly unknown[]) => {
  let canceled = false;
  let signal: AbortSignal | null | undefined;
  const frames: unknown[] = [];
  let emitLate: (() => void) | undefined;

  if (transport === "sse") {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: Parameters<typeof fetch>[0], init: RequestInit) => {
        signal = init.signal;
        const headers = new Headers(init.headers);

        // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Transport fixture distinguishes text from compressed bytes before inspecting emitted requests.
        if (typeof init.body === "string") frames.push(JSON.parse(init.body));
        else if (init.body instanceof Uint8Array && headers.get("content-encoding") === "zstd")
          frames.push(JSON.parse(zstdDecompressSync(init.body).toString("utf8")));
        let index = 0;

        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (index < events.length) {
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(events[index++])}\n\n`),
                );
              } else if (
                events.some((event) =>
                  ["response.done", "response.completed"].includes(String(wireRecord(event).type)),
                )
              ) {
                controller.close();
              }
            },
            cancel() {
              canceled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
  } else {
    vi.stubGlobal("WebSocket", function WebSocket() {
      const value = Object.assign(new EventTarget(), {
        readyState: 1,
        close() {
          canceled = true;
          this.readyState = 3;
          value.dispatchEvent(new Event("close"));
        },
        send(data: string) {
          const frame = wireRecord(JSON.parse(data));
          frames.push(frame);
          const output = frame.generate === false ? responseEvents("prewarm", "") : events;

          for (const event of output)
            queueMicrotask(() =>
              value.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })),
            );
          emitLate = () =>
            value.dispatchEvent(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "response.output_text.delta",
                  delta: "late",
                  output_index: 0,
                }),
              }),
            );
        },
      });

      queueMicrotask(() => value.dispatchEvent(new Event("open")));

      return value;
    });
  }

  return {
    frames,
    get canceled() {
      return canceled;
    },
    get signal() {
      return signal;
    },
    late() {
      emitLate?.();
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("registry-backed isolated Codex sampling", () => {
  it("rejects unknown tokenizers and invalid budgets before inference", () => {
    expect(() => new CodexSamplingBound({ ...model, id: "gpt-6-astra" }, 10)).toThrow(
      "No verified",
    );

    for (const budget of [0, -1, 1.2, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      expect(() => new CodexSamplingBound(model, budget)).toThrow("positive safe integer");
    expect(new CodexSamplingBound({ ...model, maxTokens: 5 }, 100).maxTokens).toBe(5);
  });

  it("revalidates a stop-sequence prefix whose BPE count exceeds the original text", () => {
    const bound = new CodexSamplingBound(model, 1);
    expect(tokenizer.encode("interesting")).toHaveLength(1);
    expect(tokenizer.encode("interestin")).toHaveLength(2);
    const converted = bound.boundText("interestin");
    expect("interestin".startsWith(converted)).toBeTruthy();
    expect(tokenizer.encode(converted)).toHaveLength(1);
  });

  for (const transport of ["sse", "websocket"] as const) {
    it.each([-1, 0.5, "0", null])(
      `${transport}: rejects malformed sampling indexes %j`,
      async (outputIndex) => {
        const { runtime, observations, stream } = await fixture();

        const events = responseEvents("malformed-index", "text").map((event) => {
          const record = wireRecord(event);

          return record.type === "response.output_text.delta"
            ? { ...record, output_index: outputIndex }
            : event;
        });

        transportFixture(transport, events);
        const scope = runtime.createSamplingScope(model, 64);

        try {
          const result = await scope.run(() => stream({ transport })).result();
          expect(result.stopReason).toBe("error");
          expect(result.errorMessage).toContain("Malformed sampling event envelope");
          expect(textOf(result)).toBe("");
        } finally {
          await scope.dispose();
          observations.close();
        }
      },
    );

    for (const fast of [false, true]) {
      for (const responseTier of [undefined, "default", "priority", "flex"] as const) {
        it(`${transport}: ${fast ? "Fast" : "standard"} sampling and ordinary usage agree for ${responseTier ?? "missing"} response tier`, async () => {
          const { runtime, observations, stream } = await fixture(fast);

          const reportedUsage = {
            input_tokens: 14,
            input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
            output_tokens: 9,
            output_tokens_details: { reasoning_tokens: 4 },
            total_tokens: 23,
          };

          const raw = responseEvents("sample", "ok");
          const terminal = wireRecord(raw.at(-1));

          const transportState = transportFixture(transport, [
            ...raw.slice(0, -1),
            {
              ...terminal,
              response: {
                ...wireRecord(terminal.response),
                usage: reportedUsage,
                service_tier: responseTier,
              },
            },
          ]);

          const scope = runtime.createSamplingScope(model, 20);

          try {
            const ordinary = await stream({ transport, sessionId: "ordinary" }).result();
            const sample = await scope.run(() => stream({ transport })).result();
            expect(ordinary.stopReason).toBe("stop");
            expect(sample.stopReason).toBe("stop");
            expect(textOf(sample)).toBe("ok");
            expect(scope.status.usageComplete).toBe(true);
            expect(scope.status.usage).toEqual(sample.usage);
            expect(sample.usage).toEqual(ordinary.usage);

            const multiplier =
              responseTier === "flex" ? 0.5 : responseTier === "priority" || fast ? 2 : 1;

            const costs = { input: 9, output: 18, cacheRead: 1.5, cacheWrite: 3, total: 31.5 };

            for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
              expect(scope.status.usage?.cost[key]).toBeCloseTo(
                (costs[key] * multiplier) / 1_000_000,
                12,
              );

            for (const frame of transportState.frames)
              expect(wireRecord(frame).service_tier).toBe(fast ? "priority" : undefined);
          } finally {
            await scope.dispose();
            runtime.closeSession("ordinary");
            observations.close();
          }
        });
      }

      it(`${transport}: ${fast ? "Fast" : "standard"} output-limit termination preserves priced partial usage`, async () => {
        const { runtime, observations, stream } = await fixture(fast);
        const raw = responseEvents("sample", "one two three four five six seven");
        transportFixture(transport, [
          raw[0],
          { type: "response.in_progress", response: { usage } },
          ...raw.slice(1),
        ]);
        const scope = runtime.createSamplingScope(model, 2);

        try {
          const result = await scope.run(() => stream({ transport })).result();
          expect(result.stopReason).toBe("length");
          expect(scope.status).toMatchObject({ usageComplete: false, limitReached: true });
          expect(scope.status.usage).toEqual(result.usage);
          expect(result.usage.cost.total).toBeCloseTo((fast ? 64 : 32) / 1_000_000, 12);
        } finally {
          await scope.dispose();
          expect(runtime.samplingDiagnostics()).toEqual({
            scopes: 0,
            sessions: 0,
            sockets: 0,
            timers: 0,
          });
          observations.close();
        }
      });
    }

    it(`${transport}: retains buffered Unicode deltas and the final partial batch`, async () => {
      const { runtime, observations, stream } = await fixture();
      const text = "interesting 世界 👩🏽‍💻 ".repeat(100);
      const raw = responseEvents("sample", text);
      transportFixture(transport, [
        ...raw.slice(0, 2),
        ...text.split("").map((delta) => ({ ...raw[2], delta })),
        ...raw.slice(3),
      ]);
      const scope = runtime.createSamplingScope(model, 4096);

      try {
        const result = await scope.run(() => stream({ transport })).result();
        expect(result.stopReason).toBe("stop");
        expect(textOf(result)).toBe(text);
        expect(scope.status).toMatchObject({ usageComplete: true, limitReached: false });
      } finally {
        await scope.dispose();
        observations.close();
      }
    });

    it(`${transport}: bounds authoritative completed text, refusals and multiple Unicode content items`, async () => {
      const { runtime, observations, stream } = await fixture();

      const samples = [
        ["hello", " 世界 👩🏽‍💻".repeat(30)],
        ["a", "bc def ghi jkl mno pqr stu"],
        ["é", "👩🏽‍💻世界".repeat(30)],
      ];

      for (const [first, second] of samples) {
        const events = [
          ...responseEvents("one", first!).slice(0, 4),
          {
            type: "response.output_item.done",
            output_index: 1,
            item: {
              type: "message",
              id: "msg-two",
              role: "assistant",
              content: [{ type: "refusal", refusal: second }],
            },
          },
        ];

        transportFixture(transport, events);
        const scope = runtime.createSamplingScope(model, 4);

        try {
          const result = await scope.run(() => stream({ transport })).result();
          expect(result.stopReason).toBe("length");
          expect(tokenizer.encode(textOf(result), [], []).length).toBeLessThanOrEqual(4);
          expect(textOf(result)).not.toContain("\uFFFD");
          expect(result.content.every((part) => part.type === "text")).toBeTruthy();
        } finally {
          await scope.dispose();
        }
      }

      observations.close();
    });
    it(`${transport}: bounds oversized chunked UTF-8 output, aborts upstream, retains partial reported usage`, async () => {
      const { runtime, observations, stream } = await fixture();
      runtime.beginTurn("ordinary-pi-session");
      const baseline = runtime.samplingDiagnostics();
      const raw = responseEvents("sample", "hello 世界 👩🏽‍💻 ".repeat(30));

      const transportState = transportFixture(transport, [
        raw[0],
        { type: "response.in_progress", response: { usage } },
        raw[1],
        { type: "response.reasoning_text.delta", output_index: 1, delta: "hidden".repeat(20) },
        { type: "response.output_text.delta", output_index: 0, delta: "hello" },
        raw[2],
        raw[3],
        raw[4],
      ]);

      const scope = runtime.createSamplingScope(model, 6);

      try {
        const result = await scope.run(() => stream({ transport, timeoutMs: 30_000 })).result();
        expect(result.stopReason).toBe("length");
        expect(tokenizer.encode(textOf(result), [], []).length).toBeLessThanOrEqual(6);
        expect(textOf(result).length).toBeGreaterThan(0);
        expect(result.content.every((part) => part.type === "text")).toBeTruthy();
        expect(result.usage).toMatchObject({ input: 14, output: 9, reasoning: 4, totalTokens: 23 });
        expect(scope.status).toMatchObject({
          limitReached: true,
          usageComplete: false,
          usage: { output: 9 },
        });
        expect(transportState.canceled).toBeTruthy();

        if (transport === "sse") expect(transportState.signal?.aborted).toBeTruthy();

        for (const frame of transportState.frames)
          expect(frame).not.toHaveProperty("max_output_tokens");
      } finally {
        await scope.dispose();
        observations.close();
      }

      transportState.late();
      await Promise.resolve();
      expect(runtime.samplingDiagnostics()).toEqual(baseline);
      expect(runtime.getWindow("ordinary-pi-session")).toBeDefined();
    });

    it(`${transport}: repeated success, failures, caller abort, disposal and conversion failures release supplied and automatic identities`, async () => {
      const { runtime, observations, stream } = await fixture();
      runtime.beginTurn("ordinary");
      const baseline = runtime.samplingDiagnostics();

      for (const id of [undefined, "sampling-id"]) {
        for (const scenario of ["success", "failure", "abort", "dispose", "conversion"] as const) {
          const raw = responseEvents("sample", "ok");

          const events =
            scenario === "failure"
              ? [
                  ...raw.slice(0, 2),
                  {
                    type: "response.failed",
                    response: { status: "failed", usage, error: { message: "fixture failed" } },
                  },
                ]
              : scenario === "abort" || scenario === "dispose"
                ? raw.slice(0, 2)
                : raw;

          transportFixture(transport, events);
          const caller = new AbortController();
          const scope = runtime.createSamplingScope(model, 30);
          let result: AssistantMessage | undefined;

          try {
            const running = scope.run(() =>
              stream({
                transport,
                ...(id !== undefined ? { sessionId: id } : {}),
                signal: caller.signal,
                timeoutMs: 1000,
              }),
            );

            if (scenario === "abort" || scenario === "dispose") {
              for await (const event of running) {
                if (event.type === "start") {
                  if (scenario === "abort") caller.abort();
                  else void scope.dispose();
                  break;
                }
              }
            }

            result = await running.result();

            if (scenario === "conversion") throw new Error("conversion failed");
          } catch (error) {
            expect(scenario).toBe("conversion");
            expect(String(error)).toContain("conversion failed");
          } finally {
            await scope.dispose();
          }

          expect(result?.stopReason).toBe(
            scenario === "failure"
              ? "error"
              : scenario === "abort" || scenario === "dispose"
                ? "aborted"
                : "stop",
          );

          if (scenario === "success")
            expect(scope.status).toMatchObject({
              usageComplete: true,
              usage: { input: 8, output: 2 },
            });

          if (scenario === "failure")
            expect(scope.status).toMatchObject({
              usageComplete: false,
              usage: { input: 14, output: 9 },
            });
          expect(runtime.samplingDiagnostics()).toEqual(baseline);
          expect(() => scope.run(() => stream({ transport }))).toThrow("disposed");
        }
      }

      observations.close();
    });
  }

  it("keeps missing terminal usage incomplete instead of promoting an earlier partial report", async () => {
    const { runtime, observations, stream } = await fixture();
    const raw = responseEvents("sample", "ok");
    const terminal = wireRecord(raw.at(-1));
    const response = { ...wireRecord(terminal.response) };
    delete response.usage;
    transportFixture("sse", [
      raw[0],
      { type: "response.in_progress", response: { usage } },
      ...raw.slice(1, -1),
      { ...terminal, response },
    ]);
    const scope = runtime.createSamplingScope(model, 20);

    try {
      expect((await scope.run(() => stream({ transport: "sse" })).result()).stopReason).toBe(
        "stop",
      );
      expect(scope.status).toMatchObject({ usageComplete: false, usage: { input: 14, output: 9 } });
    } finally {
      await scope.dispose();
      observations.close();
    }
  });

  it("preserves the ordinary Pi cached socket while a sampling scope closes its own idle socket and timer", async () => {
    const { runtime, observations, stream } = await fixture();
    vi.useFakeTimers();
    transportFixture("websocket", responseEvents("sample", "ok"));
    await stream({ transport: "websocket", sessionId: "ordinary" }).result();
    const baseline = runtime.samplingDiagnostics();
    const timers = vi.getTimerCount();
    expect(baseline.sockets).toBe(1);
    expect(baseline.timers).toBe(1);
    const scope = runtime.createSamplingScope(model, 20);
    await scope.run(() => stream({ transport: "websocket" })).result();
    expect(runtime.samplingDiagnostics().sockets).toBe(2);
    await scope.dispose();
    expect(runtime.samplingDiagnostics()).toEqual(baseline);
    expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(runtime.samplingDiagnostics().sockets).toBe(0);
    runtime.closeSession("ordinary");
    observations.close();
  });

  it("settles WebSocket handshake cancellation and ignores late Blob decoding without rearming timers", async () => {
    const { runtime, observations, stream } = await fixture();
    vi.useFakeTimers();
    const baseline = runtime.samplingDiagnostics();
    const timerBaseline = vi.getTimerCount();
    let socket: EventTarget | undefined;
    const created = Promise.withResolvers<void>();
    vi.stubGlobal("WebSocket", function WebSocket() {
      socket = Object.assign(new EventTarget(), { readyState: 0, send() {}, close() {} });
      created.resolve();

      return socket;
    });
    const connecting = runtime.createSamplingScope(model, 20);
    const opening = connecting.run(() => stream({ transport: "websocket" }));
    await created.promise;
    expect(vi.getTimerCount()).toBeGreaterThan(timerBaseline);
    await connecting.dispose();
    expect((await opening.result()).stopReason).toBe("aborted");
    expect(vi.getTimerCount()).toBe(timerBaseline);
    expect(runtime.samplingDiagnostics()).toEqual(baseline);

    const decoded = Promise.withResolvers<string>();
    const submitted = Promise.withResolvers<void>();

    class LateBlob extends Blob {
      override text() {
        return decoded.promise;
      }
    }

    vi.stubGlobal("WebSocket", function WebSocket() {
      const value = Object.assign(new EventTarget(), {
        readyState: 1,
        close() {},
        send(data: string) {
          const frame = wireRecord(JSON.parse(data));

          if (frame.generate === false) {
            for (const event of responseEvents("prewarm", ""))
              queueMicrotask(() =>
                value.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })),
              );
          } else {
            queueMicrotask(() => {
              value.dispatchEvent(new MessageEvent("message", { data: new LateBlob() }));
              submitted.resolve();
            });
          }
        },
      });

      queueMicrotask(() => value.dispatchEvent(new Event("open")));

      return value;
    });
    const late = runtime.createSamplingScope(model, 20);
    const pending = late.run(() => stream({ transport: "websocket", timeoutMs: 1000 }));
    await submitted.promise;
    await late.dispose();
    expect((await pending.result()).stopReason).toBe("aborted");
    decoded.resolve(
      JSON.stringify({ type: "response.output_text.delta", output_index: 0, delta: "late" }),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(timerBaseline);
    expect(runtime.samplingDiagnostics()).toEqual(baseline);
    observations.close();
  });

  it("isolates overlapping requests and prevents disposal before delayed registry dispatch from recreating state", async () => {
    const { runtime, observations, stream } = await fixture();
    const baseline = runtime.samplingDiagnostics();
    transportFixture("sse", responseEvents("sample", "ok"));
    const first = runtime.createSamplingScope(model, 20);
    const second = runtime.createSamplingScope(model, 20);
    const stream1 = first.run(() => stream({ transport: "sse" }));
    expect(() => first.run(() => stream({ transport: "sse" }))).toThrow("exactly one");
    const stream2 = second.run(() => stream({ transport: "sse" }));
    await stream1.result();
    const disposal = first.dispose();
    expect(first.dispose()).toBe(disposal);
    await disposal;
    expect(runtime.samplingDiagnostics().scopes).toBe(1);
    expect((await stream2.result()).stopReason).toBe("stop");
    await second.dispose();
    const delayed = runtime.createSamplingScope(model, 20);
    const gate = Promise.withResolvers<void>();

    const late = delayed.run(async () => {
      await gate.promise;

      return stream({ transport: "sse" });
    });

    await delayed.dispose();
    gate.resolve();
    await expect(late).rejects.toThrow("disposed");
    expect(runtime.samplingDiagnostics()).toEqual(baseline);
    observations.close();
  });

  it("rejects collisions with an ordinary session and unsupported input without touching its state", async () => {
    const { runtime, observations, stream } = await fixture();
    runtime.beginTurn("ordinary");
    const baseline = runtime.samplingDiagnostics();
    const scope = runtime.createSamplingScope(model, 20);

    try {
      expect(() => scope.run(() => stream({ sessionId: "ordinary" }))).toThrow("collides");
    } finally {
      await scope.dispose();
    }

    expect(runtime.samplingDiagnostics()).toEqual(baseline);
    const images = runtime.createSamplingScope(model, 20);

    try {
      expect(() =>
        images.run(() =>
          runtime.provider.streamSimple(
            model,
            {
              messages: [
                {
                  role: "user",
                  content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
                  timestamp: 0,
                },
              ],
            },
            { apiKey: SPIKE_API_KEY },
          ),
        ),
      ).toThrow("text messages");
    } finally {
      await images.dispose();
    }

    expect(runtime.samplingDiagnostics()).toEqual(baseline);
    observations.close();
  });
});
