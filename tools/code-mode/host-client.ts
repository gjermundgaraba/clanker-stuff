/* oxlint-disable eslint/no-use-before-define, eslint/no-plusplus, promise/avoid-new, promise/prefer-await-to-then, promise/prefer-await-to-callbacks -- framed subprocess protocol requires explicit deferreds and callbacks */
// Adapted from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { CodeModeDelegateRuntime } from "./delegate-runtime.js";
import {
  DEFAULT_CODE_MODE_EXEC_YIELD_MS,
  executionCellId,
  isMissingRuntimeOutcome,
  parseExecSource,
  parseHostMessage,
  parseRuntimeResponse,
  runtimeOutcome,
  toWireToolDefinition,
} from "./protocol.js";
import type { HostMessage } from "./protocol.js";
import type {
  NestedTool,
  RuntimeResponse,
  ToolExecutionContext,
} from "./types.js";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_QUEUED_WRITE_BYTES = 128 * 1024 * 1024;
const DEFAULT_SHUTDOWN_GRACE_MS = 250;

interface Pending {
  context?: ToolExecutionContext;
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  tools?: Map<string, NestedTool>;
}

export class CodeModeHostClient {
  private readonly binary: string;
  private buffer = Buffer.alloc(0);
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly delegateRuntime = new CodeModeDelegateRuntime((message) => {
    this.send(message);
  });
  private readonly initial = new Map<number, Pending>();
  private readonly pending = new Map<number, Pending>();
  private queuedWriteBytes = 0;
  private ready: Promise<void> | undefined;
  private requestId = 0;
  private readonly sessionId = randomUUID();
  private stderr = "";

  constructor(binary: string) {
    this.binary = binary;
  }

  async start(): Promise<void> {
    if (this.ready) {
      await this.ready;
      return;
    }
    const ready = this.startProcess();
    this.ready = ready;
    try {
      await ready;
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async execute(
    source: string,
    context: ToolExecutionContext,
    signal: AbortSignal | undefined,
    tools: NestedTool[]
  ): Promise<RuntimeResponse> {
    throwIfAborted(signal);
    await this.start();
    throwIfAborted(signal);
    const { code, maxOutputTokens, yieldTimeMs } = parseExecSource(source);
    const id = ++this.requestId;
    const initial = new Promise<unknown>((resolve, reject) => {
      this.initial.set(id, { reject, resolve });
    });
    void initial.catch(() => null);
    const toolSet = new Map(tools.map((tool) => [tool.definition.name, tool]));
    const started = this.requestWithId(
      id,
      {
        method: "session/execute",
        request: {
          enabled_tools: tools.map(toWireToolDefinition),
          max_output_tokens: maxOutputTokens,
          source: code,
          tool_call_id: `exec-${id}`,
          yield_time_ms: yieldTimeMs ?? DEFAULT_CODE_MODE_EXEC_YIELD_MS,
        },
        sessionId: this.sessionId,
      },
      context,
      toolSet
    );
    let cellId: string | undefined;
    const abort = () => {
      const error = abortError();
      try {
        this.send({ id, type: "operation/cancel" });
      } catch {
        // Host teardown is already authoritative.
      }
      this.rejectOperation(id, error);
      if (cellId !== undefined && cellId.length > 0) {
        void this.terminate(cellId, context).catch(() => null);
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const startedValue = await started;
      cellId = executionCellId(startedValue);
      if (signal?.aborted === true) {
        abort();
        throw abortError();
      }
      return {
        ...this.delegateRuntime.attach(parseRuntimeResponse(await initial)),
        maxOutputTokens: maxOutputTokens ?? 10_000,
      };
    } catch (error) {
      this.initial.delete(id);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async wait(
    cellId: string,
    yieldTimeMs: number,
    context: ToolExecutionContext,
    signal?: AbortSignal
  ): Promise<RuntimeResponse> {
    throwIfAborted(signal);
    await this.start();
    throwIfAborted(signal);
    this.delegateRuntime.updateCellContext(cellId, context);
    const id = ++this.requestId;
    return await this.abortableOperation(id, signal, async () => {
      const value = await this.requestWithId(
        id,
        {
          method: "session/wait",
          request: { cell_id: cellId, yield_time_ms: yieldTimeMs },
          sessionId: this.sessionId,
        },
        context
      );
      const wrapped = runtimeOutcome(value);
      if (wrapped === undefined || wrapped === null) {
        throw new Error("Code-mode host returned an invalid wait outcome");
      }
      return {
        ...this.delegateRuntime.attach(parseRuntimeResponse(wrapped)),
        ...(isMissingRuntimeOutcome(value)
          ? { missingCell: true as const }
          : {}),
      };
    });
  }

  async terminate(
    cellId: string,
    context: ToolExecutionContext,
    signal?: AbortSignal
  ): Promise<RuntimeResponse> {
    throwIfAborted(signal);
    await this.start();
    throwIfAborted(signal);
    this.delegateRuntime.updateCellContext(cellId, context);
    const id = ++this.requestId;
    return await this.abortableOperation(id, signal, async () => {
      const value = await this.requestWithId(
        id,
        {
          cellId,
          method: "session/terminate",
          sessionId: this.sessionId,
        },
        context
      );
      const wrapped = runtimeOutcome(value);
      if (wrapped === undefined || wrapped === null) {
        throw new Error(
          "Code-mode host returned an invalid termination outcome"
        );
      }
      return {
        ...this.delegateRuntime.attach(parseRuntimeResponse(wrapped)),
        ...(isMissingRuntimeOutcome(value)
          ? { missingCell: true as const }
          : {}),
      };
    });
  }

  async shutdown(): Promise<void> {
    const { child } = this;
    if (!child) {
      return;
    }
    try {
      await Promise.race([
        this.request({
          method: "session/shutdown",
          sessionId: this.sessionId,
        }),
        new Promise<void>((resolve) => {
          setTimeout(resolve, DEFAULT_SHUTDOWN_GRACE_MS);
        }),
      ]);
    } catch {
      // Process teardown below is authoritative.
    }
    child.kill();
    this.failAll(new Error("Code-mode host shut down"));
  }

  private async startProcess(): Promise<void> {
    const child = spawn(this.binary, [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child === child) {
        this.onData(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.child === child) {
        this.stderr = (this.stderr + chunk.toString()).slice(-16_384);
      }
    });
    child.on("error", (error) => {
      if (this.child === child) {
        this.failAll(error);
      }
    });
    child.on("close", (code) => {
      if (this.child === child) {
        this.failAll(
          new Error(
            `Code-mode host exited with code ${code ?? "unknown"}${
              this.stderr.trim() ? `: ${this.stderr.trim()}` : ""
            }`
          )
        );
      }
    });
    const handshake = new Promise<void>((resolve, reject) => {
      this.pending.set(0, {
        reject,
        resolve: () => {
          resolve();
        },
      });
    });
    this.send({
      optionalCapabilities: [],
      requiredCapabilities: [],
      supportedVersions: [1],
      type: "connection/hello",
    });
    await handshake;
    await this.request({ method: "session/open", sessionId: this.sessionId });
  }

  private async abortableOperation<T>(
    id: number,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    const abort = () => {
      const error = abortError();
      try {
        this.send({ id, type: "operation/cancel" });
      } catch {
        // Host teardown is already authoritative.
      }
      this.rejectOperation(id, error);
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await operation();
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private request(
    request: Record<string, unknown>,
    context?: ToolExecutionContext
  ): Promise<unknown> {
    return this.requestWithId(++this.requestId, request, context);
  }

  private requestWithId(
    id: number,
    request: Record<string, unknown>,
    context?: ToolExecutionContext,
    tools?: Map<string, NestedTool>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { context, reject, resolve, tools });
      try {
        this.send({ id, request, type: "operation/request" });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private rejectOperation(id: number, error: Error): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    pending?.reject(error);
    const initial = this.initial.get(id);
    this.initial.delete(id);
    initial?.reject(error);
  }

  private send(message: unknown): void {
    const { child } = this;
    if (child?.stdin.writable !== true) {
      throw new Error("Code-mode host is not running");
    }
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > MAX_FRAME_BYTES) {
      throw new Error(`Code-mode frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(payload.length);
    const frame = Buffer.concat([header, payload]);
    if (this.queuedWriteBytes + frame.length > MAX_QUEUED_WRITE_BYTES) {
      throw new Error(
        `Code-mode write queue exceeds ${MAX_QUEUED_WRITE_BYTES} bytes`
      );
    }
    this.queuedWriteBytes += frame.length;
    child.stdin.write(frame, (error) => {
      this.queuedWriteBytes = Math.max(0, this.queuedWriteBytes - frame.length);
      if (error !== null && error !== undefined && this.child === child) {
        this.failAll(error);
      }
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_FRAME_BYTES) {
        this.failAll(
          new Error(`Code-mode frame exceeds ${MAX_FRAME_BYTES} bytes`)
        );
        return;
      }
      if (this.buffer.length < length + 4) {
        return;
      }
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      try {
        this.handleMessage(
          parseHostMessage(JSON.parse(payload.toString("utf-8")))
        );
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleMessage(message: HostMessage): void {
    if (message.type === "connection/ready") {
      const pending = this.pending.get(0);
      this.pending.delete(0);
      pending?.resolve(null);
      return;
    }
    if (message.type === "connection/rejected") {
      const pending = this.pending.get(0);
      this.pending.delete(0);
      pending?.reject(
        new Error(
          `Code-mode handshake rejected: ${JSON.stringify(message.reason)}`
        )
      );
      return;
    }
    if (message.type === "operation/response") {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!pending) {
        return;
      }
      if (message.result.status === "error") {
        pending.reject(new Error(message.result.message));
        return;
      }
      const { value } = message.result;
      const cellId = executionCellId(value);
      if (
        cellId !== undefined &&
        cellId.length > 0 &&
        pending.context !== undefined
      ) {
        this.delegateRuntime.bindCell(cellId, pending.context, pending.tools);
      }
      pending.resolve(value);
      return;
    }
    if (message.type === "execute/initialResponse") {
      const pending = this.initial.get(message.id);
      this.initial.delete(message.id);
      if (!pending) {
        return;
      }
      if (message.result.status === "error") {
        pending.reject(new Error(message.result.message));
      } else {
        pending.resolve(message.result.value);
      }
      return;
    }
    if (message.type === "delegate/request") {
      this.delegateRuntime.handleRequest(message);
      return;
    }
    if (message.type === "delegate/cancel") {
      this.delegateRuntime.cancel(message.id);
      return;
    }
    this.delegateRuntime.closeCell(message.cellId);
  }

  private failAll(error: Error): void {
    for (const pending of [
      ...this.pending.values(),
      ...this.initial.values(),
    ]) {
      pending.reject(error);
    }
    this.pending.clear();
    this.initial.clear();
    this.delegateRuntime.clear();
    this.queuedWriteBytes = 0;
    const { child } = this;
    this.child = undefined;
    this.ready = undefined;
    if (child !== undefined && !child.killed) {
      child.kill();
    }
  }
}

const abortError = () => {
  const error = new Error("Code-mode operation aborted");
  error.name = "AbortError";
  return error;
};

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted === true) {
    throw abortError();
  }
};
