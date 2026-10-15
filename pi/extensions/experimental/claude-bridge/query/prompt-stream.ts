// Long-lived streaming-input prompt for query().
//
// The SDK accepts `prompt: AsyncIterable<SDKUserMessage>` and pumps it to the CLI's
// stdin. Keeping that iterable parked for the life of the query lets a steer reach stdin
// *while* a tool runs, so Claude Code drains it at the next tool boundary
// (`priority: "next"`) instead of treating it as a follow-up turn.
//
// The ack is the load-bearing part: `push()` resolves on the line after `yield`, and the
// SDK's pump is `for await (m of stream) { await transport.write(m) }`, so resuming past
// the yield proves the write completed. Callers await that before releasing the MCP tool
// result, which travels back over the same stdin FIFO; winning that race is what makes
// Claude Code see the steer before the tool result. The drain and the FIFO ordering are
// CLI internals, not SDK contract, so a Claude Code upgrade can break this silently.

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

export interface PromptStream {
  stream: AsyncGenerator<SDKUserMessage>;
  /** Enqueue a message; resolves once the SDK wrote it to stdin. Rejects (never hangs)
   *  when the stream already ended or failed. */
  push: (message: SDKUserMessage) => Promise<void>;
  /** Close the input: the generator returns and the SDK closes the CLI's stdin. */
  end: () => void;
  /** Abandon the input, rejecting every queued and in-flight ack. */
  fail: (error: Error) => void;
}

interface Item {
  message: SDKUserMessage;
  resolve: () => void;
  reject: (error: Error) => void;
}

export function makePromptStream(): PromptStream {
  const queue: Item[] = [];
  // The item parked at `yield`, tracked so fail() can settle it: a dying CLI may abandon
  // the pump without resuming us, and an unsettled ack would wedge tool-result delivery.
  let inflight: Item | null = null;
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;

  const kick = (): void => {
    wake?.();
    wake = null;
  };

  async function* generate(): AsyncGenerator<SDKUserMessage> {
    try {
      while (true) {
        while (queue.length === 0 && !done && failure === null) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }

        if (failure !== null) throw failure;

        const item = queue.shift();

        // Ended and drained.
        if (item === undefined) return;

        inflight = item;

        try {
          yield item.message;
          item.resolve();
        } finally {
          // A no-op after resolve; otherwise the pump abandoned iteration, which resumes
          // the yield as a return.
          item.reject(new Error("prompt stream closed"));
          inflight = null;
        }
      }
    } finally {
      // No consumer is left to drain the queue, so a later push would never settle.
      // Closing here keeps the reject-never-hang contract a property of this module.
      done = true;
    }
  }

  return {
    stream: generate(),
    push: (message) =>
      failure !== null || done
        ? Promise.reject(failure ?? new Error("prompt stream closed"))
        : new Promise<void>((resolve, reject) => {
            queue.push({ message, resolve, reject });
            kick();
          }),
    end: () => {
      done = true;
      kick();
    },
    fail: (error) => {
      // First failure wins: the query's `finally` fails the stream again with a generic
      // "query ended", which would otherwise mask the real cause.
      if (failure !== null) return;

      failure = error;

      for (const item of queue.splice(0)) item.reject(error);

      inflight?.reject(error);
      kick();
    },
  };
}

/** `uuid` is omitted on purpose: no dedup is needed, and one makes Claude Code's stdin
 *  loop look the message up in the session. */
export function userMessage(
  content: SDKUserMessage["message"]["content"],
  priority?: SDKUserMessage["priority"],
): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    ...(priority === undefined ? {} : { priority }),
  };
}
