import type {
  AgentToolResult,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface NestedTool {
  definition: ToolDefinition;
  kind: "freeform" | "function";
  name: string;
  namespace?: string;
  outputSchema?: unknown;
  usage: string;
  invoke: (
    input: unknown,
    context: ToolExecutionContext,
    signal: AbortSignal
  ) => Promise<unknown>;
}

export interface ToolExecutionContext {
  extensionContext: ExtensionContext;
  toolCallId?: string;
  onUpdate?: (result: AgentToolResult<unknown>) => void;
  captureResult?: (result: RuntimeToolResult) => void;
}

export interface RuntimeToolResult {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[];
  details?: unknown;
}

export interface RuntimeToolTrace {
  error?: string;
  id: string;
  input: unknown;
  name: string;
  result?: RuntimeToolResult;
  status: "running" | "done" | "error";
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
