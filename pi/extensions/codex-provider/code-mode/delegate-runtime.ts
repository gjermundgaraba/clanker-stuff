/* oxlint-disable eslint/no-use-before-define -- delegate handling is ordered by protocol lifecycle */
// Adapted from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import type { DelegateRequestMessage } from "./protocol.js";
import { CodeModeTraceStore } from "./trace-store.js";
import { toolResultFromValue, truncateTraceText } from "./trace-values.js";
import type {
  NestedTool,
  RuntimeResponse,
  RuntimeToolResult,
  ToolExecutionContext,
} from "./types.js";

const MAX_TRACE_ERROR_CHARS = 16_384;
const MAX_NOTIFICATION_CHARS = 16_384;
const MAX_NOTIFICATIONS_PER_CELL = 100;

export class CodeModeDelegateRuntime {
  private readonly cellContexts = new Map<string, ToolExecutionContext>();
  private readonly cellTools = new Map<string, Map<string, NestedTool>>();
  private readonly cleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly controllers = new Map<number, AbortController>();
  private readonly notifications = new Map<string, string[]>();
  private readonly send: (message: unknown) => void;
  private readonly traces = new CodeModeTraceStore();

  constructor(send: (message: unknown) => void) {
    this.send = send;
  }

  bindCell(
    cellId: string,
    context: ToolExecutionContext,
    tools?: Map<string, NestedTool>
  ): void {
    this.cellContexts.set(cellId, context);
    if (tools) {
      this.cellTools.set(cellId, tools);
    }
  }

  updateCellContext(cellId: string, context: ToolExecutionContext): void {
    this.cellContexts.set(cellId, context);
  }

  closeCell(cellId: string): void {
    this.cellContexts.delete(cellId);
    this.cellTools.delete(cellId);
    const previous = this.cleanupTimers.get(cellId);
    if (previous) {
      clearTimeout(previous);
    }
    this.cleanupTimers.set(
      cellId,
      setTimeout(() => {
        this.cleanupTimers.delete(cellId);
        this.notifications.delete(cellId);
        this.traces.delete(cellId);
      }, 1000)
    );
  }

  clear(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    this.cellContexts.clear();
    this.cellTools.clear();
    this.traces.clear();
    this.notifications.clear();
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
  }

  cancel(id: number): void {
    const controller = this.controllers.get(id);
    this.controllers.delete(id);
    controller?.abort();
  }

  handleRequest(message: DelegateRequestMessage): void {
    if (this.controllers.has(message.id)) {
      throw new Error(`Duplicate code-mode delegate request: ${message.id}`);
    }
    const controller = new AbortController();
    this.controllers.set(message.id, controller);
    void this.invoke(message, controller);
  }

  attach(response: RuntimeResponse): RuntimeResponse {
    const cleanupTimer = this.cleanupTimers.get(response.cellId);
    if (cleanupTimer) {
      clearTimeout(cleanupTimer);
    }
    this.cleanupTimers.delete(response.cellId);
    const notifications = this.notifications.get(response.cellId) ?? [];
    this.notifications.delete(response.cellId);
    const withTraces = this.traces.attach(response);
    if (notifications.length === 0) {
      return withTraces;
    }
    return {
      ...withTraces,
      contentItems: [
        ...notifications.map((text) => ({
          text,
          type: "input_text" as const,
        })),
        ...response.contentItems,
      ],
    };
  }

  private async invoke(
    message: DelegateRequestMessage,
    controller: AbortController
  ): Promise<void> {
    const { request } = message;
    if (request.type === "notification/send") {
      this.handleNotification(message.id, request);
      return;
    }
    const { invocation } = request;
    const cellId = invocation.cell_id;
    const toolName = invocation.tool_name.name;
    const { input } = invocation;
    const tool = this.cellTools.get(cellId)?.get(toolName);
    const context = this.cellContexts.get(cellId);
    if (!(tool && context)) {
      this.respond(message.id, {
        message: tool
          ? "Code-mode cell context is unavailable"
          : `Unknown nested tool: ${toolName}`,
        status: "error",
      });
      this.controllers.delete(message.id);
      return;
    }

    const trace = this.traces.start(
      cellId,
      invocation.runtime_tool_call_id,
      tool.definition.name,
      input
    );
    const invocationContext: ToolExecutionContext = {
      ...context,
      captureResult: (result) => {
        trace.result = this.traces.captureResult(cellId, trace, result);
        this.traces.emitUpdate(cellId, context);
      },
      onUpdate: (update) => {
        trace.result = this.traces.captureResult(
          cellId,
          trace,
          normalizeResult(update)
        );
        this.traces.emitUpdate(cellId, context);
      },
      toolCallId: trace.id,
    };
    this.traces.emitUpdate(cellId, context);
    try {
      const result = await tool.invoke(
        input,
        invocationContext,
        controller.signal
      );
      trace.result ??= this.traces.captureResult(
        cellId,
        trace,
        toolResultFromValue(result)
      );
      trace.status = "done";
      this.traces.emitUpdate(cellId, context);
      this.respond(message.id, {
        status: "ok",
        value: { result, type: "tool/result" },
      });
    } catch (error) {
      trace.status = "error";
      trace.error = truncateTraceText(
        error instanceof Error ? error.message : String(error),
        MAX_TRACE_ERROR_CHARS
      );
      this.traces.emitUpdate(cellId, context);
      this.respond(message.id, {
        message: error instanceof Error ? error.message : String(error),
        status: "error",
      });
    } finally {
      this.controllers.delete(message.id);
    }
  }

  private handleNotification(
    id: number,
    request: Extract<
      DelegateRequestMessage["request"],
      { type: "notification/send" }
    >
  ): void {
    const { cellId } = request;
    const context = this.cellContexts.get(cellId);
    if (!context) {
      this.respond(id, {
        message: "Code-mode notification cell is unavailable",
        status: "error",
      });
      this.controllers.delete(id);
      return;
    }
    const notifications = this.notifications.get(cellId) ?? [];
    const text = request.text.slice(0, MAX_NOTIFICATION_CHARS);
    notifications.push(text);
    if (notifications.length > MAX_NOTIFICATIONS_PER_CELL) {
      notifications.splice(
        0,
        notifications.length - MAX_NOTIFICATIONS_PER_CELL
      );
    }
    this.notifications.set(cellId, notifications);
    context.onUpdate?.({
      content: [{ text, type: "text" }],
      details: { cellId, notification: true },
    });
    this.respond(id, {
      status: "ok",
      value: { type: "notification/delivered" },
    });
    this.controllers.delete(id);
  }

  private respond(id: number, result: Record<string, unknown>): void {
    try {
      this.send({ id, result, type: "delegate/response" });
    } catch (error) {
      try {
        this.send({
          id,
          result: {
            message: `Failed to serialize nested tool result: ${
              error instanceof Error ? error.message : String(error)
            }`,
            status: "error",
          },
          type: "delegate/response",
        });
      } catch {
        // Host teardown rejects the owning operation.
      }
    }
  }
}

const normalizeResult = (result: {
  content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
    | { type: string }
  )[];
  details?: unknown;
}): RuntimeToolResult => ({
  content: result.content.filter(
    (
      item
    ): item is
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string } =>
      (item.type === "text" && "text" in item) ||
      (item.type === "image" && "data" in item && "mimeType" in item)
  ),
  details: result.details,
});
