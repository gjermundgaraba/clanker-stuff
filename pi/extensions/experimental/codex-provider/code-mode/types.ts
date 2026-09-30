import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

const RuntimeToolContentSchema = Type.Union([
  Type.Object({ text: Type.String(), type: Type.Literal("text") }),
  Type.Object({ data: Type.String(), mimeType: Type.String(), type: Type.Literal("image") }),
]);

export const RuntimeToolResultSchema = Type.Object({
  content: Type.Array(RuntimeToolContentSchema),
  details: Type.Optional(Type.Unknown()),
});

export type RuntimeToolResult = Static<typeof RuntimeToolResultSchema>;

export const RuntimeToolTraceSchema = Type.Object({
  error: Type.Optional(Type.String()),
  id: Type.String(),
  input: Type.Unknown(),
  name: Type.String(),
  result: Type.Optional(RuntimeToolResultSchema),
  status: Type.Union([Type.Literal("running"), Type.Literal("done"), Type.Literal("error")]),
});

export type RuntimeToolTrace = Static<typeof RuntimeToolTraceSchema>;

export type ToolMetadata = Pick<
  ToolDefinition,
  | "name"
  | "description"
  | "parameters"
  | "constrainedSampling"
  | "promptGuidelines"
  | "outputSchema"
  | "renderCall"
  | "renderResult"
>;

export interface NestedTool {
  definition: ToolMetadata;
  /** Argument property that receives the raw freeform string; undefined for function tools. */
  freeformProperty?: string;
  kind: "freeform" | "function";
  name: string;
  namespace?: string;
  outputSchema?: unknown;
  usage: string;
  invoke: (
    input: JsonValue | undefined,
    context: NestedToolContext,
    signal: AbortSignal,
    // oxlint-disable-next-line anti-slop/no-unknown-returns -- Heterogeneous delegated tools own their result schemas; structured results are parsed JSON the calling cell interprets.
  ) => Promise<unknown>;
}

export interface ToolExecutionContext {
  extensionContext: ExtensionToolContext;
  onUpdate?: (result: AgentToolResult<unknown>) => void;
}

export interface NestedToolContext extends ToolExecutionContext {
  cellId: string;
  captureResult?: (result: RuntimeToolResult, toolCallId: string) => void;
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
  /** UI-only elapsed-time snapshot; never part of the host protocol or model output. */
  elapsedMs?: number;
  droppedTraceCount?: number;
  maxOutputTokens?: number;
  traces?: RuntimeToolTrace[];
};
