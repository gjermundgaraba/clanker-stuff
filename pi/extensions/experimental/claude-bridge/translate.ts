import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import { ToolCallArgumentsStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  ToolCall,
} from "@earendil-works/pi-ai";

import { toJsonObject } from "./json.js";
import { debug } from "./log.js";
import { recordUsage } from "./query/usage.js";
import { piToolName } from "./tools.js";

export type TurnBlock = AssistantMessage["content"][number];

type OpenBlock =
  | { index: number; block: Exclude<TurnBlock, ToolCall> }
  | { index: number; block: ToolCall; arguments: ToolCallArgumentsStream };

/** Claude Code's stop reason as pi's. The result message carries it untyped. */
export const mapStopReason = (
  reason: string | null
): "stop" | "length" | "toolUse" => {
  if (reason === "tool_use") {
    return "toolUse";
  }

  return reason === "max_tokens" || reason === "model_context_window_exceeded"
    ? "length"
    : "stop";
};

const START_EVENT = {
  text: "text_start",
  thinking: "thinking_start",
  toolCall: "toolcall_start",
} as const;

const describeBlock = (block: TurnBlock): string =>
  block.type === "toolCall" ? `toolCall[${block.id}]` : block.type;

export class Turn {
  readonly output: AssistantMessage;

  /** The stream was ended: on a tool call, completion or failure. Nothing more reaches it. */
  ended = false;

  private started = false;
  private sawStreamEvent = false;
  /** API message id from the last message_start, and whether its message_stop arrived.
   *  An `assistant` message under another id while the stream is open is Claude Code's
   *  non-streaming fallback for a stalled stream. */
  private streamMessageId: string | undefined;
  private streamOpen = false;
  /** Block count at that message_start: where an abandoned attempt's blocks begin. */
  private streamBlockStart = 0;
  private readonly openBlocks = new Map<TurnBlock, OpenBlock>();

  private readonly model: Model<Api>;
  private readonly stream: AssistantMessageEventStream;
  /** The pi names of the tools the query serves. */
  private readonly served: ReadonlySet<string>;
  /** A one-off asks for text: a reply without any is a failure, not an answer. */
  private readonly options: {
    requireText?: boolean;
    onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
  };

  constructor(
    model: Model<Api>,
    stream: AssistantMessageEventStream,
    served: ReadonlySet<string>,
    options: {
      requireText?: boolean;
      onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
    } = {}
  ) {
    this.model = model;
    this.stream = stream;
    this.served = served;
    this.options = options;
    this.output = {
      role: "assistant",
      content: [],
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
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  /** Observe the SDK's raw API event before this turn translates it. */
  async observeStreamEvent(message: SDKPartialAssistantMessage): Promise<void> {
    await this.options.onProviderStreamEvent?.(message.event, this.model);
  }

  private get blocks(): TurnBlock[] {
    return this.output.content;
  }

  /** The turn has a completed tool call; an open one may still be cut off and dropped. */
  private get hasToolCall(): boolean {
    return this.blocks.some(
      (block) => block.type === "toolCall" && !this.openBlocks.has(block)
    );
  }

  /** Ids of the tool calls this turn handed to pi. */
  get toolCallIds(): string[] {
    return this.blocks.flatMap((block) =>
      block.type === "toolCall" ? [block.id] : []
    );
  }

  private start(): void {
    if (this.started || this.ended) {
      return;
    }

    this.stream.push({ type: "start", partial: this.output });
    this.started = true;
  }

  private push(
    event: Parameters<AssistantMessageEventStream["push"]>[0]
  ): void {
    if (!this.ended) {
      this.stream.push(event);
    }
  }

  /** What a turn that did not fail ended on. Tool calls end it so pi can run them, and
   *  Claude Code's MCP handler then holds the query until pi delivers the results through
   *  the next provider call; but not when Claude was cut off at its output limit, since
   *  pi runs no tool call from a truncated response. */
  private outcome(): "stop" | "length" | "toolUse" | "error" {
    if (this.output.stopReason === "length") {
      return "length";
    }

    if (this.hasToolCall) {
      return "toolUse";
    }

    const hasText = this.blocks.some(
      (block) => block.type === "text" && block.text.trim() !== ""
    );

    return this.options.requireText === true && !hasText ? "error" : "stop";
  }

  /** End the stream with the turn's outcome: the failure recorded by `fail`, or done. */
  finish(): void {
    if (this.ended) {
      return;
    }

    const { output } = this;

    this.start();

    if (output.stopReason === "error" || output.stopReason === "aborted") {
      this.stream.push({
        type: "error",
        reason: output.stopReason,
        error: output,
      });
    } else {
      const outcome = this.outcome();

      output.stopReason = outcome;

      if (outcome === "error") {
        output.errorMessage = "Claude Code returned no text";
        this.stream.push({ type: "error", reason: "error", error: output });
      } else {
        this.stream.push({ type: "done", reason: outcome, message: output });
      }
    }

    debug(
      `turn: finish stopReason=${output.stopReason} error=${output.errorMessage ?? "none"}`
    );
    this.stream.end();
    this.ended = true;
  }

  fail(errorMessage: string, reason: "error" | "aborted" = "error"): void {
    this.output.stopReason = reason;
    this.output.errorMessage = errorMessage;
    this.finish();
  }

  private openBlockAt(index: number): number {
    return this.blocks.findIndex(
      (block) => this.openBlocks.get(block)?.index === index
    );
  }

  /** Remove the blocks of the message that just stopped which never got their own
   *  content_block_stop because the stream was cut inside them. Such a tool call carries
   *  whatever JSON survived under an id Claude Code drops before resuming the turn, so
   *  nothing could ever answer a result keyed to it; a thinking block left that way has
   *  no signature. Per block: Claude Code keeps the blocks that did complete. */
  private dropUnfinished(why: string): void {
    const dropped: string[] = [];

    for (
      let index = this.blocks.length - 1;
      index >= this.streamBlockStart;
      index -= 1
    ) {
      const block = this.blocks[index];

      if (block === undefined || !this.openBlocks.has(block)) {
        continue;
      }

      dropped.unshift(describeBlock(block));
      this.openBlocks.delete(block);
      this.blocks.splice(index, 1);
    }

    if (dropped.length > 0) {
      debug(`turn: ${why}; dropped unfinished ${dropped.join(",")}`);
    }
  }

  /** Remove the blocks of a stream Claude Code abandoned mid-message: a thinking block
   *  without a signature, or a tool call it will never dispatch. The fallback restarts
   *  those indices, which pi's provider path tolerates. */
  private dropAbandoned(why: string): void {
    const dropped = this.blocks.splice(this.streamBlockStart);

    for (const block of dropped) {
      this.openBlocks.delete(block);
    }

    debug(
      `turn: ${why}; dropped ${dropped.length} blocks from ${this.streamMessageId} types=${dropped.map((block) => block.type).join(",")}`
    );
    this.streamOpen = false;
  }

  /** One Anthropic stream event. On message_stop after a tool call, ends the turn. */
  streamEvent(message: SDKPartialAssistantMessage): void {
    if (this.ended) {
      return;
    }

    this.sawStreamEvent = true;

    const { event } = message;
    const { output } = this;

    switch (event.type) {
      case "message_start": {
        if (this.streamOpen) {
          this.dropAbandoned(`restreamed as ${event.message.id}`);
        }

        this.streamMessageId = event.message.id;
        this.streamOpen = true;
        this.streamBlockStart = this.blocks.length;
        recordUsage(output, event.message.usage, this.model);

        return;
      }

      case "content_block_start": {
        this.start();

        const block = event.content_block;
        let opened: TurnBlock | undefined;

        if (block.type === "text") {
          opened = { type: "text", text: "" };
        } else if (block.type === "thinking") {
          opened = { type: "thinking", thinking: "", thinkingSignature: "" };
        } else if (block.type === "tool_use") {
          opened = this.toolCall(block);
        } else {
          debug("turn: unhandled content_block_start type", block.type);
        }

        if (opened === undefined) {
          return;
        }

        this.openBlocks.set(
          opened,
          opened.type === "toolCall"
            ? {
                index: event.index,
                block: opened,
                arguments: new ToolCallArgumentsStream(),
              }
            : { index: event.index, block: opened }
        );
        this.append(opened);

        return;
      }

      case "content_block_delta": {
        const contentIndex = this.openBlockAt(event.index);
        const block = this.blocks[contentIndex];

        const open =
          block === undefined ? undefined : this.openBlocks.get(block);

        if (block === undefined || open === undefined) {
          return;
        }

        const { delta } = event;

        if (delta.type === "text_delta" && block.type === "text") {
          block.text += delta.text;
          this.push({
            type: "text_delta",
            contentIndex,
            delta: delta.text,
            partial: output,
          });
        } else if (
          delta.type === "thinking_delta" &&
          block.type === "thinking"
        ) {
          block.thinking += delta.thinking;
          this.push({
            type: "thinking_delta",
            contentIndex,
            delta: delta.thinking,
            partial: output,
          });
        } else if (delta.type === "input_json_delta" && "arguments" in open) {
          open.block.arguments = open.arguments.append(delta.partial_json);

          this.push({
            type: "toolcall_delta",
            contentIndex,
            delta: delta.partial_json,
            partial: output,
          });
        } else if (
          delta.type === "signature_delta" &&
          block.type === "thinking"
        ) {
          block.thinkingSignature =
            (block.thinkingSignature ?? "") + delta.signature;
        } else {
          debug("turn: unhandled content_block_delta type", delta.type);
        }

        return;
      }

      case "content_block_stop": {
        const contentIndex = this.openBlockAt(event.index);
        const block = this.blocks[contentIndex];

        const open =
          block === undefined ? undefined : this.openBlocks.get(block);

        if (block === undefined || open === undefined) {
          return;
        }

        this.openBlocks.delete(block);

        if ("arguments" in open) {
          Object.assign(open.block, open.arguments.finish());
        }

        this.end(block, contentIndex);

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

        if (this.hasToolCall) {
          this.finish();
        }
      }
    }
  }

  /** A complete assistant message. A no-op when stream events already delivered it; the
   *  content path when the next response arrives before any stream event, and when a
   *  stalled stream was retried without streaming (a new message id, no events). */
  assistantMessage(message: SDKAssistantMessage): void {
    if (this.ended) {
      return;
    }

    const assistant = message.message;
    const { output } = this;

    if (assistant.model === "<synthetic>") {
      if (this.sawStreamEvent && this.streamOpen) {
        this.dropAbandoned("synthetic failure report");
      }

      for (const block of assistant.content) {
        if (block.type === "text" && block.text !== "") {
          this.blocks.push({ type: "text", text: block.text });
        }
      }

      recordUsage(output, assistant.usage, this.model);

      return;
    }

    if (this.sawStreamEvent) {
      if (
        this.streamMessageId === undefined ||
        assistant.id === this.streamMessageId
      ) {
        return;
      }

      if (this.streamOpen) {
        this.dropAbandoned(`non-streaming fallback ${assistant.id}`);
      }
    }

    for (const block of assistant.content) {
      if (block.type === "text") {
        if (block.text !== "") {
          this.appendWhole({ type: "text", text: block.text });
        }
      } else if (block.type === "thinking") {
        this.appendWhole({
          type: "thinking",
          thinking: block.thinking,
          thinkingSignature: block.signature,
        });
      } else if (block.type === "tool_use") {
        const toolCall = this.toolCall(block);

        if (toolCall !== undefined) {
          this.appendWhole(toolCall);
        }
      } else {
        debug("turn: unhandled assistant block type", block.type);
      }
    }

    recordUsage(output, assistant.usage, this.model);

    if (mapStopReason(assistant.stop_reason) === "length") {
      output.stopReason = "length";
    }

    if (this.hasToolCall) {
      this.finish();
    }
  }

  /** A successful result. Its text is the answer only when the turn produced none:
   *  Claude Code repeats the final text there after delivering it as a message. */
  result(message: SDKResultSuccess): void {
    if (this.ended) {
      return;
    }

    if (mapStopReason(message.stop_reason) === "length") {
      this.output.stopReason = "length";
    }

    if (message.result === "") {
      return;
    }

    if (
      this.blocks.some((block) => block.type === "text" && block.text !== "")
    ) {
      return;
    }

    this.appendWhole({ type: "text", text: message.result });
  }

  /** A tool_use block as pi's tool call, or undefined when the query does not serve the
   *  tool: Claude Code answers that call itself. */
  private toolCall(block: {
    id: string;
    name: string;
    input: unknown;
  }): ToolCall | undefined {
    const name = piToolName(block.name, this.served);

    if (name === undefined) {
      debug(
        `turn: skipping tool_use for unserved tool ${block.name} [${block.id}]`
      );

      return undefined;
    }

    return {
      type: "toolCall",
      id: block.id,
      name,
      arguments: toJsonObject(block.input) ?? {},
    };
  }

  /** Add a block and announce its start. Returns its content index. */
  private append(block: TurnBlock): number {
    this.start();
    this.blocks.push(block);

    const contentIndex = this.blocks.length - 1;

    this.push({
      type: START_EVENT[block.type],
      contentIndex,
      partial: this.output,
    });

    return contentIndex;
  }

  /** Announce a block's end with its final content. */
  private end(block: TurnBlock, contentIndex: number): void {
    const partial = this.output;

    if (block.type === "text") {
      this.push({
        type: "text_end",
        contentIndex,
        content: block.text,
        partial,
      });
    } else if (block.type === "thinking") {
      this.push({
        type: "thinking_end",
        contentIndex,
        content: block.thinking,
        partial,
      });
    } else {
      this.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: block,
        partial,
      });
    }
  }

  /** A block that arrived complete: its start, its content as one delta, its end. */
  private appendWhole(block: TurnBlock): void {
    const contentIndex = this.append(block);
    const partial = this.output;

    if (block.type === "text" && block.text !== "") {
      this.push({
        type: "text_delta",
        contentIndex,
        delta: block.text,
        partial,
      });
    } else if (block.type === "thinking" && block.thinking !== "") {
      this.push({
        type: "thinking_delta",
        contentIndex,
        delta: block.thinking,
        partial,
      });
    }

    this.end(block, contentIndex);
  }
}
