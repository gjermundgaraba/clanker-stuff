// The provider's stream function. Pi calls it for each new prompt and again with each
// batch of tool results. One pi turn is one Claude Code query: a call that carries tool
// results for a parked query is routed into that query; anything else starts a fresh
// query, resuming the pi session's Claude Code conversation where it can.

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { deleteSession } from "cc-session-io";

import type { Bridge, BridgeQuery } from "./bridge.js";
import { childEnv, CLAUDE_MD_EXCLUDES, stopQuery } from "./child.js";
import { cliDebugOptions, debug, diagDump, errorMessage } from "./log.js";
import { claudeCodeModelId, effortForReasoning } from "./models.js";
import { forwardedPrompt, toBridgeContext } from "./prompt.js";
import { consumeQuery } from "./query/consume.js";
import { newAssistantOutput, QueryContext } from "./query/context.js";
import { claimCurrentPiStream, finalizeCurrentStream, markStreamComplete } from "./query/events.js";
import { makePromptStream, userMessage } from "./query/prompt-stream.js";
import type { PromptStream } from "./query/prompt-stream.js";
import {
  buildMcpServers,
  deliverToolResults,
  extractAllToolResults,
} from "./query/tool-results.js";
import { sessionCwdFor } from "./session/cwd.js";
import { isolatedSummaryStream } from "./summary.js";
import { resolveServedTools } from "./tools.js";
import { extractUserPrompt, extractUserPromptBlocks, steerBlocks } from "./turn.js";

export type ProviderStream = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/** The prompt a continuation query opens with: the pi turn goes on, but its last message
 *  is a tool result, and query() cannot resume a session without a prompt. */
export const CONTINUE_AFTER_REWRITE_PROMPT =
  "[Your context was compacted. What precedes this is a summary plus the most recent messages, " +
  "ending with the tool result you were waiting for. Continue the task from there.]";

/** The prompt a resumed tool result opens with: no query of this process was parked on
 *  it (a restart, a crash, a stall), so the turn goes on from history ending at it. */
export const CONTINUE_AFTER_RESUME_PROMPT =
  "[Your session was interrupted and resumed. What precedes this ends with the tool result " +
  "you were waiting for. Continue the task from there.]";

/** Abort teardown for one query: settle everything that would otherwise wait on a
 *  subprocess about to be killed. The pump abandons iteration on abort, so an in-flight
 *  prompt-stream push would hang forever and take tool-result delivery with it. */
export function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
  promptStream.fail(new Error("Operation aborted"));
  c.releasePendingToolCalls("Operation aborted");
}

/** Drop a query parked at a tool boundary whose conversation pi has since rewritten
 *  (/compact, tree navigation).
 *
 *  Delivering the tool result into it would hand Claude Code the context pi just shrank:
 *  the query keeps its own context inside the CLI whatever pi does to its transcript, so
 *  it answers off the pre-compaction conversation, reports pre-compaction usage, and pi
 *  compacts again at the next boundary, once per tool call. `needsRebuild` cannot prevent
 *  it, because tool-result delivery is the one call that never syncs. The caller then
 *  takes the fresh-query path, whose rebuild imports pi's rewritten history (this tool
 *  result included), so the turn continues. Nothing is lost by killing the subprocess:
 *  pi owns the only copy of the conversation that counts. */
export function discardRewrittenQuery(bridge: Bridge, c: QueryContext): void {
  const discarded = c.activeQuery;

  if (discarded !== null) bridge.abandonedQueries.add(discarded);

  c.activeQuery = null;
  // Leaving the routing set stops this result coming straight back here.
  bridge.activeQueries.delete(c);
  c.turnToolCallIds = [];
  c.promptStream?.fail(new Error("conversation rewritten"));
  c.promptStream = null;
  // Settled before the CLI is killed, for drainForAbort's reason.
  c.releasePendingToolCalls("Context was compacted; this query was discarded.");
  stopQuery(discarded);
  // The killed CLI may still flush a record into the session file, and the rebuild is
  // next: rotate rather than race it, as after an abort.
  bridge.mirrors.markRebuild(c.piSessionId, true);

  if (c.piSessionId !== null) bridge.mirrors.rewritten.delete(c.piSessionId);

  debug(
    "provider: history rewritten under a parked query; discarded it, rebuilding from current history",
  );
}

function failedStream(model: Model<Api>, failure: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  queueMicrotask(() => {
    stream.push({
      type: "error",
      reason: "error",
      error: newAssistantOutput(model, "error", "", failure),
    });
    markStreamComplete(stream);
    stream.end();
  });

  return stream;
}

export function createProviderStream(bridge: Bridge): ProviderStream {
  return (model, transcript, options) => streamClaudeCode(bridge, model, transcript, options);
}

function streamClaudeCode(
  bridge: Bridge,
  model: Model<Api>,
  transcript: TranscriptContext,
  options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
  // Pi's compaction, branch-summary and bug-report calls use cacheRetention "none". Their
  // prompts are one-off requests, so they run isolated, without session sync.
  if (options?.cacheRetention === "none") {
    debug("provider: one-off summarizer call (cacheRetention none) routed to isolated summary");

    return isolatedSummaryStream(bridge, model, transcript, options);
  }

  const context = toBridgeContext(transcript);
  const stream = createAssistantMessageEventStream();
  const lastRole = context.messages.at(-1)?.role;
  let activeQuery = bridge.topLevel.activeQuery !== null;

  debug(
    `provider: stream called, activeQuery=${activeQuery}, lastMsgRole=${lastRole}, msgs=${context.messages.length}`,
  );

  const allResults = bridge.activeQueries.size > 0 ? extractAllToolResults(context.messages) : [];
  let resultCtx = allResults.length > 0 ? bridge.contextForToolResults(allResults) : undefined;
  // pi rewrote its history while this query sat parked at a tool boundary: discard it
  // and let this tool result carry the turn into a fresh query over the new history. The
  // mark is per pi session, so a subagent's compaction never discards its parent's query.
  const rewrittenUnderQuery = resultCtx?.historyStale === true;

  if (resultCtx !== undefined && rewrittenUnderQuery) {
    discardRewrittenQuery(bridge, resultCtx);
    resultCtx = undefined;
    // Recomputed, not cleared: a reentrant subagent may still hold a query of its own.
    activeQuery = bridge.topLevel.activeQuery !== null;
  }

  if (activeQuery && lastRole === "user" && allResults.length === 0) {
    debug(
      `provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${bridge.topLevel.pendingToolCalls.size}`,
    );
  }

  // Tool-result delivery. Results that arrive before their handler wait in pendingResults.
  if (resultCtx !== undefined) {
    const c = resultCtx;

    claimCurrentPiStream(stream, "tool-result", c);
    c.resetTurnState(model);

    // A rewrite that armed after this query parked is copied here, though markRebuild
    // usually reaches the context directly.
    if (!c.historyStale && c.piSessionId !== null && bridge.mirrors.rewritten.has(c.piSessionId)) {
      c.historyStale = true;
    }

    // A steer pi drained at the turn boundary arrives as a user message beside the
    // results. Delivery is async because the steer must reach stdin before the result
    // does; it is detached so the stream still returns synchronously.
    const steer = lastRole === "user" ? steerBlocks(context.messages) : undefined;

    void deliverToolResults(
      c,
      allResults,
      steer,
      (target, text) => bridge.missedSteer(target, text),
      (message) => bridge.notify(message),
    );

    // The shared cursor tracks the top-level conversation; a reentrant subagent
    // delivering its own results must not drag it to the subagent's message count.
    const state = bridge.mirrors.get(c.piSessionId);

    if (state !== undefined) state.cursor = context.messages.length;

    c.latestCursor = Math.max(c.latestCursor, context.messages.length);

    return stream;
  }

  // A tool result with no parked query. After an abort during a tool call, pi calls back
  // with the run's already-aborted signal: end the turn so pi waits for the next real
  // message. A result arriving otherwise (a restart, crash, stall, or retry) falls through
  // to the fresh-query path, which resumes the session and delivers it.
  const unparkedToolResult = lastRole === "toolResult" && !rewrittenUnderQuery;

  if (unparkedToolResult && options?.signal?.aborted === true) {
    debug("provider: orphaned tool result after abort, emitting end_turn");

    // With no query in flight, the session this result belongs to is the one whose turn
    // just ended: its cursor advances to count it.
    const orphanState = bridge.mirrors.get(options.sessionId ?? null);

    if (orphanState !== undefined && bridge.activeQueries.size === 0) {
      orphanState.cursor = context.messages.length;
    }

    // No query owns this result, so no context is reset: resetting the top-level one
    // would replace a live parent's output mid-stream.
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, "stop") });
      markStreamComplete(stream);
      stream.end();
    });

    return stream;
  }

  return startQuery(bridge, model, context, options, stream, {
    reentrant: activeQuery,
    rewrittenUnderQuery,
    unparkedToolResult,
  });
}

interface QueryStart {
  /** Another query is live: this one gets its own context and runs beside it. */
  reentrant: boolean;
  rewrittenUnderQuery: boolean;
  unparkedToolResult: boolean;
}

function startQuery(
  bridge: Bridge,
  model: Model<Api>,
  context: ReturnType<typeof toBridgeContext>,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
  start: QueryStart,
): AssistantMessageEventStream {
  const queryCtx = start.reentrant ? new QueryContext() : bridge.topLevel;

  debug(
    `provider: fresh query setup, isReentrant=${start.reentrant}, activeContexts=${bridge.activeQueries.size}`,
  );

  const served = resolveServedTools(context.tools, bridge.toolGuidelines());
  // Resolved first: a prompt the gate refuses fails the query before anything is claimed,
  // leaving no half-built query (and no claimed stream nobody ends).
  let systemPromptAppend: string | undefined;

  try {
    systemPromptAppend = forwardedPrompt(context.system);
  } catch (error) {
    // Reported on the stream, as pi-ai's provider contract expects, so any caller sees a
    // failed turn rather than a synchronous exception.
    debug("provider: prompt refused", errorMessage(error));

    return failedStream(model, errorMessage(error));
  }

  claimCurrentPiStream(stream, "fresh-query", queryCtx);
  queryCtx.pendingToolCalls.clear();
  queryCtx.pendingResults.clear();
  // Stale ids would let a late result from the previous query route here, which now
  // means pushing its steer into this query's stdin.
  queryCtx.turnToolCallIds = [];
  queryCtx.resetTurnState(model);
  queryCtx.latestCursor = 0;
  queryCtx.piSessionId = options?.sessionId ?? null;
  // A discarded query's replacement reuses this context; without the reset its first
  // tool result would sit on armed staleness and re-discard a healthy query.
  queryCtx.historyStale = false;
  queryCtx.missedSteer = false;

  const piSessionId = queryCtx.piSessionId;
  const cwd = sessionCwdFor(piSessionId);
  // The id actually sent to Claude Code (may carry [1m]); model.id is pi's.
  const cliModel = claudeCodeModelId(model.id);

  // Read before it is consumed: with no query parked (an overflow retried after
  // compaction), the session's mark is the only sign of the rewrite.
  const historyRewritten =
    start.rewrittenUnderQuery ||
    (piSessionId !== null && bridge.mirrors.rewritten.has(piSessionId));

  const syncResult = bridge.mirrors.sync(
    context.messages,
    cwd,
    served.toSdk,
    cliModel,
    piSessionId,
  );

  // This query starts from the history pi has now; a sibling session's mark stays armed.
  if (piSessionId !== null) bridge.mirrors.rewritten.delete(piSessionId);

  const promptBlocks = extractUserPromptBlocks(context.messages);
  let promptText = extractUserPrompt(context.messages) ?? "";

  // A turn continuing past a rewrite ends at its tool result, not a prompt: say what
  // happened. The rebuilt session already ends with the result after its tool call.
  if (historyRewritten && promptText === "" && promptBlocks === undefined) {
    promptText = CONTINUE_AFTER_REWRITE_PROMPT;
    debug(
      `provider: continuing the turn after a rewritten history, ${context.messages.length} msgs rebuilt`,
    );
  }

  if (start.unparkedToolResult && promptText === "" && promptBlocks === undefined) {
    promptText = CONTINUE_AFTER_RESUME_PROMPT;
    debug(
      `provider: resuming the turn at a tool result with no parked query, ${context.messages.length} msgs`,
    );
  }

  // The last context message should be a user message by now; dump what it was if not.
  if (promptText === "" && promptBlocks === undefined) {
    diagDump("empty_prompt", {
      contextLength: context.messages.length,
      lastMsgRole: context.messages.at(-1)?.role ?? null,
      isReentrant: start.reentrant,
      activeQueryContexts: bridge.activeQueries.size,
      messageRoles: context.messages.map((message, index) => `[${index}]${message.role}`).join(" "),
    });
    // So the SDK does not send an empty text block.
    promptText = "[continue]";
  }

  // Always streamed rather than passed as a string: a parked input generator is what lets
  // steers reach stdin mid-turn. The SDK then no longer closes stdin on the first result,
  // so consumeQuery ends the stream explicitly or the query would never terminate.
  const promptStream = makePromptStream();

  promptStream
    .push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
    .catch((error: unknown) => {
      debug("provider: initial prompt push rejected:", error);
    });
  queryCtx.promptStream = promptStream;

  const mcpServers = buildMcpServers(served.tools, queryCtx);
  // Claude Code would otherwise load MCP servers from ~/.claude.json and .mcp.json; pi
  // executes tools, so they are pure token overhead.
  const effort = effortForReasoning(model, options?.reasoning);

  const extraArgs: NonNullable<Options["extraArgs"]> = {
    model: cliModel,
    "strict-mcp-config": null,
  };

  // Some models default thinking display to "omitted" (empty thinking text in the stream).
  if (effort !== undefined) extraArgs["thinking-display"] = "summarized";

  const resumeSessionId = syncResult.sessionId;

  const queryOptions: Options = {
    cwd,
    env: childEnv(),
    tools: [],
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
    settings: {
      autoMemoryEnabled: false,
      claudeMdExcludes: CLAUDE_MD_EXCLUDES,
      // The git-status block is the trailing suffix of the cached system block, so any
      // git transition (new file, staging, commit) would bust the prompt cache for the
      // whole conversation. It costs nothing here: the provider path runs no native tools.
      includeGitInstructions: false,
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(systemPromptAppend === undefined ? {} : { append: systemPromptAppend }),
    },
    extraArgs,
    ...(effort === undefined ? {} : { effort }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(resumeSessionId === null ? {} : { resume: resumeSessionId }),
    ...cliDebugOptions("provider"),
  };

  debug(
    "provider: fresh query",
    `model=${cliModel} msgs=${context.messages.length} tools=${served.tools.length}`,
    `resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
    `append=${systemPromptAppend?.length ?? 0} chars`,
    `prompt=${promptText.slice(0, 60)}${promptBlocks === undefined ? "" : " [+images]"}`,
  );

  const sdkQuery = bridge.runQuery({ prompt: promptStream.stream, options: queryOptions });
  let wasAborted = false;

  queryCtx.activeQuery = sdkQuery;
  bridge.activeQueries.add(queryCtx);

  const onAbort = (): void => {
    wasAborted = true;
    drainForAbort(queryCtx, promptStream);
    stopQuery(sdkQuery);
  };

  if (options?.signal?.aborted === true) onAbort();
  else options?.signal?.addEventListener("abort", onAbort, { once: true });

  const aborted = (): boolean => wasAborted || options?.signal?.aborted === true;

  consumeQuery(
    sdkQuery,
    served.toPi,
    model,
    () => wasAborted,
    queryCtx,
    (message) => bridge.notify(message),
  )
    .then((capturedSessionId) => {
      onQueryDone(bridge, model, queryCtx, sdkQuery, {
        capturedSessionId,
        aborted: aborted(),
        reentrant: start.reentrant,
        preserveSharedSession: syncResult.preserveSharedSession === true,
        cwd,
        contextLength: context.messages.length,
      });
    })
    .catch((error: unknown) => {
      debug(`provider: query error, model=${cliModel}, aborted=${aborted()}, error=`, error);
      onQueryFailed(bridge, model, queryCtx, sdkQuery, promptStream, error, {
        aborted: aborted(),
        signalAborted: options?.signal?.aborted === true,
        reentrant: start.reentrant,
      });
    })
    .finally(() => {
      options?.signal?.removeEventListener("abort", onAbort);
      // Settle any ack still parked in the generator; the CLI is gone. The handle is
      // cleared only if a later query has not claimed the shared context.
      promptStream.fail(new Error("query ended"));

      if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;

      // A later query claiming this context sets its own handle; null means ours was
      // cleared and nothing replaced it. Testing only for `=== sdkQuery` would leave the
      // top-level context in the routing set forever, where a later orphaned tool result
      // matches its stale ids and takes the delivery branch, returning a stream nothing
      // ends.
      if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
        queryCtx.releasePendingToolCalls("Query ended");
        queryCtx.activeQuery = null;
        bridge.activeQueries.delete(queryCtx);
      }

      sdkQuery.close();
    });

  return stream;
}

interface QueryDone {
  capturedSessionId: string | undefined;
  aborted: boolean;
  reentrant: boolean;
  preserveSharedSession: boolean;
  cwd: string;
  contextLength: number;
}

function onQueryDone(
  bridge: Bridge,
  model: Model<Api>,
  c: QueryContext,
  sdkQuery: BridgeQuery,
  done: QueryDone,
): void {
  debug(
    `provider: consumeQuery completed, stopReason=${c.turnOutput?.stopReason}, error=${c.turnOutput?.errorMessage}, aborted=${done.aborted}`,
  );

  // Discarded out from under: the replacement owns the context, session and stream, and
  // capturing this session id would put Claude Code back on the discarded conversation.
  if (bridge.abandonedQueries.has(sdkQuery)) {
    debug("provider: discarded query completed, leaving session and stream to its replacement");

    return;
  }

  if (done.aborted) {
    // The killed subprocess may flush a late record into the file: rebuild and rotate.
    bridge.mirrors.markRebuild(c.piSessionId, true);
    debug("provider: abort detected, marked sharedSession needsRebuild + forceRotate");

    const output = c.turnOutput ?? newAssistantOutput(model, "aborted");

    output.stopReason = "aborted";
    output.errorMessage = "Operation aborted";

    const stream = c.currentPiStream;

    stream?.push({ type: "error", reason: "aborted", error: output });
    markStreamComplete(stream);
    stream?.end();
    c.currentPiStream = null;

    return;
  }

  // This query's own mirror: a reentrant subagent completing must not reassign the
  // parent's conversation to the child's file.
  const state = bridge.mirrors.get(c.piSessionId);

  if (done.preserveSharedSession) {
    if (done.capturedSessionId !== undefined && done.capturedSessionId !== state?.sessionId) {
      deleteSession(done.capturedSessionId, done.cwd, process.env.CLAUDE_CONFIG_DIR);
      debug(
        `provider: query done, deleted ephemeral session ${done.capturedSessionId.slice(0, 8)} to preserve shared session`,
      );
    }
  } else {
    const sessionId = done.capturedSessionId ?? state?.sessionId;

    if (sessionId !== undefined) {
      const cursor = Math.max(done.contextLength, c.latestCursor, state?.cursor ?? 0);

      debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
      // A missed steer may precede the first mirror or arrive while this query can
      // still complete; both rebuild signals are kept.
      bridge.mirrors.set(c.piSessionId, {
        ...state,
        sessionId,
        cursor,
        cwd: done.cwd,
        piSessionId: c.piSessionId ?? undefined,
        needsRebuild: c.missedSteer || state?.needsRebuild === true,
      });
    }
  }

  if (!done.reentrant && c.activeQuery === sdkQuery) {
    debug("provider: clearing activeQuery before final stream completion");
    c.activeQuery = null;
  }

  finalizeCurrentStream(c);
}

interface QueryFailure {
  aborted: boolean;
  signalAborted: boolean;
  reentrant: boolean;
}

function onQueryFailed(
  bridge: Bridge,
  model: Model<Api>,
  c: QueryContext,
  sdkQuery: BridgeQuery,
  promptStream: PromptStream,
  error: unknown,
  failure: QueryFailure,
): void {
  if (bridge.abandonedQueries.has(sdkQuery)) {
    debug(
      "provider: discarded query ended in error, leaving session and stream to its replacement",
    );

    return;
  }

  if (failure.aborted) {
    bridge.mirrors.markRebuild(c.piSessionId, true);
  } else {
    // This session's conversation is in an unknown state after the error. Other
    // sessions' mirrors stay: one session's failure says nothing about another's.
    bridge.mirrors.set(c.piSessionId, undefined);
  }

  promptStream.fail(error instanceof Error ? error : new Error(String(error)));

  const reason = failure.signalAborted ? "aborted" : "error";
  const output = c.turnOutput ?? newAssistantOutput(model, reason);

  output.stopReason = reason;
  // The SDK drops its copy of the result text when any message follows the error
  // result, so the cause consumeQuery recorded off the result itself wins.
  output.errorMessage ??= errorMessage(error);

  if (!failure.reentrant && c.activeQuery === sdkQuery) {
    c.releasePendingToolCalls("Query ended");
    debug("provider: clearing activeQuery before error stream completion");
    c.activeQuery = null;
  }

  const stream = c.currentPiStream;

  stream?.push({ type: "error", reason, error: output });
  markStreamComplete(stream);
  stream?.end();
  c.currentPiStream = null;
}
