import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import {
  buildSessionProjection,
  convertToLlm,
  estimateTokens,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ObservedRequest } from "./observation.js";

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
  readonly kind: "state";
  readonly modelLabel: string;
  readonly usage: ContextUsage | undefined;
  /** False before the first request records the prompt and tool declarations. */
  readonly recorded: boolean;
  readonly system: ContextPart;
  readonly tools: readonly ContextPart[];
  readonly messages: readonly ContextMessagePart[];
}

export interface RequestSnapshot {
  readonly kind: "request";
  readonly request: ObservedRequest | undefined;
}

export type InspectorSnapshot = ContextSnapshot | RequestSnapshot;

export interface ContextMessagePart extends ContextPart {
  readonly sourceEntryId: string;
}

interface SnapshotInput {
  /** `ctx.getSystemPrompt()`, shown only until the first request records the prompt. */
  pendingPrompt: string;
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

/** The prompt and tool declarations the latest request recorded in the transcript. */
const declarations = (
  declared: SystemMessage | undefined,
  pendingPrompt: string,
): Pick<ContextSnapshot, "recorded" | "system" | "tools"> => {
  const { toolsAdded = [], ...prompt }: SystemMessage = declared ?? {
    role: "system",
    content: pendingPrompt,
    timestamp: 0,
  };

  return {
    recorded: declared !== undefined,
    system: {
      label: declared ? "System prompt" : "System prompt · not yet sent",
      body: getSystemMessageText(prompt),
      format: "markdown",
      tone: "text",
      estimatedTokens: estimateTokens(prompt),
    },
    tools: toolsAdded.map((tool) => ({
      label: tool.name,
      body: JSON.stringify(tool, null, 2),
      format: "json",
      tone: "code",
      estimatedTokens: estimateTokens({
        role: "system",
        content: "",
        toolsAdded: [tool],
        timestamp: 0,
      }),
    })),
  };
};

export const buildSnapshot = (input: SnapshotInput): ContextSnapshot => {
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

    // Excludes metadata, prompt/tool declarations, !! executions, and older compaction summaries.
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

  return {
    kind: "state",
    modelLabel: input.modelLabel,
    usage: input.usage === undefined ? undefined : { ...input.usage },
    ...declarations(getCurrentSystemMessage(projection.messages), input.pendingPrompt),
    messages,
  };
};
