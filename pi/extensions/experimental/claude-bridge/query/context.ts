// Per-query and per-turn mutable state. Reentrant queries (subagents running in the
// same process) each get their own QueryContext.

import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
} from "@earendil-works/pi-ai";

import type { BridgeQuery } from "../child.js";

import type { PromptStream } from "./prompt-stream.js";
import type { RateLimitRejection } from "./result.js";
import type { McpResult } from "./tool-results.js";

export interface PendingToolCall {
  toolName: string;
  resolve: (result: McpResult) => void;
}

export type TurnBlock = AssistantMessage["content"][number];

/** Stream bookkeeping for a block whose content_block_stop has not arrived: Anthropic's
 *  block index, and for a tool call the raw argument JSON so far. */
export interface OpenBlock {
  index: number;
  partialJson: string;
}

export function newAssistantOutput(
  model: Model<Api>,
  stopReason: AssistantMessage["stopReason"],
  text = "",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text === "" ? [] : [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    timestamp: Date.now(),
  };
}

export class QueryContext {
  // Query-scoped
  activeQuery: BridgeQuery | null = null;
  currentPiStream: AssistantMessageEventStream | null = null;
  latestCursor = 0;
  pendingToolCalls = new Map<string, PendingToolCall>();
  pendingResults = new Map<string, McpResult>();
  /** tool_use ids emitted this turn, solely to route a delivered result to the owning
   *  query when several are in flight. Pairing a result with its call uses the id
   *  Claude Code puts in tools/call `_meta`. */
  turnToolCallIds: string[] = [];
  /** Streaming-input handle for the active query: how steers reach Claude Code mid-turn. */
  promptStream: PromptStream | null = null;
  /** Last rate-limit rejection on this query. Claude Code sends it just before the
   *  failure it caused, which is the only thing tying the two together. */
  rateLimitRejection: RateLimitRejection | null = null;
  /** The pi session this query serves: one process serves several pi sessions
   *  (subagents run their own), and a history rewrite must discard only the rewriting
   *  session's parked queries. Null when the host supplied no id. */
  piSessionId: string | null = null;
  /** pi rewrote the history this query was built from. Set by the rewrite mark, consumed
   *  by the tool-result delivery that discards the query; it dies with this context. */
  historyStale = false;
  /** A steer never reached Claude Code. A first query has no session mirror yet, so
   *  completion carries this into the mirror it creates. */
  missedSteer = false;

  // Per-turn (reset together)
  turnOutput: AssistantMessage | null = null;
  turnStarted = false;
  turnSawStreamEvent = false;
  turnSawToolCall = false;
  /** API message id from the last message_start, and whether its message_stop arrived.
   *  An `assistant` message under another id while the stream is open is Claude Code's
   *  non-streaming fallback for a stalled stream. */
  turnStreamMessageId: string | undefined;
  turnStreamOpen = false;
  /** turnBlocks length at that message_start: where an abandoned attempt's blocks begin. */
  turnStreamBlockStart = 0;
  openBlocks = new Map<TurnBlock, OpenBlock>();

  get turnBlocks(): TurnBlock[] {
    if (this.turnOutput === null) throw new Error("turnBlocks accessed before resetTurnState");

    return this.turnOutput.content;
  }

  /** Answer every parked MCP handler with `reason` and forget queued results. Called when
   *  the query goes away. Handlers are resolved, not rejected: an error reply is still a
   *  reply, while a handler awaiting a dead subprocess keeps Claude Code's tools/call
   *  open forever, which wedges pi's turn behind it. */
  releasePendingToolCalls(reason: string): void {
    for (const pending of this.pendingToolCalls.values()) {
      pending.resolve({ content: [{ type: "text", text: reason }] });
    }

    this.pendingToolCalls.clear();
    this.pendingResults.clear();
  }

  resetTurnState(model: Model<Api>): void {
    this.turnOutput = newAssistantOutput(model, "stop");
    this.turnStarted = false;
    this.turnSawStreamEvent = false;
    this.turnSawToolCall = false;
    this.turnStreamMessageId = undefined;
    this.turnStreamOpen = false;
    this.turnStreamBlockStart = 0;
    this.openBlocks.clear();
    // turnToolCallIds persists across tool-result deliveries within one assistant
    // message, so results route here while its handlers are still pending.
  }
}
