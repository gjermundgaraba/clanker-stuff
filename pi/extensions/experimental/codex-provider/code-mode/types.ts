import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

const OpaqueRuntimeValueSchema = Type.Unknown();
export type RuntimeValue = Static<typeof OpaqueRuntimeValueSchema>;

const RuntimeToolContentSchema = Type.Union([
  Type.Object({ text: Type.String(), type: Type.Literal("text") }),
  Type.Object({ data: Type.String(), mimeType: Type.String(), type: Type.Literal("image") }),
]);

export const RuntimeToolResultSchema = Type.Object({
  content: Type.Array(RuntimeToolContentSchema),
  details: Type.Optional(OpaqueRuntimeValueSchema),
});

export type RuntimeToolResult = Static<typeof RuntimeToolResultSchema>;

export const RuntimeToolTraceSchema = Type.Object({
  error: Type.Optional(Type.String()),
  id: Type.String(),
  input: OpaqueRuntimeValueSchema,
  name: Type.String(),
  result: Type.Optional(RuntimeToolResultSchema),
  status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("error")]),
});

export type RuntimeToolTrace = Static<typeof RuntimeToolTraceSchema>;

export interface NestedTool {
  definition: ToolDefinition;
  kind: "freeform" | "function";
  name: string;
  namespace?: string;
  outputSchema?: unknown;
  usage: string;
  invoke: (
    input: RuntimeValue,
    context: ToolExecutionContext,
    signal: AbortSignal,
  ) => Promise<RuntimeValue>;
}

export interface ToolExecutionContext {
  extensionContext: ExtensionContext;
  toolCallId?: string;
  onUpdate?: (result: AgentToolResult<unknown>) => void;
  captureResult?: (result: RuntimeToolResult) => void;
}

export interface RuntimeContentItem {
  detail?: "auto" | "low" | "high" | "original" | null;
  image_url?: string;
  text?: string;
  type: "input_text" | "input_image";
}

export type RuntimeResponse = (
  | { kind: "yielded"; cellId: string; contentItems: RuntimeContentItem[] }
  | { kind: "terminated"; cellId: string; contentItems: RuntimeContentItem[] }
  | {
      kind: "result";
      cellId: string;
      contentItems: RuntimeContentItem[];
      errorText?: string;
    }
) & {
  droppedTraceCount?: number;
  maxOutputTokens?: number;
  traces?: RuntimeToolTrace[];
};
