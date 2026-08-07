/* oxlint-disable eslint/no-use-before-define -- helpers follow the request transformation flow */
export const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";
export const RESPONSES_LITE_WS_METADATA_KEY =
  "ws_request_header_x_openai_internal_codex_responses_lite";

interface ResponsesLiteBody {
  client_metadata?: Record<string, string>;
  input: unknown[];
  instructions?: string;
  model: string;
  reasoning?: unknown;
  tools?: unknown[];
  [key: string]: unknown;
}

export const rewriteResponsesLiteRequest = (payload: unknown): unknown => {
  if (!isCompatibleBody(payload)) {
    return undefined;
  }
  if (isResponsesLiteRequest(payload)) {
    return withWebSocketMetadata(payload);
  }
  const instructions = payload.instructions?.trim();
  const { instructions: _instructions, tools: _tools, ...rest } = payload;
  return withWebSocketMetadata({
    ...rest,
    input: [
      {
        role: "developer",
        tools: [...(payload.tools ?? [])],
        type: "additional_tools",
      },
      ...(instructions !== undefined && instructions.length > 0
        ? [
            {
              content: [{ text: instructions, type: "input_text" }],
              role: "developer",
              type: "message",
            },
          ]
        : []),
      ...prepareLiteInput(payload.input),
    ],
    parallel_tool_calls: false,
    reasoning: {
      ...(isRecord(payload.reasoning) ? payload.reasoning : {}),
      context: "all_turns",
    },
  });
};

const withWebSocketMetadata = <T extends ResponsesLiteBody>(body: T) => ({
  ...body,
  client_metadata: {
    ...body.client_metadata,
    [RESPONSES_LITE_WS_METADATA_KEY]: "true",
  },
});

const isCompatibleBody = (value: unknown): value is ResponsesLiteBody =>
  isRecord(value) &&
  typeof value.model === "string" &&
  Array.isArray(value.input);

const isResponsesLiteRequest = (body: ResponsesLiteBody) =>
  isRecord(body.input[0]) && body.input[0].type === "additional_tools";

const prepareLiteInput = (input: readonly unknown[]) =>
  input.map((item) => {
    if (!isRecord(item)) {
      return item;
    }
    if (
      item.type === "message" ||
      item.role === "user" ||
      item.role === "developer" ||
      item.role === "system"
    ) {
      return { ...item, content: prepareLiteContent(item.content) };
    }
    if (
      (item.type === "function_call_output" ||
        item.type === "custom_tool_call_output") &&
      Array.isArray(item.output)
    ) {
      return { ...item, output: prepareLiteContent(item.output) };
    }
    return item;
  });

const prepareLiteContent = (content: unknown): unknown => {
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((item: unknown) => {
    if (!isRecord(item) || item.type !== "input_image") {
      return item;
    }
    if (
      typeof item.image_url === "string" &&
      /^https?:\/\//iu.test(item.image_url)
    ) {
      return {
        text: "image content omitted because remote image URLs are not supported",
        type: "input_text",
      };
    }
    const { detail: _detail, ...image } = item;
    return image;
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
