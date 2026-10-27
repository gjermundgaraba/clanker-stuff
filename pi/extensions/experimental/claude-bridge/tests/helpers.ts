// Shared setup: a bridge model, transcript contexts, and a controllable stand-in for the
// Agent SDK's query().

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { normalizeContext } from "@earendil-works/pi-ai";
import type {
  Api,
  Context,
  Model,
  TranscriptContext,
} from "@earendil-works/pi-ai";

import type { BridgeQuery, QueryParams } from "../child.js";

export const testModel = (id = "claude-haiku-5-5"): Model<Api> => ({
  id,
  name: id,
  api: "claude-bridge",
  provider: "claude-bridge",
  baseUrl: "claude-bridge",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 64_000,
});

/** A provider context as pi hands it over: prompt and tools folded into system messages. */
export const transcript = (context: Context): TranscriptContext =>
  normalizeContext(context);

/** One scripted query: the test pushes SDK messages and ends or fails it. */
export interface FakeQuery extends BridgeQuery {
  readonly params: QueryParams;
  push: (message: SDKMessage) => void;
  end: () => void;
  fail: (error: Error) => void;
  readonly interrupted: boolean;
  readonly closed: boolean;
}

export const createFakeQuery = (params: QueryParams): FakeQuery => {
  const queue: SDKMessage[] = [];
  let wake: ((value: undefined) => void) | undefined;
  let done = false;
  let failure: Error | undefined;
  let interrupted = false;
  let closed = false;

  const kick = (): void => {
    wake?.(undefined);
    wake = undefined;
  };

  const messages = async function* (): AsyncGenerator<SDKMessage> {
    while (true) {
      while (queue.length === 0 && !done && failure === undefined) {
        const { promise, resolve } = Promise.withResolvers<undefined>();

        wake = resolve;
        await promise;
      }

      const next = queue.shift();

      if (next !== undefined) {
        yield next;
        continue;
      }

      if (failure !== undefined) {
        throw failure;
      }

      return;
    }
  };

  const iterator = messages();

  return {
    params,
    [Symbol.asyncIterator]: () => iterator,
    push(message) {
      queue.push(message);
      kick();
    },
    end() {
      done = true;
      kick();
    },
    fail(error) {
      failure = error;
      kick();
    },
    async interrupt() {
      interrupted = true;
    },
    close() {
      closed = true;
      done = true;
      kick();
    },
    get interrupted() {
      return interrupted;
    },
    get closed() {
      return closed;
    },
  };
};

/** A query() stand-in recording every query it starts. */
export const fakeQueryFunction = () => {
  const queries: FakeQuery[] = [];

  return {
    queries,
    run: (params: QueryParams) => {
      const query = createFakeQuery(params);

      queries.push(query);

      return query;
    },
  };
};
