import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";

import { describe, expect, it, vi } from "vite-plus/test";

import { parseSseEvents } from "../sse.js";

const collect = <T>(values: AsyncIterable<T>) => Readable.from(values).toArray();

const responseChunks = (chunks: readonly Uint8Array[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }

        controller.close();
      },
    }),
  );

describe("SSE framing", () => {
  it.each(["\n", "\r\n", "\r"])("parses multiline data and comments with %j", async (newline) => {
    const wire = [
      ": keepalive",
      "event: ignored",
      "id: ignored",
      'data: {"type":',
      'data: "response.done"}',
      "",
      "data:",
      "",
      "data: [DONE]",
      "",
      "",
    ].join(newline);

    expect(await collect(parseSseEvents(new Response(wire)))).toStrictEqual([
      { type: "response.done" },
    ]);
  });

  it("handles every UTF-8 and CRLF chunk boundary", async () => {
    const wire = Buffer.from('data: {"text":"é 🦄"}\r\n\r\ndata: {"type":"response.done"}\r\n\r\n');

    for (let offset = 0; offset <= wire.length; offset += 1) {
      const response = responseChunks([wire.subarray(0, offset), wire.subarray(offset)]);
      expect(await collect(parseSseEvents(response))).toStrictEqual([
        { text: "é 🦄" },
        { type: "response.done" },
      ]);
    }
  });

  it.each(["", "\n", "\r\n", "\n\n"])("retains a final event ending in %j", async (ending) => {
    const response = new Response(`data: {"type":"response.done"}${ending}`);
    expect(await collect(parseSseEvents(response))).toStrictEqual([{ type: "response.done" }]);
  });

  it.each(["[]", "null", "42", '"text"'])("rejects non-object data %s", async (data) => {
    await expect(collect(parseSseEvents(new Response(`data: ${data}\n\n`)))).rejects.toThrow(
      "Codex stream event must be an object",
    );
  });

  it("rejects malformed JSON and missing response bodies", async () => {
    await expect(collect(parseSseEvents(new Response("data: {\n\n")))).rejects.toThrow(SyntaxError);
    await expect(collect(parseSseEvents(new Response(null)))).rejects.toThrow(
      "Codex response has no body",
    );
  });

  it.each([true, false])(
    "cancels an open body when aborted (already aborted: %s)",
    async (alreadyAborted) => {
      const signal = new AbortController();
      const cancel = vi.fn();
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }));

      if (alreadyAborted) signal.abort();
      const reading = collect(parseSseEvents(response, signal.signal));

      if (!alreadyAborted) signal.abort();
      await expect(reading).rejects.toThrow("Request was aborted");
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    },
  );

  it("cancels upstream when the consumer stops early", async () => {
    const cancel = vi.fn();

    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('data: {"type":"response.done"}\n\n'));
        },
        cancel,
      }),
    );

    const iterator = parseSseEvents(response);
    expect((await iterator.next()).value).toStrictEqual({ type: "response.done" });
    await iterator.return(undefined);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("does not deliver queued events after abort", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();

    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(
            Buffer.from('data: {"type":"response.created"}\n\ndata: {"type":"response.done"}\n\n'),
          );
        },
        cancel,
      }),
    );

    const iterator = parseSseEvents(response, controller.signal);
    expect((await iterator.next()).value).toStrictEqual({ type: "response.created" });
    controller.abort();
    await expect(iterator.next()).rejects.toThrow("Request was aborted");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("propagates body errors rather than flushing incomplete events", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('data: {"type":"response.done"}'));
          controller.error(new Error("body failed"));
        },
      }),
    );

    await expect(collect(parseSseEvents(response))).rejects.toThrow("body failed");
  });

  it("delivers complete events before a later body read fails", async () => {
    const events = [
      { type: "response.created" },
      { delta: "partial output", type: "response.output_text.delta" },
    ];

    let sent = false;

    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(
              Buffer.from(
                events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
                  'data: {"type":"response.done"}',
              ),
            );
          } else {
            controller.error(new Error("body failed after output"));
          }
        },
      }),
    );

    const iterator = parseSseEvents(response);

    for (const event of events) {
      await expect(iterator.next()).resolves.toStrictEqual({ done: false, value: event });
      await setImmediate();
    }

    await expect(iterator.next()).rejects.toThrow("body failed after output");
  });
});
