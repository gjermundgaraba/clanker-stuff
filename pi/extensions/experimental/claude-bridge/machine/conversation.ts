// Spike: one pi session's Claude Code conversation as an XState v6 machine. Not wired
// into the provider; it proves the orchestration and its types against the lint policy.
//
// The query runs as a child of `active`, so every exit from `active` (completion,
// failure, abort) stops it and closes Claude Code, and a stopped child's late messages
// are dropped by XState rather than by bookkeeping here.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createCallbackLogic, setup, types } from "xstate";
import type { EventObject } from "xstate";

import type { QueryFunction, QueryParams } from "../bridge.js";
import { errorMessage } from "../log.js";

/** Where one provider call's output goes: pi's stream for that call. */
export interface TurnSink {
  text(text: string): void;
  toolUse(): void;
  done(): void;
  fail(message: string): void;
}

export interface ToolResult {
  text: string;
}

/** The answer an MCP handler is waiting on. */
export type ResolveToolCall = (result: ToolResult) => void;

interface QueryInput {
  run: QueryFunction;
  params: QueryParams;
}

// Reads Claude Code's messages into the conversation. Cleanup closes the query; XState
// drops anything the read loop sends after that.
const claudeQuery = createCallbackLogic<EventObject, QueryInput>(({ input, sendBack }) => {
  const query = input.run(input.params);

  void (async () => {
    try {
      for await (const message of query) sendBack({ type: "cc.message", message });

      sendBack({ type: "cc.end" });
    } catch (error) {
      sendBack({ type: "cc.error", message: errorMessage(error) });
    }
  })();

  return () => {
    query.close();
  };
});

const NO_HANDLERS: ReadonlyMap<string, ResolveToolCall> = new Map();

const NO_RESULTS: ReadonlyMap<string, ToolResult> = new Map();

const IDLE = { params: null, sink: null, handlers: NO_HANDLERS, results: NO_RESULTS } as const;

const resolveAll = (handlers: ReadonlyMap<string, ResolveToolCall>, text: string): void => {
  for (const resolve of handlers.values()) resolve({ text });
};

export const conversationMachine = setup({
  schemas: {
    context: types<{
      run: QueryFunction;
      notify: (message: string) => void;
      params: QueryParams | null;
      sink: TurnSink | null;
      /** MCP handlers parked on a tool call pi has not answered yet. */
      handlers: ReadonlyMap<string, ResolveToolCall>;
      /** Tool results pi delivered before Claude Code's handler asked for them. */
      results: ReadonlyMap<string, ToolResult>;
    }>(),
    events: {
      "pi.prompt": types<{ sink: TurnSink; params: QueryParams }>(),
      "pi.toolResults": types<{ sink: TurnSink; results: ReadonlyMap<string, ToolResult> }>(),
      "cc.toolCall": types<{ id: string; resolve: ResolveToolCall }>(),
      "cc.message": types<{ message: SDKMessage }>(),
      "cc.end": types<{}>(),
      "cc.error": types<{ message: string }>(),
      abort: types<{}>(),
    },
    input: types<{ run: QueryFunction; notify: (message: string) => void }>(),
  },
  states: {
    idle: { schemas: { context: types<{ params: null; sink: null }>() } },
    active: {
      schemas: { context: types<{ params: QueryParams }>() },
      states: {
        streaming: { schemas: { context: types<{ sink: TurnSink }>() } },
        parked: { schemas: { context: types<{ sink: null }>() } },
      },
    },
  },
  actors: { claudeQuery },
  delays: { stuckHandler: 30_000 },
}).createMachine({
  context: ({ input }) => ({ run: input.run, notify: input.notify, ...IDLE }),
  initial: "idle",
  states: {
    idle: {
      on: {
        "pi.prompt": ({ event }) => ({
          target: "active.streaming",
          context: { params: event.params, sink: event.sink },
        }),
      },
    },
    active: {
      invoke: {
        id: "query",
        src: "claudeQuery",
        input: ({ context }) => ({ run: context.run, params: context.params }),
      },
      // Leaving `active` stops the query: no handler may outlive it waiting on a reply.
      exit: ({ context }, enq) => {
        enq(() => {
          resolveAll(context.handlers, "Claude Code query ended");
        });
      },
      on: {
        // Either order is fine: a handler finds its result already delivered, or waits.
        "cc.toolCall": ({ context, event }, enq) => {
          const result = context.results.get(event.id);

          if (result === undefined) {
            return {
              context: { handlers: new Map(context.handlers).set(event.id, event.resolve) },
            };
          }

          enq(() => {
            event.resolve(result);
          });

          const results = new Map(context.results);

          results.delete(event.id);

          return { context: { results } };
        },
        // Reached from either child state: `streaming` passes results up unhandled.
        "cc.message": ({ context, event }, enq) => {
          if (event.message.type !== "result") return undefined;

          enq(() => {
            context.sink?.done();
          });

          return { target: "idle", context: IDLE };
        },
        "cc.error": ({ context, event }, enq) => {
          enq(() => {
            context.sink?.fail(event.message);
          });

          return { target: "idle", context: IDLE };
        },
        "cc.end": ({ context }, enq) => {
          enq(() => {
            context.sink?.fail("Claude Code ended the query without a result");
          });

          return { target: "idle", context: IDLE };
        },
        abort: ({ context }, enq) => {
          enq(() => {
            context.sink?.fail("aborted");
          });

          return { target: "idle", context: IDLE };
        },
      },
      initial: "streaming",
      states: {
        streaming: {
          on: {
            "cc.message": ({ context, event }, enq) => {
              const { message } = event;

              if (message.type !== "assistant") return undefined;

              const blocks = message.message.content;

              enq(() => {
                for (const block of blocks) {
                  if (block.type === "text") context.sink.text(block.text);
                }
              });

              if (!blocks.some((block) => block.type === "tool_use")) return {};

              enq(() => {
                context.sink.toolUse();
              });

              return { target: "parked", context: { sink: null } };
            },
          },
        },
        parked: {
          after: {
            stuckHandler: ({ context }, enq) => {
              enq(() => {
                context.notify(
                  `claude-bridge: ${context.handlers.size} tool call(s) still waiting`,
                );
              });
            },
          },
          on: {
            "pi.toolResults": ({ context, event }, enq) => {
              const handlers = new Map(context.handlers);
              const results = new Map(context.results);

              for (const [id, result] of event.results) {
                const resolve = handlers.get(id);

                if (resolve === undefined) {
                  results.set(id, result);
                  continue;
                }

                handlers.delete(id);
                enq(() => {
                  resolve(result);
                });
              }

              return { target: "streaming", context: { sink: event.sink, handlers, results } };
            },
          },
        },
      },
    },
  },
});
