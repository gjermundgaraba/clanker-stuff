import type {
  AssistantMessage,
  ImageContent,
  JsonObject,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

export const text = (value: string): TextContent => ({
  type: "text",
  text: value,
});

export const image = (data: string, mimeType: string): ImageContent => ({
  type: "image",
  data,
  mimeType,
});

export const thinking = (
  value: string,
  signature?: string
): ThinkingContent => ({
  type: "thinking",
  thinking: value,
  ...(signature === undefined ? {} : { thinkingSignature: signature }),
});

export const toolCall = (
  id: string,
  name: string,
  args: JsonObject = {}
): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

/** A block an extension added outside pi's content types, as conversion meets it at runtime. */
export const offTypeBlock = (type: string): TextContent =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Deliberately malformed fixture: pi's types cannot express the extension blocks conversion must tolerate.
  ({ type }) as TextContent;

export const user = (content: UserMessage["content"]): UserMessage => ({
  role: "user",
  content,
  timestamp: 0,
});

export const assistant = (
  content: AssistantMessage["content"],
  provider = "claude-bridge"
): AssistantMessage => ({
  role: "assistant",
  content,
  api: "claude-bridge",
  provider,
  model: "claude-haiku-5-5",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});

export const toolResult = (
  toolCallId: string,
  content: string | Array<TextContent | ImageContent>,
  isError = false
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "tool",
  content: typeof content === "string" ? [text(content)] : content,
  isError,
  timestamp: 0,
});
