// Claude Code's stream → pi's assistant-message events.
//
// Push-based streaming with the MCP tool bridge:
// 1. The provider starts a query() and consumes it in the background.
// 2. Each SDK message is mapped onto the pi stream of the current provider call.
// 3. On a tool call, that pi stream ends with `toolUse`. The MCP handler for the call
//    blocks the SDK generator, so nothing more arrives until it is resolved.
// 4. Pi runs the tool and calls the provider again; the new pi stream is claimed, the
//    handler resolved, and events flow on into the new stream.

import type {
  Api,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { toJsonObject } from "../json.js";
import { debug } from "../log.js";
import { mapToolArgs, piToolNameFor } from "../tools.js";
import type { QueryContext, TurnBlock } from "./context.js";
import { recordUsage } from "./usage.js";

const completedStreams = new WeakSet<AssistantMessageEventStream>();

export function markStreamComplete(stream: AssistantMessageEventStream | null): void {
  if (stream !== null) completedStreams.add(stream);
}

export function claimCurrentPiStream(
  stream: AssistantMessageEventStream,
  label: string,
  c: QueryContext,
): void {
  if (c.currentPiStream !== null && !completedStreams.has(c.currentPiStream)) {
    debug(
      `WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${c.activeQuery !== null} pendingHandlers=${c.pendingToolCalls.size}`,
    );
  }

  c.currentPiStream = stream;
}

export function ensureTurnStarted(c: QueryContext): void {
  if (c.turnStarted || c.currentPiStream === null || c.turnOutput === null) return;

  c.currentPiStream.push({ type: "start", partial: c.turnOutput });
  c.turnStarted = true;
}

export function finalizeCurrentStream(c: QueryContext): void {
  const stream = c.currentPiStream;
  const output = c.turnOutput;

  if (stream === null || output === null) return;

  debug(
    `provider: finalizeCurrentStream, stopReason=${output.stopReason}, error=${output.errorMessage ?? "none"}`,
  );
  ensureTurnStarted(c);

  if (output.stopReason === "error") {
    stream.push({ type: "error", reason: "error", error: output });
  } else {
    stream.push({
      type: "done",
      reason: output.stopReason === "length" ? "length" : "stop",
      message: output,
    });
  }

  markStreamComplete(stream);
  stream.end();
  c.currentPiStream = null;
}

/** End this pi stream so pi can run the tool. The SDK still yields an assistant message
 *  for the turn, but with no current stream it is skipped, and the MCP handler blocks the
 *  generator until pi delivers the result through the next provider call, which also
 *  advances the cursor. */
function endStreamForToolUse(c: QueryContext): void {
  const stream = c.currentPiStream;
  const output = c.turnOutput;

  if (stream === null || output === null) return;

  output.stopReason = "toolUse";
  stream.push({ type: "done", reason: "toolUse", message: output });
  markStreamComplete(stream);
  stream.end();
  c.currentPiStream = null;
}

function mapStopReason(reason: string | null | undefined): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

function parsePartialJson(input: string, fallback: JsonObject): JsonObject {
  if (input === "") return fallback;

  try {
    return toJsonObject(JSON.parse(input)) ?? fallback;
  } catch {
    return fallback;
  }
}

const openBlockAt = (c: QueryContext, index: number): number =>
  c.turnBlocks.findIndex((block) => c.openBlocks.get(block)?.index === index);

function refreshToolCallState(c: QueryContext): void {
  c.turnToolCallIds = c.turnBlocks.flatMap((block) =>
    block.type === "toolCall" ? [block.id] : [],
  );
  c.turnSawToolCall = c.turnToolCallIds.length > 0;
}

const describeBlock = (block: TurnBlock): string =>
  block.type === "toolCall" ? `toolCall[${block.id}]` : block.type;

/** Remove the blocks of the message that just stopped which never got their own
 *  content_block_stop because the stream was cut inside them. Such a tool call carries
 *  whatever JSON survived (`{}` when no delta landed) under an id Claude Code drops before
 *  resuming the turn, so nothing could ever answer a result keyed to it; a thinking block
 *  left that way has no signature.
 *
 *  Per block rather than per message: Claude Code keeps the blocks that did complete,
 *  tool calls included, and one it dispatched while pi was never told is the same
 *  deadlock the other way round. This does not end the pi turn; the resume is more of the
 *  same turn. */
function dropUnfinishedStreamBlocks(c: QueryContext, why: string): void {
  const dropped: string[] = [];

  for (let index = c.turnBlocks.length - 1; index >= c.turnStreamBlockStart; index--) {
    const block = c.turnBlocks[index];

    if (block === undefined || !c.openBlocks.has(block)) continue;

    dropped.unshift(describeBlock(block));
    c.openBlocks.delete(block);
    c.turnBlocks.splice(index, 1);
  }

  if (dropped.length === 0) return;

  debug(`dropUnfinishedStreamBlocks: ${why}; dropped ${dropped.join(",")}`);
  refreshToolCallState(c);
}

/** Remove the blocks of a stream Claude Code abandoned mid-message: a thinking block
 *  without a signature, or a tool call it will never dispatch. Left in, pi would run the
 *  tool and the turn would wait on a handler that never comes. The fallback restarts
 *  those indices, which pi's provider path tolerates. */
function dropAbandonedStreamBlocks(c: QueryContext, why: string): void {
  const dropped = c.turnBlocks.splice(c.turnStreamBlockStart);

  for (const block of dropped) c.openBlocks.delete(block);

  debug(
    `dropAbandonedStreamBlocks: ${why}; dropped ${dropped.length} blocks from ${c.turnStreamMessageId} types=${dropped.map((block) => block.type).join(",")}`,
  );
  c.turnToolCallIds = [];
  c.turnSawToolCall = c.turnBlocks.some((block) => block.type === "toolCall");
  c.turnStreamOpen = false;
}

/** Maps one Anthropic stream event onto pi stream events. On message_stop after a tool
 *  call, ends the pi stream so pi can run the tool. */
export function processStreamEvent(
  message: SDKPartialAssistantMessage,
  toPi: ReadonlyMap<string, string>,
  model: Model<Api>,
  c: QueryContext,
): void {
  const stream = c.currentPiStream;
  const output = c.turnOutput;

  if (stream === null || output === null) return;

  c.turnSawStreamEvent = true;

  const { event } = message;

  switch (event.type) {
    case "message_start": {
      // Still open from an earlier message_start: Claude Code gave up on that stream and
      // is retrying it, and its blocks never completed.
      if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `restreamed as ${event.message.id}`);

      c.turnToolCallIds = [];
      c.turnStreamMessageId = event.message.id;
      c.turnStreamOpen = true;
      c.turnStreamBlockStart = c.turnBlocks.length;
      recordUsage(output, event.message.usage, model);

      return;
    }

    case "content_block_start": {
      ensureTurnStarted(c);

      const block = event.content_block;

      if (block.type === "text") {
        const text: TurnBlock = { type: "text", text: "" };

        c.turnBlocks.push(text);
        c.openBlocks.set(text, { index: event.index, partialJson: "" });
        stream.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: output });
      } else if (block.type === "thinking") {
        const thinking: TurnBlock = { type: "thinking", thinking: "", thinkingSignature: "" };

        c.turnBlocks.push(thinking);
        c.openBlocks.set(thinking, { index: event.index, partialJson: "" });
        stream.push({
          type: "thinking_start",
          contentIndex: c.turnBlocks.length - 1,
          partial: output,
        });
      } else if (block.type === "tool_use") {
        const piName = piToolNameFor(block.name, toPi);

        if (piName === undefined) {
          debug(
            `processStreamEvent: skipping tool_use for unserved tool ${block.name} [${block.id}]; CC rejects it and retries`,
          );

          return;
        }

        const toolCall: TurnBlock = {
          type: "toolCall",
          id: block.id,
          name: piName,
          arguments: toJsonObject(block.input) ?? {},
        };

        c.turnToolCallIds.push(block.id);
        c.turnBlocks.push(toolCall);
        c.openBlocks.set(toolCall, { index: event.index, partialJson: "" });
        stream.push({
          type: "toolcall_start",
          contentIndex: c.turnBlocks.length - 1,
          partial: output,
        });
      } else {
        debug("processStreamEvent: unhandled content_block_start type", block.type);
      }

      return;
    }

    case "content_block_delta": {
      const index = openBlockAt(c, event.index);
      const block = c.turnBlocks[index];
      const open = block === undefined ? undefined : c.openBlocks.get(block);

      if (block === undefined || open === undefined) return;

      const { delta } = event;

      if (delta.type === "text_delta" && block.type === "text") {
        block.text += delta.text;
        stream.push({
          type: "text_delta",
          contentIndex: index,
          delta: delta.text,
          partial: output,
        });
      } else if (delta.type === "thinking_delta" && block.type === "thinking") {
        block.thinking += delta.thinking;
        stream.push({
          type: "thinking_delta",
          contentIndex: index,
          delta: delta.thinking,
          partial: output,
        });
      } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
        open.partialJson += delta.partial_json;
        block.arguments = parsePartialJson(open.partialJson, block.arguments);
        stream.push({
          type: "toolcall_delta",
          contentIndex: index,
          delta: delta.partial_json,
          partial: output,
        });
      } else if (delta.type === "signature_delta" && block.type === "thinking") {
        block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
      } else {
        debug("processStreamEvent: unhandled content_block_delta type", delta.type);
      }

      return;
    }

    case "content_block_stop": {
      const index = openBlockAt(c, event.index);
      const block = c.turnBlocks[index];
      const open = block === undefined ? undefined : c.openBlocks.get(block);

      if (block === undefined || open === undefined) return;

      c.openBlocks.delete(block);

      if (block.type === "text") {
        stream.push({
          type: "text_end",
          contentIndex: index,
          content: block.text,
          partial: output,
        });
      } else if (block.type === "thinking") {
        stream.push({
          type: "thinking_end",
          contentIndex: index,
          content: block.thinking,
          partial: output,
        });
      } else {
        c.turnSawToolCall = true;
        block.arguments = mapToolArgs(
          block.name,
          parsePartialJson(open.partialJson, block.arguments),
        );
        stream.push({
          type: "toolcall_end",
          contentIndex: index,
          toolCall: block,
          partial: output,
        });
      }

      return;
    }

    case "message_delta": {
      output.stopReason = mapStopReason(event.delta.stop_reason);
      recordUsage(output, event.usage, model);

      return;
    }

    case "message_stop": {
      dropUnfinishedStreamBlocks(c, `message_stop for ${c.turnStreamMessageId}`);
      c.turnStreamOpen = false;

      if (c.turnSawToolCall) endStreamForToolUse(c);

      return;
    }
  }
}

// The SDK always yields `assistant` messages (completed blocks) after streaming. When
// stream events already delivered the content this is a no-op, but after a tool-result
// delivery the next turn's assistant message can arrive before any stream event, making
// this the primary content path. It must keep the same stream lifecycle, including
// ending the stream on tool_use to avoid deadlocking the MCP handler.
//
// It is also the content path when a stream stalls: Claude Code drops it and asks again
// without streaming, and the answer arrives as one assistant message under a new message
// id with no stream events of its own.
export function processAssistantMessage(
  message: SDKAssistantMessage,
  model: Model<Api>,
  toPi: ReadonlyMap<string, string>,
  c: QueryContext,
): void {
  const assistant = message.message;
  const output = c.turnOutput;

  if (output === null) return;

  // Claude Code reports API failures and its own quota or context notices as a
  // `<synthetic>` assistant message: a report, not model output. Streaming its text would
  // commit output before the failure it describes, and a consumer that fails over only
  // before output commits could not reach its next provider. The wording stays on the
  // failed turn (the error event carries it), but no events are emitted.
  if (assistant.model === "<synthetic>") {
    // It can follow a stalled stream whose non-streaming retry also failed.
    if (c.turnSawStreamEvent && c.turnStreamOpen) {
      dropAbandonedStreamBlocks(c, "synthetic failure report");
    }

    debug(
      `processAssistantMessage: <synthetic> message, keeping ${assistant.content.length} block(s) off the stream`,
    );

    for (const block of assistant.content) {
      if (block.type === "text" && block.text !== "") {
        c.turnBlocks.push({ type: "text", text: block.text });
      } else {
        debug("processAssistantMessage: unhandled <synthetic> block type", block.type);
      }
    }

    recordUsage(output, assistant.usage, model);

    return;
  }

  if (c.turnSawStreamEvent) {
    // The same id was already delivered; a new id is the non-streaming fallback. Drop the
    // stalled stream's partial blocks if it never stopped. Delivered even if it stopped,
    // at the risk of duplication should Claude Code renumber it.
    if (c.turnStreamMessageId === undefined || assistant.id === c.turnStreamMessageId) return;

    if (c.turnStreamOpen) dropAbandonedStreamBlocks(c, `non-streaming fallback ${assistant.id}`);
  }

  c.turnToolCallIds = [];
  debug(
    `processAssistantMessage fallback: ${assistant.content.length} blocks, types=${assistant.content.map((block) => block.type).join(",")}`,
  );

  const stream = c.currentPiStream;

  for (const block of assistant.content) {
    if (block.type === "text") {
      if (block.text === "") continue;

      ensureTurnStarted(c);
      c.turnBlocks.push({ type: "text", text: block.text });

      const contentIndex = c.turnBlocks.length - 1;

      stream?.push({ type: "text_start", contentIndex, partial: output });
      stream?.push({ type: "text_delta", contentIndex, delta: block.text, partial: output });
      stream?.push({ type: "text_end", contentIndex, content: block.text, partial: output });
    } else if (block.type === "thinking") {
      ensureTurnStarted(c);
      c.turnBlocks.push({
        type: "thinking",
        thinking: block.thinking,
        thinkingSignature: block.signature,
      });

      const contentIndex = c.turnBlocks.length - 1;

      stream?.push({ type: "thinking_start", contentIndex, partial: output });

      if (block.thinking !== "") {
        stream?.push({
          type: "thinking_delta",
          contentIndex,
          delta: block.thinking,
          partial: output,
        });
      }

      stream?.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial: output,
      });
    } else if (block.type === "tool_use") {
      const piName = piToolNameFor(block.name, toPi);

      if (piName === undefined) {
        debug(
          `processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}]; CC rejects it and retries`,
        );
        continue;
      }

      ensureTurnStarted(c);
      c.turnSawToolCall = true;
      c.turnToolCallIds.push(block.id);

      const toolCall: ToolCall = {
        type: "toolCall",
        id: block.id,
        name: piName,
        arguments: mapToolArgs(piName, toJsonObject(block.input) ?? {}),
      };

      c.turnBlocks.push(toolCall);

      const contentIndex = c.turnBlocks.length - 1;

      stream?.push({ type: "toolcall_start", contentIndex, partial: output });
      stream?.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
    } else {
      debug("processAssistantMessage: unhandled block type", block.type);
    }
  }

  recordUsage(output, assistant.usage, model);

  // End the stream on tool_use, as processStreamEvent's message_stop does.
  if (c.turnSawToolCall) endStreamForToolUse(c);
}
