import type { Message } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  convertToLlm,
  estimateTokens,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
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

/** Finished inspector previews; token estimates describe model input, not preview text. */
export interface ContextSnapshot {
  readonly modelLabel: string;
  readonly usage: ContextUsage | undefined;
  readonly system: ContextPart;
  readonly tools: readonly ContextPart[];
  readonly messages: readonly ContextMessagePart[];
}

export interface ContextMessagePart extends ContextPart {
  readonly sourceEntryId: string;
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
  const projection = buildSessionProjection(input.branch);

  const edits = new Map(
    projection.entries.flatMap(({ sourceEntry }) =>
      sourceEntry.type === "context_edit" ? [[sourceEntry.targetId, sourceEntry] as const] : [],
    ),
  );

  // Only the canonical retained range is inspected; this is not a raw-history browser.
  const messages: ContextMessagePart[] = [];

  for (const { sourceEntry, messages: projected } of projection.entries) {
    const effective = convertToLlm(projected).filter((message) => message.role !== "system");
    const edit = edits.get(sourceEntry.id);

    const original = edit
      ? convertToLlm(sessionEntryToContextMessages(sourceEntry)).filter(
          (message) => message.role !== "system",
        )
      : [];

    const message = effective[0] ?? original[0];

    // Excludes metadata, system state, !! executions, and older compaction summaries.
    if (!message) continue;

    const state = edit?.replacement === null ? "omitted" : edit ? "replaced" : "unchanged";

    const role =
      message.role === "toolResult"
        ? `tool result: ${message.toolName}${message.isError ? " (error)" : ""}`
        : message.role;

    messages.push({
      label: `${messages.length + 1}. ${role}${state === "unchanged" ? "" : ` · ${state}`}`,
      body: [
        `Source entry: ${sourceEntry.id}`,
        `State: ${state}`,
        ...(edit ? [`Context edit: ${edit.id}`] : []),
        "",
        "Effective content:",
        state === "omitted"
          ? "(omitted from model context)"
          : effective.map(messageBody).join("\n\n"),
        ...(edit ? ["", "Original content:", original.map(messageBody).join("\n\n")] : []),
      ].join("\n"),
      format: "text",
      tone: state === "omitted" ? "muted" : messageTone(message),
      estimatedTokens: effective.reduce((total, item) => total + estimateTokens(item), 0),
      sourceEntryId: sourceEntry.id,
    });
  }

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
    messages,
  };
};
