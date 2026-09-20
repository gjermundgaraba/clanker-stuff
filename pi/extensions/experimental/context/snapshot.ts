import type { Message } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ContextUsage, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";

export type BodyFormat = "markdown" | "json" | "text";

export type NodeTone = "text" | "accent" | "muted" | "error" | "code";

export interface ContextPart {
  readonly label: string;
  readonly body: string;
  readonly format: BodyFormat;
  readonly tone: NodeTone;
  readonly estimatedTokens: number;
}

export interface ContextSnapshot {
  readonly modelLabel: string;
  readonly usage: ContextUsage | undefined;
  readonly system: ContextPart;
  readonly tools: readonly ContextPart[];
  readonly messages: readonly ContextPart[];
}

interface SnapshotInput {
  /** The effective prompt for the next request, from `ctx.getSystemPrompt()`. */
  prompt: string;
  tools: readonly ToolInfo[];
  activeTools: readonly string[];
  branch: SessionEntry[];
  usage: ContextUsage | undefined;
  modelLabel: string;
}

const messageBody = (message: Message): string => {
  if (!Array.isArray(message.content)) return message.content;

  return message.content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "thinking":
          return block.redacted ? "[Redacted thinking]" : `[Thinking]\n${block.thinking}`;
        case "toolCall":
          return `[Tool call: ${block.namespace ? `${block.namespace}.` : ""}${block.name}]\n${JSON.stringify(block.arguments, null, 2)}`;
        case "image":
          return `[Image: ${block.mimeType}, ${block.data.length} base64 characters]`;
      }
    })
    .join("\n\n");
};

const messageTone = (message: Message): NodeTone => {
  if (message.role === "toolResult") return message.isError ? "error" : "muted";

  return message.role === "user" ? "accent" : "text";
};

export const buildSnapshot = (input: SnapshotInput): ContextSnapshot => {
  const active = new Set(input.activeTools);

  // System messages are persisted prompt state, not conversation; the prompt
  // leaf already shows the effective prompt.
  const messages = convertToLlm(buildSessionContext(input.branch).messages).filter(
    (message) => message.role !== "system",
  );

  const { prompt } = input;

  return {
    modelLabel: input.modelLabel,
    usage: input.usage === undefined ? undefined : { ...input.usage },
    system: {
      label: "System prompt",
      body: prompt,
      format: "markdown",
      tone: "text",
      estimatedTokens: Math.ceil(prompt.length / 4),
    },
    tools: input.tools
      .filter((tool) => active.has(tool.name))
      .map((tool) => {
        const definition = {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        };

        return {
          label: tool.name,
          body: JSON.stringify(definition, null, 2),
          format: "json",
          tone: "code",
          estimatedTokens: Math.ceil(JSON.stringify(definition).length / 4),
        };
      }),
    messages: messages.map((message, index) => ({
      label: `${index + 1}. ${message.role === "toolResult" ? `tool result: ${message.toolName}${message.isError ? " (error)" : ""}` : message.role}`,
      body: messageBody(message),
      format: message.role === "toolResult" ? "text" : "markdown",
      tone: messageTone(message),
      estimatedTokens: estimateTokens(message),
    })),
  };
};
