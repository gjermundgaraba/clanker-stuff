// Adapted from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import { nestedToolKey } from "./protocol.js";
import type { DelegateRequestMessage, DelegateResponse } from "./protocol.js";
import { CodeModeTraceStore } from "./trace-store.js";
import { toolResultFromValue, truncateTraceText } from "./trace-values.js";
import type {
  NestedTool,
  NestedToolContext,
  RuntimeResponse,
  ToolExecutionContext,
} from "./types.js";

const MAX_TRACE_ERROR_CHARS = 16_384;

const MAX_NOTIFICATION_CHARS = 16_384;

const MAX_NOTIFICATIONS_PER_CELL = 100;

interface Cell {
  context: ToolExecutionContext;
  tools: ReadonlyMap<string, NestedTool>;
  closed: boolean;
  notifications: string[];
}

/** Cells live only while their owning exec is active; traces are presentation snapshots. */
export class CodeModeDelegateRuntime {
  private readonly cells = new Map<string, Cell>();
  private readonly controllers = new Map<number, AbortController>();
  private readonly pending = new Map<
    Promise<void>,
    { cellId: string; controller: AbortController }
  >();
  private readonly traces = new CodeModeTraceStore();

  constructor(private readonly send: (message: DelegateResponse) => void) {}

  bindCell(
    cellId: string,
    context: ToolExecutionContext,
    tools: ReadonlyMap<string, NestedTool>,
  ): void {
    this.traces.startCell(cellId);
    this.cells.set(cellId, { context, tools, closed: false, notifications: [] });
    this.emitUpdate(cellId);
  }

  async cancelAndSettle(cellId: string): Promise<void> {
    const pending = [...this.pending].filter(([, call]) => call.cellId === cellId);

    for (const [, call] of pending) call.controller.abort();
    await Promise.allSettled(pending.map(([promise]) => promise));
  }

  async finishResponse(response: RuntimeResponse): Promise<RuntimeResponse> {
    if (response.kind === "yielded") return this.attach(response);
    this.closeCell(response.cellId);

    try {
      await this.cancelAndSettle(response.cellId);

      return this.attach(response);
    } finally {
      this.cells.delete(response.cellId);
      this.traces.delete(response.cellId);
    }
  }

  async disposeCell(cellId: string): Promise<void> {
    this.closeCell(cellId);
    await this.cancelAndSettle(cellId);
    this.cells.delete(cellId);
    this.traces.delete(cellId);
  }

  closeCell(cellId: string): void {
    const cell = this.cells.get(cellId);

    if (cell) cell.closed = true;
    this.traces.finishCell(cellId);
  }

  clear(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.cells.clear();
    this.traces.clear();
  }

  cancel(id: number): void {
    this.controllers.get(id)?.abort();
  }

  handleRequest(message: DelegateRequestMessage): void {
    if (this.controllers.has(message.id))
      throw new Error(`Duplicate code-mode delegate request: ${message.id}`);
    const controller = new AbortController();
    this.controllers.set(message.id, controller);

    const pending = this.invoke(message, controller)
      .catch((error: unknown) => {
        this.respond(message.id, {
          message: error instanceof Error ? error.message : String(error),
          status: "error",
        });
      })
      .finally(() => this.controllers.delete(message.id));

    this.pending.set(pending, {
      cellId:
        message.request.type === "tool/invoke"
          ? message.request.invocation.cell_id
          : message.request.cellId,
      controller,
    });
    void pending.then(() => this.pending.delete(pending));
  }

  attach(response: RuntimeResponse): RuntimeResponse {
    const cell = this.cells.get(response.cellId);
    const notifications = cell?.notifications.splice(0) ?? [];
    const withTraces = this.traces.attach(response);

    return notifications.length === 0
      ? withTraces
      : {
          ...withTraces,
          contentItems: [
            ...notifications.map((text) => ({ text, type: "input_text" as const })),
            ...response.contentItems,
          ],
        };
  }

  private emitUpdate(cellId: string, notification?: string): void {
    try {
      this.cells.get(cellId)?.context.onUpdate?.({
        content: notification === undefined ? [] : [{ type: "text", text: notification }],
        details: {
          ...this.traces.snapshot(cellId),
          status: "running",
          notification: notification !== undefined,
        },
      });
    } catch {
      // A presentation callback cannot fail tool execution or notification delivery.
    }
  }

  private async invoke(
    message: DelegateRequestMessage,
    controller: AbortController,
  ): Promise<void> {
    const { request } = message;
    const cellId = request.type === "tool/invoke" ? request.invocation.cell_id : request.cellId;
    const cell = this.cells.get(cellId);

    if (!cell || cell.closed) throw new Error("Code-mode cell context is unavailable");

    if (request.type === "notification/send") {
      const text = request.text.slice(0, MAX_NOTIFICATION_CHARS);
      cell.notifications.push(text);

      if (cell.notifications.length > MAX_NOTIFICATIONS_PER_CELL) cell.notifications.shift();
      this.emitUpdate(cellId, text);
      this.respond(message.id, { status: "ok", value: { type: "notification/delivered" } });

      return;
    }

    const { invocation } = request;
    const toolName = nestedToolKey(invocation.tool_name);
    const tool = cell.tools.get(toolName);

    if (!tool) throw new Error(`Unknown nested tool: ${toolName}`);

    const trace = this.traces.start(
      cellId,
      invocation.runtime_tool_call_id,
      tool.definition.name,
      invocation.input,
    );

    const context: NestedToolContext = {
      cellId,
      extensionContext: cell.context.extensionContext,
      captureResult: (result, toolCallId) => {
        trace.id = toolCallId;
        trace.result = this.traces.captureResult(cellId, trace, result);
        this.emitUpdate(cellId);
      },
      onUpdate: (result) => {
        trace.result = this.traces.captureResult(cellId, trace, result);
        this.emitUpdate(cellId);
      },
    };

    this.emitUpdate(cellId);

    try {
      const result = await tool.invoke(invocation.input, context, controller.signal);
      trace.result ??= this.traces.captureResult(cellId, trace, toolResultFromValue(result));
      trace.status = "done";
      this.respond(message.id, { status: "ok", value: { result, type: "tool/result" } });
    } catch (error) {
      trace.status = "error";
      trace.error = truncateTraceText(
        error instanceof Error ? error.message : String(error),
        MAX_TRACE_ERROR_CHARS,
      );
      throw error;
    } finally {
      this.emitUpdate(cellId);
    }
  }

  private respond(id: number, result: DelegateResponse["result"]): void {
    try {
      this.send({ id, result, type: "delegate/response" });
    } catch (error) {
      try {
        this.send({
          id,
          type: "delegate/response",
          result: {
            message: `Failed to serialize nested tool result: ${error instanceof Error ? error.message : String(error)}`,
            status: "error",
          },
        });
      } catch {
        // Host teardown rejects the owning exec.
      }
    }
  }
}
