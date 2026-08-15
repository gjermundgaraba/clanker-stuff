/* oxlint-disable eslint/no-use-before-define, eslint/no-nested-ternary -- mirrors the upstream wire variants */
// Protocol adapter derived from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import type {
  NestedTool,
  RuntimeContentItem,
  RuntimeResponse,
} from "./types.js";

export const MAX_CODE_MODE_OUTPUT_TOKENS = 100_000;
export const DEFAULT_CODE_MODE_OUTPUT_TOKENS = 10_000;
export const DEFAULT_CODE_MODE_EXEC_YIELD_MS = 30_000;

export const toWireToolDefinition = (tool: NestedTool) => ({
  description: [`Usage: ${tool.usage}`, tool.definition.description].join("\n"),
  input_schema: tool.definition.parameters,
  kind: "function",
  name: tool.definition.name,
  output_schema: null,
  tool_name: { name: tool.definition.name, namespace: null },
});

export const parseExecSource = (
  source: string
): {
  code: string;
  maxOutputTokens: number | null;
  yieldTimeMs: number | null;
} => {
  if (!source.trim()) {
    throw new Error("exec requires non-empty JavaScript source");
  }
  const [first, ...rest] = source.split("\n");
  const trimmed = first?.trimStart() ?? "";
  if (!trimmed.startsWith("// @exec:")) {
    return { code: source, maxOutputTokens: null, yieldTimeMs: null };
  }
  if (rest.join("\n").trim() === "") {
    throw new Error("exec pragma must be followed by JavaScript source");
  }
  const options: unknown = JSON.parse(trimmed.slice("// @exec:".length).trim());
  if (!isRecord(options)) {
    throw new Error("exec pragma must contain a JSON object");
  }
  for (const key of Object.keys(options)) {
    if (key !== "yield_time_ms" && key !== "max_output_tokens") {
      throw new Error(`Unsupported exec pragma field: ${key}`);
    }
  }
  return {
    code: rest.join("\n"),
    maxOutputTokens: parseInteger(
      options.max_output_tokens,
      "max_output_tokens",
      1,
      MAX_CODE_MODE_OUTPUT_TOKENS
    ),
    yieldTimeMs: parseInteger(options.yield_time_ms, "yield_time_ms"),
  };
};

export const parseRuntimeResponse = (value: unknown): RuntimeResponse => {
  if (!isRecord(value)) {
    throw new Error("Code-mode host returned an invalid runtime response");
  }
  const kind = isRecord(value.Yielded)
    ? "yielded"
    : isRecord(value.Terminated)
      ? "terminated"
      : isRecord(value.Result)
        ? "result"
        : undefined;
  if (!kind) {
    throw new Error("Code-mode host returned an invalid runtime response");
  }
  const body =
    value[
      kind === "yielded"
        ? "Yielded"
        : kind === "terminated"
          ? "Terminated"
          : "Result"
    ];
  if (!isRecord(body) || typeof body.cell_id !== "string") {
    throw new Error("Code-mode host returned an invalid runtime response");
  }
  return {
    cellId: body.cell_id,
    contentItems: parseContentItems(body.content_items),
    kind,
    ...(kind === "result" && typeof body.error_text === "string"
      ? { errorText: body.error_text }
      : {}),
  };
};

const parseContentItems = (value: unknown): RuntimeContentItem[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Code-mode host returned invalid content items");
  }
  return value.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Code-mode host returned an invalid content item");
    }
    if (item.type === "input_text" && typeof item.text === "string") {
      return { text: item.text, type: "input_text" };
    }
    if (
      item.type === "input_image" &&
      typeof item.image_url === "string" &&
      isImageDetail(item.detail)
    ) {
      return {
        image_url: item.image_url,
        type: "input_image",
        ...(item.detail === undefined ? {} : { detail: item.detail }),
      };
    }
    if (item.type === "input_audio") {
      throw new Error("Code-mode audio output is not supported by Pi");
    }
    throw new Error("Code-mode host returned an invalid content item");
  });
};

export type HostMessage =
  | { type: "connection/ready"; selectedVersion: 1; capabilities: string[] }
  | { type: "connection/rejected"; reason: unknown }
  | { type: "operation/response"; id: number; result: HostResult }
  | { type: "execute/initialResponse"; id: number; result: HostResult }
  | ({ type: "delegate/request" } & DelegateRequestMessage)
  | { type: "delegate/cancel"; id: number }
  | { type: "cell/closed"; cellId: string };

export interface DelegateRequestMessage {
  id: number;
  request:
    | { type: "notification/send"; cellId: string; text: string }
    | {
        type: "tool/invoke";
        invocation: {
          cell_id: string;
          input?: unknown;
          runtime_tool_call_id: string;
          tool_name: { name: string };
        };
      };
}

export type HostResult =
  | { status: "ok"; value: unknown }
  | { status: "error"; message: string };

export const parseHostMessage = (value: unknown): HostMessage => {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Code-mode host returned an invalid message");
  }
  const { type } = value;
  if (type === "connection/ready") {
    if (value.selectedVersion !== 1 || !isStringArray(value.capabilities)) {
      throw new Error("Code-mode host negotiated an invalid protocol");
    }
    return {
      capabilities: value.capabilities,
      selectedVersion: 1,
      type,
    };
  }
  if (type === "connection/rejected") {
    return { reason: value.reason, type };
  }
  if (type === "operation/response" || type === "execute/initialResponse") {
    return {
      id: parseMessageId(value.id),
      result: parseHostResult(value.result),
      type,
    };
  }
  if (type === "delegate/cancel") {
    return { id: parseMessageId(value.id), type };
  }
  if (type === "cell/closed") {
    if (typeof value.cellId !== "string") {
      throw new TypeError("Code-mode host returned an invalid cell closure");
    }
    return { cellId: value.cellId, type };
  }
  if (type === "delegate/request") {
    return { ...parseDelegateRequest(value), type };
  }
  throw new Error(`Code-mode host returned an unsupported message: ${type}`);
};

export const executionCellId = (value: unknown): string | undefined =>
  isRecord(value) &&
  value.type === "execution/started" &&
  typeof value.cellId === "string"
    ? value.cellId
    : undefined;

export const runtimeOutcome = (value: unknown): unknown => {
  if (!isRecord(value) || !isRecord(value.outcome)) {
    return undefined;
  }
  return value.outcome.LiveCell ?? value.outcome.MissingCell;
};

const parseDelegateRequest = (
  value: Record<string, unknown>
): DelegateRequestMessage => {
  const id = parseMessageId(value.id);
  const { request } = value;
  if (!isRecord(request) || typeof request.type !== "string") {
    throw new Error("Code-mode host returned an invalid delegate request");
  }
  if (request.type === "notification/send") {
    if (
      typeof request.cellId !== "string" ||
      typeof request.text !== "string"
    ) {
      throw new TypeError("Code-mode host returned an invalid notification");
    }
    return {
      id,
      request: {
        cellId: request.cellId,
        text: request.text,
        type: "notification/send",
      },
    };
  }
  if (request.type !== "tool/invoke" || !isRecord(request.invocation)) {
    throw new Error("Code-mode host returned an invalid tool invocation");
  }
  const { invocation } = request;
  const toolName = invocation.tool_name;
  if (
    typeof invocation.cell_id !== "string" ||
    typeof invocation.runtime_tool_call_id !== "string" ||
    !isRecord(toolName) ||
    typeof toolName.name !== "string"
  ) {
    throw new Error("Code-mode host returned an invalid tool invocation");
  }
  return {
    id,
    request: {
      invocation: {
        cell_id: invocation.cell_id,
        runtime_tool_call_id: invocation.runtime_tool_call_id,
        tool_name: { name: toolName.name },
        ...(invocation.input === undefined ? {} : { input: invocation.input }),
      },
      type: "tool/invoke",
    },
  };
};

const parseHostResult = (value: unknown): HostResult => {
  if (!isRecord(value)) {
    throw new Error("Code-mode host returned an invalid operation result");
  }
  if (value.status === "ok") {
    return { status: "ok", value: value.value };
  }
  if (value.status === "error" && typeof value.message === "string") {
    return { message: value.message, status: "error" };
  }
  throw new Error("Code-mode host returned an invalid operation result");
};

const parseMessageId = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("Code-mode host returned an invalid message id");
  }
  return Number(value);
};

const parseInteger = (
  value: unknown,
  name: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER
): number | null => {
  if (value === undefined) {
    return null;
  }
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  ) {
    throw new Error(
      `${name} must be a safe integer from ${minimum} to ${maximum}`
    );
  }
  return Number(value);
};

const isImageDetail = (
  value: unknown
): value is "auto" | "low" | "high" | "original" | null | undefined =>
  value === undefined ||
  value === null ||
  value === "auto" ||
  value === "low" ||
  value === "high" ||
  value === "original";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");
