// Shared setup: a bridge model, transcript contexts, and a controllable stand-in for the
// Agent SDK's query().

import { normalizeContext } from "@earendil-works/pi-ai";
import type { Api, Context, Model, TranscriptContext } from "@earendil-works/pi-ai";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { BridgeQuery, QueryFunction, QueryParams } from "../bridge.js";

export function testModel(id = "claude-haiku-5-5"): Model<Api> {
  return {
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
  };
}

/** A provider context as pi hands it over: prompt and tools folded into system messages. */
export const transcript = (context: Context): TranscriptContext => normalizeContext(context);

/** One scripted query: the test pushes SDK messages and ends or fails it. */
export interface FakeQuery extends BridgeQuery {
  readonly params: QueryParams;
  push(message: SDKMessage): void;
  end(): void;
  fail(error: Error): void;
  readonly interrupted: boolean;
  readonly closed: boolean;
}

export function createFakeQuery(params: QueryParams): FakeQuery {
  const queue: SDKMessage[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: Error | undefined;
  let interrupted = false;
  let closed = false;

  const kick = (): void => {
    wake?.();
    wake = undefined;
  };

  async function* messages(): AsyncGenerator<SDKMessage> {
    while (true) {
      while (queue.length === 0 && !done && failure === undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }

      const next = queue.shift();

      if (next !== undefined) {
        yield next;
        continue;
      }

      if (failure !== undefined) throw failure;

      return;
    }
  }

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
    interrupt() {
      interrupted = true;

      return Promise.resolve(undefined);
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
}

/** A query() stand-in recording every query it starts. */
export function fakeQueryFunction(): { run: QueryFunction; queries: FakeQuery[] } {
  const queries: FakeQuery[] = [];

  return {
    queries,
    run: (params) => {
      const query = createFakeQuery(params);

      queries.push(query);

      return query;
    },
  };
}
