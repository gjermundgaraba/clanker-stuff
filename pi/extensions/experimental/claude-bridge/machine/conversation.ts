// One pi session's Claude Code conversation: the query serving it, the pi stream each
// provider call hands over, and the record of what Claude Code holds.
//
// The query runs as a child of `active`, so every exit from `active` (completion,
// failure, abort, discard) stops it and closes Claude Code, and a stopped child's late
// messages are dropped by XState rather than by bookkeeping here. Abort listeners and the
// steer push are children of the states they serve, for the same reason.

import type { Api, Message, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createCallbackLogic, setup, types } from "xstate";
import type { EventObject, SnapshotFrom, StateValue } from "xstate";

import { stopQuery } from "../child.js";
import type { BridgeQuery, QueryFunction, QueryParams } from "../child.js";
import { debug, errorMessage } from "../log.js";
import { toolResultToMcpContent } from "../mcp-server.js";
import type { McpResult } from "../mcp-server.js";
import type { PromptStream } from "../query/prompt-stream.js";
import { userMessage } from "../query/prompt-stream.js";
import {
  describeRateLimitFailure,
  logServedContextWindow,
  rateLimitNotice,
  rateLimitRejection,
  resultErrorText,
} from "../query/result.js";
import type { RateLimitRejection } from "../query/result.js";
import type { SyncState } from "../sync.js";
import type { Turn } from "../translate.js";
import { userTurnBlocks } from "../turn.js";

/** The answer an MCP handler is waiting on. */
export type ResolveToolCall = (result: McpResult) => void;

/** What one query was started with, kept for its lifetime. */
export interface ActiveQuery {
  params: QueryParams;
  /** The query's stdin: steers go in while it runs, and a result closes it. */
  promptStream: PromptStream;
  /** What the query is fixed to (`queryKey`); a parked query only continues under it. */
  key: string;
  model: Model<Api>;
  /** The signal of the provider call that started the query. pi aborts it for the whole
   *  agent run, including while a tool runs and no provider call is open. */
  signal: AbortSignal | undefined;
}

export interface QueryStart extends ActiveQuery {
  turn: Turn;
  /** The pi messages Claude Code holds once it reads the prompt. */
  held: readonly Message[];
}

/** Results waiting for the steer ahead of them, if any, to reach Claude Code's stdin. */
interface PendingDelivery {
  results: ReadonlyMap<string, McpResult>;
  steer: readonly Message[];
  /** The steer as Claude Code reads it; undefined when there is none. */
  message: SDKUserMessage | undefined;
}

const NO_HANDLERS: ReadonlyMap<string, ResolveToolCall> = new Map();

const NO_RESULTS: ReadonlyMap<string, McpResult> = new Map();

const NO_CALLS: ReadonlySet<string> = new Set();

const ENDED = "Claude Code query ended";

/** How long Claude Code may take to exit after its result before it is killed. */
export const CLOSE_GRACE_MS = 10_000;

// Handlers for what `closing` shares with the other `active` states live on `active`.
const isClosing = (value: StateValue): boolean =>
  typeof value === "object" && value["active"] === "closing";

const IDLE = {
  query: null,
  turn: null,
  callSignal: undefined,
  pending: null,
  waiting: NO_CALLS,
  handlers: NO_HANDLERS,
  results: NO_RESULTS,
} as const;

interface QueryInput {
  run: QueryFunction;
  params: QueryParams;
}

// Reads Claude Code's messages into the conversation. Cleanup stops the query; XState
// drops anything the read loop sends after that. Starting it is inside the try: the SDK
// throws there when it cannot find Claude Code.
const claudeQuery = createCallbackLogic<EventObject, QueryInput>(({ input, sendBack }) => {
  let query: BridgeQuery | undefined;

  void (async () => {
    try {
      query = input.run(input.params);

      for await (const message of query) {
        sendBack({ type: "cc.message", message });
      }

      sendBack({ type: "cc.end" });
    } catch (error) {
      sendBack({ type: "cc.error", message: errorMessage(error) });
    }
  })();

  return () => {
    stopQuery(query);
  };
});

// pi's abort, for as long as the state that invoked this listens.
const abortOn = createCallbackLogic<EventObject, AbortSignal | undefined>(
  ({ input: signal, sendBack }) => {
    if (signal === undefined) return undefined;

    const onAbort = (): void => {
      sendBack({ type: "pi.abort" });
    };

    if (signal.aborted) {
      onAbort();

      return undefined;
    }

    signal.addEventListener("abort", onAbort, { once: true });

    return () => {
      signal.removeEventListener("abort", onAbort);
    };
  },
);

interface SteerInput {
  promptStream: PromptStream;
  message: SDKUserMessage | undefined;
}

// The steer must reach stdin before the results it rides with: both travel over the
// same FIFO, and Claude Code drains a steer at the tool boundary only if it was queued
// before the result. The push resolves once the SDK wrote it (see prompt-stream.ts).
// With no steer there is nothing to wait for.
const pushSteer = createCallbackLogic<EventObject, SteerInput>(({ input, sendBack }) => {
  const pushed =
    input.message === undefined ? Promise.resolve() : input.promptStream.push(input.message);

  pushed.then(
    () => {
      sendBack({ type: "steer.done", error: undefined });
    },
    (error: unknown) => {
      sendBack({ type: "steer.done", error: errorMessage(error) });
    },
  );
});

const resolveAll = (handlers: ReadonlyMap<string, ResolveToolCall>, text: string): void => {
  for (const resolve of handlers.values()) resolve({ content: [{ type: "text", text }] });
};

const toMcpResult = (message: ToolResultMessage): McpResult => ({
  content: toolResultToMcpContent(message.content),
  isError: message.isError,
});

/** Hand each result to its waiting handler, or keep it for the handler still to come. */
function release(
  handlers: ReadonlyMap<string, ResolveToolCall>,
  stored: ReadonlyMap<string, McpResult>,
  delivered: ReadonlyMap<string, McpResult>,
): {
  handlers: ReadonlyMap<string, ResolveToolCall>;
  results: ReadonlyMap<string, McpResult>;
  answer: () => void;
} {
  const waiting = new Map(handlers);
  const results = new Map(stored);
  const answers: (() => void)[] = [];

  for (const [id, result] of delivered) {
    const resolve = waiting.get(id);

    if (resolve === undefined) {
      results.set(id, result);
      continue;
    }

    waiting.delete(id);
    answers.push(() => {
      resolve(result);
    });
  }

  return {
    handlers: waiting,
    results,
    answer: () => {
      for (const answer of answers) answer();
    },
  };
}

const stuckNotice = (count: number): string =>
  `Claude bridge: ${count} tool handler(s) still waiting; provider may be stuck`;

export const conversationMachine = setup({
  schemas: {
    context: types<{
      run: QueryFunction;
      notify: (message: string) => void;
      /** The Claude Code session the conversation resumes, once a query reported it. */
      ccSessionId: string | undefined;
      /** The pi messages Claude Code holds, oldest first. Kept only through a clean exit:
       *  a query that failed or was killed may have left its session file short. */
      held: readonly Message[];
      /** A rejection names the next failure as a quota error. */
      rateLimit: RateLimitRejection | null;
      query: ActiveQuery | null;
      /** The provider call being answered. */
      turn: Turn | null;
      /** The signal of the provider call that delivered results, when it differs. */
      callSignal: AbortSignal | undefined;
      pending: PendingDelivery | null;
      /** The tool calls the parked query waits on. */
      waiting: ReadonlySet<string>;
      /** MCP handlers parked on a tool call pi has not answered yet. */
      handlers: ReadonlyMap<string, ResolveToolCall>;
      /** Tool results pi delivered before Claude Code's handler asked for them. */
      results: ReadonlyMap<string, McpResult>;
    }>(),
    events: {
      "pi.start": types<QueryStart>(),
      "pi.deliver": types<{
        turn: Turn;
        results: readonly ToolResultMessage[];
        steer: readonly Message[];
        signal: AbortSignal | undefined;
      }>(),
      /** pi's history moved on without the running query: stop it. */
      "pi.discard": types<{}>(),
      "pi.abort": types<{}>(),
      "cc.toolCall": types<{ id: string; resolve: ResolveToolCall }>(),
      "cc.message": types<{ message: SDKMessage }>(),
      "cc.end": types<{}>(),
      "cc.error": types<{ message: string }>(),
      "steer.done": types<{ error: string | undefined }>(),
      /** The turn ended on tool calls Claude was cut off in the middle of. */
      "turn.truncated": types<{}>(),
    },
    input: types<{ run: QueryFunction; notify: (message: string) => void }>(),
  },
  states: {
    idle: {
      id: "idle",
      schemas: { context: types<{ query: null; turn: null; pending: null }>() },
    },
    active: {
      schemas: { context: types<{ query: ActiveQuery }>() },
      states: {
        streaming: { schemas: { context: types<{ turn: Turn; pending: null }>() } },
        parked: { schemas: { context: types<{ turn: null; pending: null }>() } },
        delivering: { schemas: { context: types<{ turn: Turn; pending: PendingDelivery }>() } },
        closing: { schemas: { context: types<{ turn: null; pending: null }>() } },
      },
    },
  },
  actors: { claudeQuery, abortOn, pushSteer },
}).createMachine({
  context: ({ input }) => ({
    run: input.run,
    notify: input.notify,
    ccSessionId: undefined,
    held: [],
    rateLimit: null,
    ...IDLE,
  }),
  initial: "idle",
  // A request the current state cannot take still holds a pi stream: end it, rather than
  // leave pi waiting on a stream nothing ends. The provider's sync decision should make
  // this unreachable.
  on: {
    "pi.start": ({ event, value }, enq) => {
      enq(() => {
        event.turn.fail(`claude-bridge: cannot start a query in state ${JSON.stringify(value)}`);
      });

      return {};
    },
    "pi.deliver": ({ event, value }, enq) => {
      enq(() => {
        event.turn.fail(`claude-bridge: no parked query in state ${JSON.stringify(value)}`);
      });

      return {};
    },
  },
  states: {
    idle: {
      id: "idle",
      on: {
        "pi.start": ({ event }) => ({
          target: "active.streaming",
          context: {
            query: {
              params: event.params,
              promptStream: event.promptStream,
              key: event.key,
              model: event.model,
              signal: event.signal,
            },
            turn: event.turn,
            held: event.held,
            // A rejection that labelled no failure in its own query says nothing about
            // the next one.
            rateLimit: null,
          },
        }),
      },
    },
    active: {
      invoke: {
        id: "query",
        src: "claudeQuery",
        input: ({ context }) => ({ run: context.run, params: context.query.params }),
      },
      // Leaving `active` stops the query: no handler or steer may outlive it waiting.
      exit: ({ context }, enq) => {
        enq(() => {
          resolveAll(context.handlers, ENDED);
          context.query.promptStream.fail(new Error(ENDED));
        });
      },
      on: {
        // Either order is fine: a handler finds its result already delivered, or waits.
        "cc.toolCall": ({ context, event }, enq) => {
          const result = context.results.get(event.id);

          if (result === undefined) {
            debug(`conversation: tool call ${event.id} waits for pi`);

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
        // What the child states pass up: anything that is not the turn's content.
        "cc.message": ({ context, event }, enq) => {
          const { message } = event;

          if (message.type === "system" && message.subtype === "init") {
            debug(`conversation: session ${message.session_id}`);

            return { context: { ccSessionId: message.session_id } };
          }

          if (message.type === "rate_limit_event") {
            debug("conversation: rate_limit_event", JSON.stringify(message.rate_limit_info));

            const rejection = rateLimitRejection(message.rate_limit_info);

            if (rejection === undefined) return {};

            if (context.rateLimit === null) {
              enq(() => {
                context.notify(rateLimitNotice(rejection));
              });
            }

            return { context: { rateLimit: rejection } };
          }

          if (message.type !== "result") {
            if (message.type !== "user") debug(`conversation: ignored ${message.type} message`);

            return {};
          }

          const { turn, query } = context;
          const failure = resultErrorText(message);

          enq(() => {
            // Nothing else closes a streamed prompt's stdin, and Claude Code waits on it.
            query.promptStream.end();
            logServedContextWindow(message, query.model);
          });

          if (failure !== undefined) {
            // Consumed with the failure it caused.
            const text =
              context.rateLimit === null
                ? failure
                : describeRateLimitFailure(context.rateLimit, failure);

            debug(`conversation: error result, subtype=${message.subtype}, error=${text}`);
            enq(() => {
              turn?.fail(text);
            });

            return { target: ".closing", context: { ...IDLE, query, held: [], rateLimit: null } };
          }

          if (turn === null) return { target: ".closing", context: { ...IDLE, query } };

          // Finish the turn before `held` records its output: XState freezes context.
          if (message.subtype === "success") turn.result(message);

          turn.finish();

          return {
            target: ".closing",
            context: { ...IDLE, query, held: [...context.held, turn.output] },
          };
        },
        // In `closing` the turn is already answered: an end is the expected exit.
        "cc.end": ({ context, value }, enq) => {
          if (isClosing(value)) return { target: "idle", context: IDLE };

          enq(() => {
            context.turn?.fail("Claude Code ended the query without a result");
          });

          return { target: "idle", context: { ...IDLE, held: [] } };
        },
        // In `closing` there is no turn left to fail, but a failed exit after the result
        // may still have cut the session file short.
        "cc.error": ({ context, event }, enq) => {
          debug(`conversation: query failed: ${event.message}`);
          enq(() => {
            context.turn?.fail(event.message);
          });

          return { target: "idle", context: { ...IDLE, held: [] } };
        },
        "pi.abort": ({ context }, enq) => {
          debug("conversation: aborted");
          enq(() => {
            context.turn?.fail("Operation aborted", "aborted");
          });

          return { target: "idle", context: { ...IDLE, held: [] } };
        },
        // Claude Code may go on from the cut on its own, into a session pi will never see:
        // stop it, and rebuild from pi's history next time.
        "turn.truncated": () => {
          debug("conversation: tool calls cut off at the output limit, stopping the query");

          return { target: "idle", context: { ...IDLE, held: [] } };
        },
        "pi.discard": ({ context }, enq) => {
          debug("conversation: discarding the running query");
          enq(() => {
            context.turn?.fail("claude-bridge: pi's history moved on without this query");
          });

          return { target: "idle", context: { ...IDLE, held: [] } };
        },
      },
      initial: "streaming",
      states: {
        streaming: {
          invoke: [
            { id: "abortStart", src: "abortOn", input: ({ context }) => context.query.signal },
            { id: "abortCall", src: "abortOn", input: ({ context }) => context.callSignal },
          ],
          on: {
            "cc.message": ({ context, event }, enq) => {
              const { message } = event;
              const { turn } = context;

              if (message.type === "stream_event") turn.streamEvent(message);
              else if (message.type === "assistant") turn.assistantMessage(message);
              else return undefined;

              if (!turn.ended) return {};

              if (turn.output.stopReason !== "toolUse") {
                enq.raise({ type: "turn.truncated" });

                return {};
              }

              // pi now runs the tools; their results come back through the next call.
              return {
                target: "parked",
                context: {
                  turn: null,
                  callSignal: undefined,
                  waiting: new Set(turn.toolCallIds),
                  held: [...context.held, turn.output],
                },
              };
            },
          },
        },
        parked: {
          invoke: {
            id: "abortStart",
            src: "abortOn",
            input: ({ context }) => context.query.signal,
          },
          on: {
            "pi.deliver": ({ context, event }) => {
              const blocks = userTurnBlocks(event.steer);

              return {
                target: "delivering",
                context: {
                  turn: event.turn,
                  // A distinct signal only; pi usually aborts one signal for the whole run.
                  callSignal: event.signal === context.query.signal ? undefined : event.signal,
                  held: [...context.held, ...event.results],
                  waiting: NO_CALLS,
                  pending: {
                    results: new Map(
                      event.results.map((result) => [result.toolCallId, toMcpResult(result)]),
                    ),
                    steer: event.steer,
                    message: blocks === undefined ? undefined : userMessage(blocks, "next"),
                  },
                },
              };
            },
          },
        },
        delivering: {
          invoke: [
            { id: "abortStart", src: "abortOn", input: ({ context }) => context.query.signal },
            { id: "abortCall", src: "abortOn", input: ({ context }) => context.callSignal },
            {
              id: "steer",
              src: "pushSteer",
              input: ({ context }) => ({
                promptStream: context.query.promptStream,
                message: context.pending.message,
              }),
            },
          ],
          on: {
            // A steer that never reached Claude Code is still in pi's history: leaving it
            // out of `held` makes the next request rebuild with it.
            "steer.done": ({ context, event }, enq) => {
              const { pending } = context;

              if (event.error !== undefined) {
                debug(`conversation: steer never reached Claude Code: ${event.error}`);
              } else if (pending.message !== undefined) {
                debug("conversation: steer written to Claude Code's stdin before the tool results");
              }

              const { handlers, results, answer } = release(
                context.handlers,
                context.results,
                pending.results,
              );

              enq(() => {
                answer();

                if (handlers.size > 0) context.notify(stuckNotice(handlers.size));
              });

              return {
                target: "streaming",
                context: {
                  pending: null,
                  handlers,
                  results,
                  held:
                    event.error === undefined ? [...context.held, ...pending.steer] : context.held,
                },
              };
            },
          },
        },
        // pi has its answer. Claude Code finishes writing its session file and exits once
        // its stdin closes; stopping it sooner could cut that file short.
        closing: {
          timeout: CLOSE_GRACE_MS,
          onTimeout: (_, enq) => {
            enq(() => {
              debug("conversation: Claude Code did not exit after its result, killing it");
            });

            return { target: "#idle", context: { ...IDLE, held: [] } };
          },
          on: {
            "cc.message": ({ event }) => (event.message.type === "result" ? {} : undefined),
          },
        },
      },
    },
  },
});

export type ConversationSnapshot = SnapshotFrom<typeof conversationMachine>;

/** The conversation as the sync decision reads it. */
export function syncState(snapshot: ConversationSnapshot): SyncState {
  const { held, ccSessionId, query, waiting } = snapshot.context;
  const parked = snapshot.matches({ active: "parked" }) && query !== null;

  return {
    held,
    session: ccSessionId,
    busy: snapshot.matches("active"),
    parked: parked ? { key: query.key, waiting } : undefined,
  };
}
