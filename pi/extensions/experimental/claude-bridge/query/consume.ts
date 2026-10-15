// The background consumer of one Claude Code query.

import { appendFileSync } from "node:fs";

import type { Api, Model } from "@earendil-works/pi-ai";
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";

import type { BridgeQuery } from "../child.js";

import { debug } from "../log.js";
import type { QueryContext } from "./context.js";
import { ensureTurnStarted, processAssistantMessage, processStreamEvent } from "./events.js";
import {
  describeRateLimitFailure,
  logServedContextWindow,
  rateLimitNotice,
  rateLimitRejection,
  resultErrorText,
} from "./result.js";

/** A rejection names the failure Claude Code sends next as a rate limit. */
function noteRateLimitRejection(
  c: QueryContext,
  info: SDKRateLimitInfo,
  notify: (message: string) => void,
): void {
  const rejection = rateLimitRejection(info);

  if (rejection === undefined) return;

  c.rateLimitRejection = rejection;
  notify(rateLimitNotice(rejection));
}

/** Iterates the SDK generator, pushing events to the current pi stream, until the query
 *  ends. Per turn the SDK yields stream events (deltas), then an assistant message
 *  (completed blocks). On a tool call, whichever handles it first ends the pi stream, and
 *  the MCP handler blocks the generator until pi delivers the result. */
export async function consumeQuery(
  sdkQuery: BridgeQuery,
  toPi: ReadonlyMap<string, string>,
  model: Model<Api>,
  wasAborted: () => boolean,
  c: QueryContext,
  notify: (message: string) => void,
): Promise<string | undefined> {
  let capturedSessionId: string | undefined;

  for await (const message of sdkQuery) {
    // CLAUDE_BRIDGE_RECORD_STREAM=<path> appends every SDK message as a JSON line, for
    // capturing replay fixtures of what Claude Code really emits.
    const recordStreamPath = process.env.CLAUDE_BRIDGE_RECORD_STREAM;

    if (recordStreamPath !== undefined && recordStreamPath !== "") {
      appendFileSync(recordStreamPath, `${JSON.stringify(message)}\n`);
    }

    if (wasAborted()) break;

    // Everything below the current-stream guard is content, which has nowhere to go once
    // a turn ended on a tool call. Three things are not content and must not share it:
    // closing stdin (nothing else closes it for a streamed prompt, so the query would
    // hang), the failure a `result` carries (the only record the turn failed at all), and
    // rate-limit events (most likely during exactly the long tool-using turns the guard
    // skips).
    let resultError: string | undefined;

    if (message.type === "result") {
      c.promptStream?.end();
      logServedContextWindow("result", message, model);
      resultError = resultErrorText(message);

      if (resultError !== undefined) {
        // Consumed with the failure it caused, so a later unrelated failure on this query
        // does not inherit the label.
        if (c.rateLimitRejection !== null) {
          resultError = describeRateLimitFailure(c.rateLimitRejection, resultError);
          c.rateLimitRejection = null;
        }

        debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);

        if (c.turnOutput !== null) {
          c.turnOutput.stopReason = "error";
          c.turnOutput.errorMessage = resultError;
        }
      }
    }

    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info;

      debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
      noteRateLimitRejection(c, info, notify);
      continue;
    }

    if (c.currentPiStream === null || c.turnOutput === null) continue;

    switch (message.type) {
      case "stream_event":
        processStreamEvent(message, toPi, model, c);
        break;
      case "assistant":
        processAssistantMessage(message, model, toPi, c);
        break;
      case "result":
        // The failure was recorded above. What is left is the success path: push the
        // result text when no assistant message delivered it.
        if (resultError === undefined && !c.turnSawStreamEvent && message.subtype === "success") {
          ensureTurnStarted(c);

          const text = message.result;

          c.turnBlocks.push({ type: "text", text });

          const contentIndex = c.turnBlocks.length - 1;

          c.currentPiStream.push({ type: "text_start", contentIndex, partial: c.turnOutput });
          c.currentPiStream.push({
            type: "text_delta",
            contentIndex,
            delta: text,
            partial: c.turnOutput,
          });
          c.currentPiStream.push({
            type: "text_end",
            contentIndex,
            content: text,
            partial: c.turnOutput,
          });
        }

        break;
      case "system":
        if (message.subtype === "init") capturedSessionId = message.session_id;
        break;
      case "user":
        // The SDK's echo of prompts and tool results. A steer Claude Code drained at a
        // tool boundary never appears here (it is recorded as a `queued_command`
        // attachment), so steering can only be verified end to end.
        break;
      default:
        debug("consumeQuery: unhandled SDK message type", message.type);
        break;
    }
  }

  debug(
    `consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`,
  );

  return capturedSessionId;
}
