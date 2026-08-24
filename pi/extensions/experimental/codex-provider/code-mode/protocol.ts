// Protocol adapter derived from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type { NestedTool, RuntimeContentItem, RuntimeResponse } from "./types.js";

export const MAX_CODE_MODE_OUTPUT_TOKENS = 100_000;
export const DEFAULT_CODE_MODE_OUTPUT_TOKENS = 10_000;
export const DEFAULT_CODE_MODE_EXEC_YIELD_MS = 10_000;
const strict = { additionalProperties: false };

export const nestedToolKey = (toolName: { name: string; namespace?: null | string }): string =>
  `${toolName.namespace ?? "functions"}\0${toolName.name}`;

export const toWireToolDefinition = (tool: NestedTool) => ({
  description: [`Usage: ${tool.usage}`, tool.definition.description].join("\n"),
  input_schema: tool.kind === "freeform" ? null : tool.definition.parameters,
  kind: tool.kind,
  name: tool.name,
  output_schema: tool.outputSchema ?? null,
  tool_name: {
    name: tool.definition.name,
    namespace: tool.namespace ?? null,
  },
});

export type ExecPragma = {
  code: string;
  maxOutputTokens: number | null;
  yieldTimeMs: number | null;
};

const ExecOptionsRecordSchema = Type.Record(
  Type.String(),
  Type.Union([Type.Number(), Type.String(), Type.Boolean(), Type.Null()]),
);

export const parseExecSource = (source: string): ExecPragma => {
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
  const raw: unknown = JSON.parse(trimmed.slice("// @exec:".length).trim());
  if (!Value.Check(ExecOptionsRecordSchema, raw)) {
    throw new Error("exec pragma must contain a JSON object");
  }
  const options = Value.Parse(ExecOptionsRecordSchema, raw);
  for (const key of Object.keys(options)) {
    if (key !== "yield_time_ms" && key !== "max_output_tokens") {
      throw new Error(`Unsupported exec pragma field: ${key}`);
    }
  }
  return {
    code: rest.join("\n"),
    maxOutputTokens: parseInteger(
      requireNumber(options.max_output_tokens, "max_output_tokens"),
      "max_output_tokens",
      1,
      MAX_CODE_MODE_OUTPUT_TOKENS,
    ),
    yieldTimeMs: parseInteger(
      requireNumber(options.yield_time_ms, "yield_time_ms"),
      "yield_time_ms",
    ),
  };
};

type ExecOptionWire = number | string | boolean | null;

const requireNumber = (field: ExecOptionWire | undefined, name: string): number | undefined => {
  if (field === undefined) {
    return undefined;
  }
  const NumberSchema = Type.Number();
  if (!Value.Check(NumberSchema, field)) {
    throw new Error(`${name} must be a safe integer from 0 to ${Number.MAX_SAFE_INTEGER}`);
  }
  return Value.Parse(NumberSchema, field);
};

const parseInteger = (
  value: number | undefined,
  name: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null => {
  if (value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return value;
};

const ImageDetailSchema = Type.Union([
  Type.Literal("auto"),
  Type.Literal("low"),
  Type.Literal("high"),
  Type.Literal("original"),
  Type.Null(),
]);

const TextItemSchema = Type.Object({ text: Type.String(), type: Type.Literal("input_text") });
const ImageItemSchema = Type.Object({
  detail: Type.Optional(ImageDetailSchema),
  image_url: Type.String(),
  type: Type.Literal("input_image"),
});
const AudioItemSchema = Type.Object({ type: Type.Literal("input_audio") });

const RuntimeBodyWireSchema = Type.Object({
  cell_id: Type.String(),
  content_items: Type.Optional(Type.Array(Type.Unknown())),
  error_text: Type.Optional(Type.String()),
});

export const RuntimeResponseWireSchema = Type.Union([
  Type.Object({ Yielded: RuntimeBodyWireSchema }, strict),
  Type.Object({ Terminated: RuntimeBodyWireSchema }, strict),
  Type.Object({ Result: RuntimeBodyWireSchema }, strict),
]);

export type RuntimeResponseWire = Static<typeof RuntimeResponseWireSchema>;

export const RuntimeOutcomeWireSchema = Type.Object({
  outcome: Type.Object({
    LiveCell: Type.Optional(RuntimeResponseWireSchema),
    MissingCell: Type.Optional(RuntimeResponseWireSchema),
  }),
});

export type RuntimeOutcomeWire = Static<typeof RuntimeOutcomeWireSchema>;

export const ExecutionStartedWireSchema = Type.Object({
  cellId: Type.String(),
  type: Type.Literal("execution/started"),
});

const parseContentItems = (items: readonly unknown[]): RuntimeContentItem[] =>
  items.map((item) => {
    if (Value.Check(AudioItemSchema, item)) {
      throw new Error("Code-mode audio output is not supported by Pi");
    }
    if (Value.Check(TextItemSchema, item)) {
      return Value.Parse(TextItemSchema, item);
    }
    if (Value.Check(ImageItemSchema, item)) {
      const image = Value.Parse(ImageItemSchema, item);
      return image.detail === undefined
        ? { image_url: image.image_url, type: "input_image" }
        : { detail: image.detail, image_url: image.image_url, type: "input_image" };
    }
    throw new Error("Code-mode host returned an invalid content item");
  });

export const parseRuntimeResponse = (wire: RuntimeResponseWire): RuntimeResponse => {
  if ("Yielded" in wire) {
    const body = wire.Yielded;
    return {
      cellId: body.cell_id,
      contentItems: parseContentItems(body.content_items ?? []),
      kind: "yielded",
    };
  }
  if ("Terminated" in wire) {
    const body = wire.Terminated;
    return {
      cellId: body.cell_id,
      contentItems: parseContentItems(body.content_items ?? []),
      kind: "terminated",
    };
  }
  const body = wire.Result;
  return {
    cellId: body.cell_id,
    contentItems: parseContentItems(body.content_items ?? []),
    errorText: body.error_text,
    kind: "result",
  };
};

export type HostResultValue =
  | { kind: "event"; wire: unknown }
  | { kind: "outcome"; wire: RuntimeOutcomeWire }
  | { kind: "response"; wire: RuntimeResponseWire };

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
          tool_name: { name: string; namespace: null | string };
        };
      };
}

export type HostResult =
  | { status: "error"; message: string }
  | { status: "ok"; value: HostResultValue };

export interface DelegateResponse {
  id: number;
  result: { status: "ok"; value: unknown } | { message: string; status: "error" };
  type: "delegate/response";
}

const MessageIdSchema = Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 0 });

const ConnectionReadySchema = Type.Object({
  capabilities: Type.Array(Type.String()),
  selectedVersion: Type.Literal(1),
  type: Type.Literal("connection/ready"),
});

const ConnectionRejectedSchema = Type.Object({
  reason: Type.Unknown(),
  type: Type.Literal("connection/rejected"),
});

const HostOkResultSchema = Type.Object({
  status: Type.Literal("ok"),
  value: Type.Unknown(),
});

const HostErrorResultSchema = Type.Object({
  message: Type.String(),
  status: Type.Literal("error"),
});

const HostResultSchema = Type.Union([HostOkResultSchema, HostErrorResultSchema]);

const OperationResponseSchema = Type.Object({
  id: MessageIdSchema,
  result: HostResultSchema,
  type: Type.Literal("operation/response"),
});

const ExecuteInitialResponseSchema = Type.Object({
  id: MessageIdSchema,
  result: HostResultSchema,
  type: Type.Literal("execute/initialResponse"),
});

const DelegateNotificationSchema = Type.Object({
  cellId: Type.String(),
  text: Type.String(),
  type: Type.Literal("notification/send"),
});

const DelegateToolInvokeSchema = Type.Object({
  invocation: Type.Object({
    cell_id: Type.String(),
    input: Type.Optional(Type.Unknown()),
    runtime_tool_call_id: Type.String(),
    tool_name: Type.Object({
      name: Type.String(),
      namespace: Type.Union([Type.Null(), Type.String()]),
    }),
  }),
  type: Type.Literal("tool/invoke"),
});

const DelegateRequestSchema = Type.Object({
  id: MessageIdSchema,
  request: Type.Union([DelegateNotificationSchema, DelegateToolInvokeSchema]),
  type: Type.Literal("delegate/request"),
});

const DelegateCancelSchema = Type.Object({
  id: MessageIdSchema,
  type: Type.Literal("delegate/cancel"),
});

const CellClosedSchema = Type.Object({
  cellId: Type.String(),
  type: Type.Literal("cell/closed"),
});

const MessageTypeSchema = Type.Object({ type: Type.String() });

const classifyHostResult = (result: Static<typeof HostResultSchema>): HostResult => {
  if (result.status === "error") {
    return result;
  }
  const raw = result.value;
  if (Value.Check(RuntimeResponseWireSchema, raw)) {
    return {
      status: "ok",
      value: { kind: "response", wire: Value.Parse(RuntimeResponseWireSchema, raw) },
    };
  }
  if (Value.Check(RuntimeOutcomeWireSchema, raw)) {
    return {
      status: "ok",
      value: { kind: "outcome", wire: Value.Parse(RuntimeOutcomeWireSchema, raw) },
    };
  }
  return { status: "ok", value: { kind: "event", wire: raw } };
};

export const parseHostMessage = (text: string): HostMessage => {
  const raw: unknown = JSON.parse(text);
  if (!Value.Check(MessageTypeSchema, raw)) {
    throw new Error("Code-mode host returned an invalid message");
  }
  const { type } = Value.Parse(MessageTypeSchema, raw);
  if (type === "connection/ready") {
    if (!Value.Check(ConnectionReadySchema, raw)) {
      throw new Error("Code-mode host negotiated an invalid protocol");
    }
    return Value.Parse(ConnectionReadySchema, raw);
  }
  if (type === "connection/rejected") {
    if (!Value.Check(ConnectionRejectedSchema, raw)) {
      throw new Error("Code-mode host returned an invalid rejection");
    }
    return Value.Parse(ConnectionRejectedSchema, raw);
  }
  if (type === "operation/response" || type === "execute/initialResponse") {
    const schema =
      type === "operation/response" ? OperationResponseSchema : ExecuteInitialResponseSchema;
    if (!Value.Check(schema, raw)) {
      throw new Error("Code-mode host returned an invalid operation result");
    }
    const parsed = Value.Parse(schema, raw);
    const result = classifyHostResult(parsed.result);
    return { id: parsed.id, result, type };
  }
  if (type === "delegate/cancel") {
    if (!Value.Check(DelegateCancelSchema, raw)) {
      throw new Error("Code-mode host returned an invalid cancellation");
    }
    return Value.Parse(DelegateCancelSchema, raw);
  }
  if (type === "cell/closed") {
    if (!Value.Check(CellClosedSchema, raw)) {
      throw new TypeError("Code-mode host returned an invalid cell closure");
    }
    return Value.Parse(CellClosedSchema, raw);
  }
  if (type === "delegate/request") {
    if (!Value.Check(DelegateRequestSchema, raw)) {
      throw new Error("Code-mode host returned an invalid delegate request");
    }
    return Value.Parse(DelegateRequestSchema, raw);
  }
  throw new Error(`Code-mode host returned an unsupported message: ${type}`);
};

export const executionCellId = (value: HostResultValue | null): string | undefined =>
  value?.kind === "event" && Value.Check(ExecutionStartedWireSchema, value.wire)
    ? Value.Parse(ExecutionStartedWireSchema, value.wire).cellId
    : undefined;

export const runtimeOutcome = (value: HostResultValue | null): RuntimeResponseWire | undefined =>
  value?.kind === "outcome"
    ? (value.wire.outcome.LiveCell ?? value.wire.outcome.MissingCell)
    : undefined;

export const runtimeResponseFromValue = (value: HostResultValue): RuntimeResponse => {
  if (value.kind !== "response") {
    throw new Error("Code-mode host returned an invalid runtime response");
  }
  return parseRuntimeResponse(value.wire);
};
