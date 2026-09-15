// Adapted from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { nestedToolKey } from "./protocol.js";
import type { DelegateRequestMessage, DelegateResponse } from "./protocol.js";
import { CodeModeTraceStore } from "./trace-store.js";
import { toolResultFromValue, truncateTraceText } from "./trace-values.js";
import type { NestedTool, RuntimeResponse, ToolExecutionContext } from "./types.js";

const MAX_TRACE_ERROR_CHARS = 16_384;
const MAX_NOTIFICATION_CHARS = 16_384;
const MAX_NOTIFICATIONS_PER_CELL = 100;

export class CodeModeDelegateRuntime {
  private readonly cellContexts = new Map<string, ExtensionContext>();
  private readonly observers = new Map<
    number,
    {
      cellId: string;
      onUpdate: NonNullable<ToolExecutionContext["onUpdate"]>;
    }
  >();
  private readonly cellTools = new Map<string, Map<string, NestedTool>>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly controllers = new Map<number, AbortController>();
  private readonly notifications = new Map<string, string[]>();
  private readonly send: (message: DelegateResponse) => void;
  private readonly traces = new CodeModeTraceStore();

  constructor(send: (message: DelegateResponse) => void) {
    this.send = send;
  }

  bindCell(cellId: string, context: ExtensionContext, tools?: Map<string, NestedTool>): void {
    this.traces.startCell(cellId);
    this.cellContexts.set(cellId, context);
    if (tools) {
      this.cellTools.set(cellId, tools);
    }
  }

  observe(id: number, cellId: string, onUpdate: ToolExecutionContext["onUpdate"]): void {
    if (!onUpdate) return;
    this.observers.set(id, { cellId, onUpdate });
    this.emitUpdate(cellId, onUpdate);
  }

  unobserve(id: number): void {
    this.observers.delete(id);
  }

  closeCell(cellId: string): void {
    this.traces.finishCell(cellId);
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
      }, 1000),
    );
  }

  clear(): void {
    for (const controller of this.controllers.values()) {
      controller.abort();
    }
    this.controllers.clear();
    this.cellContexts.clear();
    this.observers.clear();
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
    const run = async () => {
      try {
        await this.invoke(message, controller);
      } catch (error) {
        if (!this.controllers.delete(message.id)) {
          return;
        }
        this.respond(message.id, {
          message: error instanceof Error ? error.message : String(error),
          status: "error",
        });
      }
    };
    void run();
  }

  attach(response: RuntimeResponse): RuntimeResponse {
    if (response.kind !== "yielded") {
      this.cellContexts.delete(response.cellId);
      this.cellTools.delete(response.cellId);
    }
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

  private emitCellUpdate(cellId: string, notification?: string): void {
    // The host decides which overlapping operation it accepts. Until each settles, all
    // outstanding operations may display events; a rejected wait never steals another's updates.
    for (const observer of this.observers.values()) {
      if (observer.cellId === cellId) this.emitUpdate(cellId, observer.onUpdate, notification);
    }
  }

  private emitUpdate(
    cellId: string,
    onUpdate: NonNullable<ToolExecutionContext["onUpdate"]>,
    notification?: string,
  ): void {
    try {
      onUpdate({
        content: notification === undefined ? [] : [{ type: "text", text: notification }],
        details: {
          ...this.traces.snapshot(cellId),
          status: "running",
          notification: notification !== undefined,
        },
      });
    } catch {
      // UI failures must not affect execution, notification delivery, or other observers.
    }
  }

  private async invoke(
    message: DelegateRequestMessage,
    controller: AbortController,
  ): Promise<void> {
    const { request } = message;
    if (request.type === "notification/send") {
      this.handleNotification(message.id, request);
      return;
    }
    const { invocation } = request;
    const cellId = invocation.cell_id;
    const toolName = nestedToolKey(invocation.tool_name);
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
      input,
    );
    const invocationContext: ToolExecutionContext = {
      extensionContext: context,
      captureResult: (result) => {
        trace.result = this.traces.captureResult(cellId, trace, result);
        this.emitCellUpdate(cellId);
      },
      onUpdate: (update) => {
        trace.result = this.traces.captureResult(cellId, trace, update);
        this.emitCellUpdate(cellId);
      },
      toolCallId: trace.id,
    };
    this.emitCellUpdate(cellId);
    try {
      const result = await tool.invoke(input, invocationContext, controller.signal);
      trace.result ??= this.traces.captureResult(cellId, trace, toolResultFromValue(result));
      trace.status = "done";
      this.emitCellUpdate(cellId);
      this.respond(message.id, {
        status: "ok",
        value: { result, type: "tool/result" },
      });
    } catch (error) {
      trace.status = "error";
      trace.error = truncateTraceText(
        error instanceof Error ? error.message : String(error),
        MAX_TRACE_ERROR_CHARS,
      );
      this.emitCellUpdate(cellId);
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
    request: Extract<DelegateRequestMessage["request"], { type: "notification/send" }>,
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
      notifications.splice(0, notifications.length - MAX_NOTIFICATIONS_PER_CELL);
    }
    this.notifications.set(cellId, notifications);
    this.emitCellUpdate(cellId, text);
    this.respond(id, {
      status: "ok",
      value: { type: "notification/delivered" },
    });
    this.controllers.delete(id);
  }

  private respond(id: number, result: DelegateResponse["result"]): void {
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
