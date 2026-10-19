/**
 * Mirrors a child session the way Pi's own chat draws one, from stored branch entries and then from
 * live events. The event handling follows Pi's interactive mode.
 */
import { displayText } from "@clanker-stuff/pi-tool-rendering/text";
import {
  AssistantMessageComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  getMarkdownTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { readEnvelope, SUBAGENT_MESSAGE_TYPE } from "../protocol.js";
import type { AgentMessage } from "../runtime.js";
import { mailRenderer } from "../renderers.js";
import { agentName, contentText } from "./format.js";

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;

/** Tool results arrive untyped on session events; draw only what has the shape Pi's chat draws. */
const ToolResultSchema = Type.Object({
  content: Type.Array(
    Type.Object({
      data: Type.Optional(Type.String()),
      mimeType: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      type: Type.String(),
    }),
  ),
  details: Type.Optional(Type.Unknown()),
});

interface Expandable {
  setExpanded: (expanded: boolean) => void;
}

/** Whatever Pi's tool row accepts: an extension's renderers or a whole tool definition. */
export type ToolDisplay = ConstructorParameters<typeof ToolExecutionComponent>[4];

export interface TranscriptOptions {
  cwd: string;
  /** How to draw calls to a tool; undefined falls back to Pi's generic call display. */
  renderers: (name: string) => ToolDisplay;
  theme: Theme;
  tui: TUI;
}

export class Transcript extends Container {
  readonly #expandable: Expandable[] = [];
  readonly #markdownTheme = getMarkdownTheme();
  readonly #options: TranscriptOptions;
  readonly #pending = new Map<string, ToolExecutionComponent>();
  #expanded = false;
  #streaming: AssistantMessageComponent | undefined;

  constructor(options: TranscriptOptions) {
    super();
    this.#options = options;
  }

  get expanded(): boolean {
    return this.#expanded;
  }

  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;

    for (const component of this.#expandable) component.setExpanded(expanded);
  }

  /** Draws stored history, then what a live agent was doing when the viewer opened. */
  load(
    messages: readonly AgentMessage[],
    streaming: AgentMessage | undefined,
    executing: ReadonlySet<string> = new Set(),
  ): void {
    for (const message of messages) {
      if (message.role === "assistant") this.#assistant(message);
      else this.#message(message);
    }

    if (streaming?.role === "assistant") {
      this.#startStreaming();
      this.#updateStreaming(streaming);
    }

    for (const id of executing) this.#pending.get(id)?.markExecutionStarted();
  }

  /** Settles rows still running, since some tool renderers keep timers until a final result. */
  dispose(): void {
    for (const component of this.#pending.values())
      component.updateResult({ content: [], isError: false });
    this.#pending.clear();
  }

  handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
        if (event.message.role === "assistant") this.#startStreaming();
        else this.#message(event.message);
        break;
      case "message_update":
        if (event.message.role === "assistant") this.#updateStreaming(event.message);
        break;
      case "message_end":
        if (event.message.role === "assistant") this.#endStreaming(event.message);
        break;
      case "tool_execution_start":
        // Nested calls from Code Mode scripts are shown inside their parent's row.
        if (event.parentToolCallId === undefined)
          this.#tool(event.toolCallId, event.toolName, event.args).markExecutionStarted();
        break;
      case "tool_execution_update": {
        const partial: unknown = event.partialResult;

        if (Value.Check(ToolResultSchema, partial))
          this.#pending.get(event.toolCallId)?.updateResult({ ...partial, isError: false }, true);
        break;
      }

      case "tool_execution_end": {
        const result: unknown = event.result;
        const component = this.#pending.get(event.toolCallId);
        this.#pending.delete(event.toolCallId);

        component?.updateResult({
          ...(Value.Check(ToolResultSchema, result) ? result : { content: [] }),
          isError: event.isError,
          ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
        });
        break;
      }

      case "agent_end":
        if (this.#streaming !== undefined) this.removeChild(this.#streaming);
        this.#streaming = undefined;
        this.#pending.clear();
        break;
      case "compaction_end":
        if (event.result !== undefined)
          this.#message({
            role: "compactionSummary",
            summary: event.result.summary,
            timestamp: Date.now(),
            tokensBefore: event.result.tokensBefore,
          });
        break;
      default:
        break;
    }
  }

  #add<T extends Component>(component: T, expandable?: Expandable): T {
    if (expandable !== undefined) {
      expandable.setExpanded(this.#expanded);
      this.#expandable.push(expandable);
    }

    this.addChild(component);

    return component;
  }

  #tool(id: string, name: string, args: unknown): ToolExecutionComponent {
    const existing = this.#pending.get(id);

    if (existing !== undefined) return existing;
    const { cwd, renderers, tui } = this.#options;

    // Image protocols cannot draw inside an overlay; Pi then describes the image in text.
    const component = new ToolExecutionComponent(
      name,
      id,
      args,
      { showImages: false },
      renderers(name),
      tui,
      cwd,
    );

    this.#add(component, component);
    this.#pending.set(id, component);

    return component;
  }

  #assistant(message: AssistantMessage): void {
    this.#add(new AssistantMessageComponent(message, false, this.#markdownTheme));
    const failed = message.stopReason === "aborted" || message.stopReason === "error";

    for (const content of message.content) {
      if (content.type !== "toolCall") continue;
      const component = this.#tool(content.id, content.name, content.arguments);

      if (failed) {
        component.updateResult({
          content: [{ text: message.errorMessage ?? "Operation aborted", type: "text" }],
          isError: true,
        });
        this.#pending.delete(content.id);
      }
    }
  }

  #startStreaming(): void {
    this.#streaming = this.#add(
      new AssistantMessageComponent(undefined, false, this.#markdownTheme),
    );
  }

  #updateStreaming(message: AssistantMessage): void {
    this.#streaming?.updateContent(message, true);

    for (const content of message.content) {
      if (content.type !== "toolCall") continue;

      const component = this.#pending.get(content.id);

      if (component !== undefined) component.updateArgs(content.arguments);
      else this.#tool(content.id, content.name, content.arguments);
    }
  }

  #endStreaming(message: AssistantMessage): void {
    if (this.#streaming === undefined) return;
    this.#streaming.updateContent(message, false);
    this.#streaming = undefined;

    if (message.stopReason === "aborted" || message.stopReason === "error") {
      for (const component of this.#pending.values())
        component.updateResult({
          content: [{ text: message.errorMessage ?? "Operation aborted", type: "text" }],
          isError: true,
        });
      this.#pending.clear();
    } else {
      for (const component of this.#pending.values()) component.setArgsComplete();
    }
  }

  #message(message: Exclude<AgentMessage, AssistantMessage>): void {
    switch (message.role) {
      // A result arrives as a message once its whole parallel batch has finished; a viewer opened
      // mid-batch has missed the earlier calls' execution events.
      case "toolResult":
        this.#pending.get(message.toolCallId)?.updateResult(message);
        this.#pending.delete(message.toolCallId);
        break;
      case "user": {
        const text = contentText(message.content);
        const envelope = readEnvelope(text);

        if (this.children.length > 0) this.#add(new Spacer(1));

        if (envelope === undefined) {
          this.#add(new UserMessageComponent(text, this.#markdownTheme));
          break;
        }

        // A task arrives as an envelope; show who sent it, then the task as the user's prompt.
        const { theme } = this.#options;
        this.#add(
          new Text(
            `${theme.fg("muted", envelope.kind === "NEW_TASK" ? "▸ task from" : "▸ from")} ${theme.bold(displayText(agentName(envelope.from)))}`,
            1,
            0,
          ),
        );
        this.#add(new UserMessageComponent(envelope.content, this.#markdownTheme));
        break;
      }

      case "custom": {
        // Steered tasks are stored hidden, but mail is what a viewer most wants to see.
        const isMail = message.customType === SUBAGENT_MESSAGE_TYPE;

        if (isMail || message.display) {
          const component = new CustomMessageComponent(
            message,
            isMail ? mailRenderer : undefined,
            this.#markdownTheme,
          );

          this.#add(component, component);
        }

        break;
      }

      case "compactionSummary": {
        this.#add(new Spacer(1));
        const component = new CompactionSummaryMessageComponent(message, this.#markdownTheme);
        this.#add(component, component);
        break;
      }

      case "branchSummary": {
        this.#add(new Spacer(1));
        const component = new BranchSummaryMessageComponent(message, this.#markdownTheme);
        this.#add(component, component);
        break;
      }

      default:
        break;
    }
  }
}
