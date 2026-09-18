import { createParser } from "eventsource-parser";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const EventSchema = Type.Record(Type.String(), Type.Unknown());

export async function* parseSseEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<Static<typeof EventSchema>> {
  if (!response.body) {
    throw new Error("Codex response has no body");
  }

  // Fetch bodies are byte streams; the installed Node Response declaration defaults the reader to any.
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  const events: string[] = [];
  const parser = createParser({ onEvent: (event) => events.push(event.data) });
  const abort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }

      const { done, value } = await reader.read();

      if (signal?.aborted) {
        throw new Error("Request was aborted");
      }

      parser.feed(decoder.decode(value, { stream: !done }));

      if (done) {
        // Preserve the provider's acceptance of a final event without a blank line.
        parser.feed("\n\n");
      }

      // Drain this read before requesting another. TransformStream read-ahead can
      // discard already-parsed events when a later body read fails.
      for (const event of events) {
        if (signal?.aborted) {
          throw new Error("Request was aborted");
        }

        const data = event.trim();

        if (data.length === 0 || data === "[DONE]") {
          continue;
        }

        const parsed: unknown = JSON.parse(data);

        if (!Value.Check(EventSchema, parsed)) {
          throw new Error("Codex stream event must be an object");
        }

        yield parsed;
      }

      events.length = 0;

      if (done) {
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {
      // Reader cancellation is best effort during cleanup.
    });
    reader.releaseLock();
  }
}
