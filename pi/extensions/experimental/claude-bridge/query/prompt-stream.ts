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
  resolve: (value: undefined) => void;
  reject: (error: Error) => void;
}

export const makePromptStream = (): PromptStream => {
  const queue: Item[] = [];
  let inflight: Item | null = null;
  let wake: ((value: undefined) => void) | null = null;
  let done = false;
  let failure: Error | null = null;

  const kick = (): void => {
    wake?.(undefined);
    wake = null;
  };

  const generate = async function* (): AsyncGenerator<SDKUserMessage> {
    try {
      while (true) {
        while (queue.length === 0 && !done && failure === null) {
          const { promise, resolve } = Promise.withResolvers<undefined>();

          wake = resolve;
          await promise;
        }

        if (failure !== null) {
          throw failure;
        }

        const item = queue.shift();

        if (item === undefined) {
          return;
        }

        inflight = item;

        try {
          yield item.message;
          item.resolve(undefined);
        } finally {
          item.reject(new Error("prompt stream closed"));
          inflight = null;
        }
      }
    } finally {
      done = true;

      for (const item of queue.splice(0)) {
        item.reject(new Error("prompt stream closed"));
      }
    }
  };

  return {
    stream: generate(),
    push: async (message) => {
      if (failure !== null || done) {
        throw failure ?? new Error("prompt stream closed");
      }

      const { promise, resolve, reject } = Promise.withResolvers<undefined>();

      queue.push({ message, resolve, reject });
      kick();
      await promise;
    },
    end: () => {
      done = true;
      kick();
    },
    fail: (error) => {
      if (failure !== null) {
        return;
      }

      failure = error;

      for (const item of queue.splice(0)) {
        item.reject(error);
      }

      inflight?.reject(error);
      kick();
    },
  };
};

/** `uuid` is omitted on purpose: no dedup is needed, and one makes Claude Code's stdin
 *  loop look the message up in the session. */
export const userMessage = (
  content: SDKUserMessage["message"]["content"],
  priority?: SDKUserMessage["priority"]
): SDKUserMessage => ({
  type: "user",
  message: { role: "user", content },
  parent_tool_use_id: null,
  ...(priority === undefined ? {} : { priority }),
});
