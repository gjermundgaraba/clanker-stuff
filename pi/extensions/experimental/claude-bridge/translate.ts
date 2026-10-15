// Claude Code's messages → pi's assistant-message events, one provider call at a time.
//
// A `Turn` is the output of one provider call: the assistant message being built and the
// pi stream it is pushed to. Claude Code streams each API response as events and then
// repeats it as one complete `assistant` message; either can carry the content first.
// A tool call ends the turn with `toolUse` so pi can run the tool, and the next provider
// call opens a new turn.

import { parseStreamingJson } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  JsonObject,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";

import { toJsonObject } from "./json.js";
import { debug } from "./log.js";
import { recordUsage } from "./query/usage.js";
import { mapToolArgs, piToolName } from "./tools.js";

export type TurnBlock = AssistantMessage["content"][number];

/** A block whose content_block_stop has not arrived: Anthropic's block index, and for a
 *  tool call the raw argument JSON so far. */
interface OpenBlock {
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

export function mapStopReason(reason: string | null | undefined): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

/** A tool call's arguments from the JSON streamed so far, partial objects included. */
const streamedArguments = (json: string, fallback: JsonObject): JsonObject =>
  json === "" ? fallback : (toJsonObject(parseStreamingJson(json)) ?? fallback);

const describeBlock = (block: TurnBlock): string =>
  block.type === "toolCall" ? `toolCall[${block.id}]` : block.type;

export class Turn {
  readonly output: AssistantMessage;

  /** The stream was ended: on a tool call, completion or failure. Nothing more reaches it. */
  ended = false;

  private started = false;
  private sawStreamEvent = false;
  private sawToolCall = false;
  /** API message id from the last message_start, and whether its message_stop arrived.
   *  An `assistant` message under another id while the stream is open is Claude Code's
   *  non-streaming fallback for a stalled stream. */
  private streamMessageId: string | undefined;
  private streamOpen = false;
  /** Block count at that message_start: where an abandoned attempt's blocks begin. */
  private streamBlockStart = 0;
  private readonly openBlocks = new Map<TurnBlock, OpenBlock>();

  constructor(
    private readonly model: Model<Api>,
    readonly stream: AssistantMessageEventStream,
    /** The pi names of the tools the query serves. */
    private readonly served: ReadonlySet<string>,
  ) {
    this.output = newAssistantOutput(model, "stop");
  }

  private get blocks(): TurnBlock[] {
    return this.output.content;
  }

  /** Ids of the tool calls this turn handed to pi. */
  get toolCallIds(): string[] {
    return this.blocks.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
  }

  private start(): void {
    if (this.started || this.ended) return;

    this.stream.push({ type: "start", partial: this.output });
    this.started = true;
  }

  private push(event: Parameters<AssistantMessageEventStream["push"]>[0]): void {
    if (!this.ended) this.stream.push(event);
  }

  /** End the stream so pi can run the tool. Claude Code's MCP handler for the call then
   *  holds the query until pi delivers the result through the next provider call. */
  private endForToolUse(): void {
    if (this.ended) return;

    this.output.stopReason = "toolUse";
    this.stream.push({ type: "done", reason: "toolUse", message: this.output });
    this.stream.end();
    this.ended = true;
  }

  /** End the stream with the turn's outcome: done, or the error recorded by `fail`. */
  finish(): void {
    if (this.ended) return;

    debug(
      `turn: finish stopReason=${this.output.stopReason} error=${this.output.errorMessage ?? "none"}`,
    );
    this.start();

    if (this.output.stopReason === "error" || this.output.stopReason === "aborted") {
      this.stream.push({ type: "error", reason: this.output.stopReason, error: this.output });
    } else {
      this.stream.push({
        type: "done",
        reason: this.output.stopReason === "length" ? "length" : "stop",
        message: this.output,
      });
    }

    this.stream.end();
    this.ended = true;
  }

  fail(errorMessage: string, reason: "error" | "aborted" = "error"): void {
    this.output.stopReason = reason;
    this.output.errorMessage = errorMessage;
    this.finish();
  }

  private openBlockAt(index: number): number {
    return this.blocks.findIndex((block) => this.openBlocks.get(block)?.index === index);
  }

  /** Remove the blocks of the message that just stopped which never got their own
   *  content_block_stop because the stream was cut inside them. Such a tool call carries
   *  whatever JSON survived under an id Claude Code drops before resuming the turn, so
   *  nothing could ever answer a result keyed to it; a thinking block left that way has
   *  no signature. Per block: Claude Code keeps the blocks that did complete. */
  private dropUnfinished(why: string): void {
    const dropped: string[] = [];

    for (let index = this.blocks.length - 1; index >= this.streamBlockStart; index--) {
      const block = this.blocks[index];

      if (block === undefined || !this.openBlocks.has(block)) continue;

      dropped.unshift(describeBlock(block));
      this.openBlocks.delete(block);
      this.blocks.splice(index, 1);
    }

    if (dropped.length > 0) debug(`turn: ${why}; dropped unfinished ${dropped.join(",")}`);

    this.sawToolCall = this.blocks.some((block) => block.type === "toolCall");
  }

  /** Remove the blocks of a stream Claude Code abandoned mid-message: a thinking block
   *  without a signature, or a tool call it will never dispatch. The fallback restarts
   *  those indices, which pi's provider path tolerates. */
  private dropAbandoned(why: string): void {
    const dropped = this.blocks.splice(this.streamBlockStart);

    for (const block of dropped) this.openBlocks.delete(block);

    debug(
      `turn: ${why}; dropped ${dropped.length} blocks from ${this.streamMessageId} types=${dropped.map((block) => block.type).join(",")}`,
    );
    this.sawToolCall = this.blocks.some((block) => block.type === "toolCall");
    this.streamOpen = false;
  }

  /** One Anthropic stream event. On message_stop after a tool call, ends the turn. */
  streamEvent(message: SDKPartialAssistantMessage): void {
    if (this.ended) return;

    this.sawStreamEvent = true;

    const { event } = message;
    const { output } = this;

    switch (event.type) {
      case "message_start": {
        // Still open from an earlier message_start: Claude Code gave up on that stream and
        // is retrying it, and its blocks never completed.
        if (this.streamOpen) this.dropAbandoned(`restreamed as ${event.message.id}`);

        this.streamMessageId = event.message.id;
        this.streamOpen = true;
        this.streamBlockStart = this.blocks.length;
        recordUsage(output, event.message.usage, this.model);

        return;
      }

      case "content_block_start": {
        this.start();

        const block = event.content_block;
        let opened: TurnBlock;

        if (block.type === "text") {
          opened = { type: "text", text: "" };
        } else if (block.type === "thinking") {
          opened = { type: "thinking", thinking: "", thinkingSignature: "" };
        } else if (block.type === "tool_use") {
          const name = piToolName(block.name, this.served);

          if (name === undefined) {
            debug(`turn: skipping tool_use for unserved tool ${block.name} [${block.id}]`);

            return;
          }

          opened = {
            type: "toolCall",
            id: block.id,
            name,
            arguments: toJsonObject(block.input) ?? {},
          };
        } else {
          debug("turn: unhandled content_block_start type", block.type);

          return;
        }

        this.blocks.push(opened);
        this.openBlocks.set(opened, { index: event.index, partialJson: "" });

        const contentIndex = this.blocks.length - 1;

        const type =
          opened.type === "text"
            ? "text_start"
            : opened.type === "thinking"
              ? "thinking_start"
              : "toolcall_start";

        this.push({ type, contentIndex, partial: output });

        return;
      }

      case "content_block_delta": {
        const contentIndex = this.openBlockAt(event.index);
        const block = this.blocks[contentIndex];
        const open = block === undefined ? undefined : this.openBlocks.get(block);

        if (block === undefined || open === undefined) return;

        const { delta } = event;

        if (delta.type === "text_delta" && block.type === "text") {
          block.text += delta.text;
          this.push({ type: "text_delta", contentIndex, delta: delta.text, partial: output });
        } else if (delta.type === "thinking_delta" && block.type === "thinking") {
          block.thinking += delta.thinking;
          this.push({
            type: "thinking_delta",
            contentIndex,
            delta: delta.thinking,
            partial: output,
          });
        } else if (delta.type === "input_json_delta" && block.type === "toolCall") {
          open.partialJson += delta.partial_json;
          block.arguments = streamedArguments(open.partialJson, block.arguments);
          this.push({
            type: "toolcall_delta",
            contentIndex,
            delta: delta.partial_json,
            partial: output,
          });
        } else if (delta.type === "signature_delta" && block.type === "thinking") {
          block.thinkingSignature = (block.thinkingSignature ?? "") + delta.signature;
        } else {
          debug("turn: unhandled content_block_delta type", delta.type);
        }

        return;
      }

      case "content_block_stop": {
        const contentIndex = this.openBlockAt(event.index);
        const block = this.blocks[contentIndex];
        const open = block === undefined ? undefined : this.openBlocks.get(block);

        if (block === undefined || open === undefined) return;

        this.openBlocks.delete(block);

        if (block.type === "text") {
          this.push({ type: "text_end", contentIndex, content: block.text, partial: output });
        } else if (block.type === "thinking") {
          this.push({
            type: "thinking_end",
            contentIndex,
            content: block.thinking,
            partial: output,
          });
        } else {
          this.sawToolCall = true;
          block.arguments = mapToolArgs(
            block.name,
            streamedArguments(open.partialJson, block.arguments),
          );
          this.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
        }

        return;
      }

      case "message_delta": {
        output.stopReason = mapStopReason(event.delta.stop_reason);
        recordUsage(output, event.usage, this.model);

        return;
      }

      case "message_stop": {
        this.dropUnfinished(`message_stop for ${this.streamMessageId}`);
        this.streamOpen = false;

        if (this.sawToolCall) this.endForToolUse();

        return;
      }
    }
  }

  /** A complete assistant message. A no-op when stream events already delivered it; the
   *  content path when the next response arrives before any stream event, and when a
   *  stalled stream was retried without streaming (a new message id, no events). */
  assistantMessage(message: SDKAssistantMessage): void {
    if (this.ended) return;

    const assistant = message.message;
    const { output } = this;

    // Claude Code reports API failures and its own quota or context notices as a
    // `<synthetic>` assistant message: a report, not model output. Streaming it would
    // commit output before the failure it describes, so its text stays on the turn
    // (the error event carries it) without events.
    if (assistant.model === "<synthetic>") {
      // It can follow a stalled stream whose non-streaming retry also failed.
      if (this.sawStreamEvent && this.streamOpen) this.dropAbandoned("synthetic failure report");

      for (const block of assistant.content) {
        if (block.type === "text" && block.text !== "") {
          this.blocks.push({ type: "text", text: block.text });
        }
      }

      recordUsage(output, assistant.usage, this.model);

      return;
    }

    if (this.sawStreamEvent) {
      // The same id was already delivered; a new id is the non-streaming fallback.
      if (this.streamMessageId === undefined || assistant.id === this.streamMessageId) return;

      if (this.streamOpen) this.dropAbandoned(`non-streaming fallback ${assistant.id}`);
    }

    for (const block of assistant.content) {
      if (block.type === "text") {
        if (block.text !== "") this.completeText(block.text);
      } else if (block.type === "thinking") {
        this.start();
        this.blocks.push({
          type: "thinking",
          thinking: block.thinking,
          thinkingSignature: block.signature,
        });

        const contentIndex = this.blocks.length - 1;

        this.push({ type: "thinking_start", contentIndex, partial: output });

        if (block.thinking !== "") {
          this.push({
            type: "thinking_delta",
            contentIndex,
            delta: block.thinking,
            partial: output,
          });
        }

        this.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
      } else if (block.type === "tool_use") {
        const name = piToolName(block.name, this.served);

        if (name === undefined) {
          debug(`turn: skipping tool_use for unserved tool ${block.name} [${block.id}]`);
          continue;
        }

        this.start();
        this.sawToolCall = true;

        const toolCall: ToolCall = {
          type: "toolCall",
          id: block.id,
          name,
          arguments: mapToolArgs(name, toJsonObject(block.input) ?? {}),
        };

        this.blocks.push(toolCall);

        const contentIndex = this.blocks.length - 1;

        this.push({ type: "toolcall_start", contentIndex, partial: output });
        this.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
      } else {
        debug("turn: unhandled assistant block type", block.type);
      }
    }

    recordUsage(output, assistant.usage, this.model);

    if (this.sawToolCall) this.endForToolUse();
  }

  /** A successful result. Its text is the answer only when the turn produced none:
   *  Claude Code repeats the final text there after delivering it as a message. */
  result(message: SDKResultSuccess): void {
    if (this.ended) return;

    // A response that arrived whole (the non-streaming fallback) had no message_delta
    // to carry its stop reason; a token limit shows here.
    if (mapStopReason(message.stop_reason) === "length") this.output.stopReason = "length";

    if (message.result === "") return;

    if (this.blocks.some((block) => block.type === "text" && block.text !== "")) return;

    this.completeText(message.result);
  }

  private completeText(text: string): void {
    this.start();
    this.blocks.push({ type: "text", text });

    const contentIndex = this.blocks.length - 1;

    this.push({ type: "text_start", contentIndex, partial: this.output });
    this.push({ type: "text_delta", contentIndex, delta: text, partial: this.output });
    this.push({ type: "text_end", contentIndex, content: text, partial: this.output });
  }
}
