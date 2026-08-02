import { describe, expect, it, vi } from "vitest";

import { collectCompactionSse } from "../remote.js";

const event = (value: unknown, ending = "\n") =>
  `data: ${JSON.stringify(value)}${ending}${ending}`;

const completed = () => ({
  response: {
    id: "resp_compact",
    status: "completed",
  },
  type: "response.completed",
});

const responseFromText = (text: string, cuts: readonly number[] = []) => {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const end of cuts.toSorted((left, right) => left - right)) {
    if (end > start && end < bytes.length) {
      chunks.push(bytes.slice(start, end));
      start = end;
    }
  }
  chunks.push(bytes.slice(start));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    {
      headers: { "content-type": "text/event-stream" },
      status: 200,
    }
  );
};

const compactionDone = (
  encryptedContent = "opaque-🔒",
  type = "compaction"
) => ({
  item: {
    encrypted_content: encryptedContent,
    id: "cmp_1",
    internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
    type,
  },
  output_index: 1,
  type: "response.output_item.done",
});

describe("pure compaction SSE collector", () => {
  it("handles LF/CRLF, multiline data, UTF-8 splits, aliases, extras, and DONE", async () => {
    const extra = event({
      item: {
        content: [{ text: "ignored assistant output", type: "output_text" }],
        role: "assistant",
        type: "message",
      },
      output_index: 0,
      type: "response.output_item.done",
    });
    const compactJson = JSON.stringify(
      compactionDone("opaque-🔒", "compaction_summary")
    );
    const comma = compactJson.indexOf(',"output_index"') + 1;
    const multiline = `event: message\r\ndata: ${compactJson.slice(
      0,
      comma
    )}\r\ndata: ${compactJson.slice(comma)}\r\n\r\n`;
    const text = [
      event({ response: { id: "resp_compact" }, type: "response.created" }),
      extra,
      multiline,
      event(completed()),
      "data: [DONE]\n\n",
    ].join("");
    const emojiByte = new TextEncoder().encode(
      text.slice(0, text.indexOf("🔒"))
    ).length;

    const result = await collectCompactionSse(
      responseFromText(text, [1, 17, emojiByte + 1, emojiByte + 3])
    );
    expect({
      compaction: result.compaction,
      responseId: result.responseId,
    }).toStrictEqual({
      compaction: {
        encrypted_content: "opaque-🔒",
        id: "cmp_1",
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        type: "compaction",
      },
      responseId: "resp_compact",
    });
  });

  it("rejects zero, multiple, empty, failed, incomplete, and HTTP failures", async () => {
    const cases = [
      responseFromText(event(completed())),
      responseFromText(
        [
          event(compactionDone("one")),
          event(compactionDone("two")),
          event(completed()),
        ].join("")
      ),
      responseFromText(
        [event(compactionDone("")), event(completed())].join("")
      ),
      responseFromText(event(compactionDone())),
      responseFromText(
        event({
          response: { id: "resp_compact", status: "failed" },
          type: "response.failed",
        })
      ),
      new Response("failure", { status: 500 }),
    ];

    const outcomes = await Promise.all(
      cases.map(async (response) => {
        try {
          await collectCompactionSse(response);
          return "accepted";
        } catch {
          return "rejected";
        }
      })
    );
    expect(outcomes).toStrictEqual(Array.from({ length: 6 }, () => "rejected"));
  });

  it("propagates abort and cancels the reader", async () => {
    const abortController = new AbortController();
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_item.done","item":'
            )
          );
        },
      }),
      {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      }
    );

    const pending = collectCompactionSse(response, abortController.signal);
    queueMicrotask(() => {
      abortController.abort(new Error("phase-one abort"));
    });

    await expect(pending).rejects.toThrow("phase-one abort");
    await vi.waitFor(() => {
      expect(cancelled).toBeTruthy();
    });
  });
});
