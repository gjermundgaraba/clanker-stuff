// Adapted from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { CodeModeDelegateRuntime } from "./delegate-runtime.js";
import {
  DEFAULT_CODE_MODE_EXEC_YIELD_MS,
  executionCellId,
  nestedToolKey,
  parseExecSource,
  parseHostMessage,
  parseRuntimeResponse,
  runtimeOutcome,
  runtimeResponseFromValue,
  toWireToolDefinition,
} from "./protocol.js";
import type { DelegateResponse, HostMessage, HostResultValue } from "./protocol.js";
import type { NestedTool, RuntimeResponse, ToolExecutionContext } from "./types.js";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const MAX_QUEUED_WRITE_BYTES = 128 * 1024 * 1024;

const DEFAULT_SHUTDOWN_GRACE_MS = 250;

const STARTUP_TIMEOUT_MS = 10_000;

interface Pending {
  context?: ToolExecutionContext;
  reject: (error: Error) => void;
  resolve: (value: HostResultValue | null) => void;
  tools?: Map<string, NestedTool>;
}

type HostRequest =
  | { method: "session/shutdown" | "session/open"; sessionId: string }
  | {
      method: "session/execute";
      request: {
        enabled_tools: ReturnType<typeof toWireToolDefinition>[];
        max_output_tokens: number | null;
        source: string;
        tool_call_id: string;
        yield_time_ms: number;
      };
      sessionId: string;
    }
  | {
      method: "session/wait";
      request: { cell_id: string; yield_time_ms: number };
      sessionId: string;
    }
  | { cellId: string; method: "session/terminate"; sessionId: string };

export class CodeModeHostClient {
  private readonly binary: string;
  private buffer = Buffer.alloc(0);
  private child: ChildProcessWithoutNullStreams | undefined;
  private delegateRuntime = new CodeModeDelegateRuntime((message) => {
    this.send(message);
  });
  private readonly initial = new Map<number, PromiseWithResolvers<HostResultValue>>();
  private readonly pending = new Map<number, Pending>();
  private queuedWriteBytes = 0;
  private ready: Promise<void> | undefined;
  private requestId = 0;
  private readonly sessionId = randomUUID();
  private stderr = "";

  constructor(binary: string) {
    this.binary = binary;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (!this.ready) {
      const timeoutAbort = new AbortController();
      const timeoutError = new Error("Code-mode host did not start in time");
      this.ready = Promise.race([
        this.startProcess(),
        delay(STARTUP_TIMEOUT_MS, undefined, {
          ref: false,
          signal: timeoutAbort.signal,
        }).then(() => {
          this.failAll(timeoutError);
          throw timeoutError;
        }),
      ]).finally(() => {
        timeoutAbort.abort();
      });
    }

    const { ready } = this;

    try {
      await abortable(ready, signal);
    } catch (error) {
      if (signal?.aborted === true) {
        throw error;
      }

      this.failAll(error instanceof Error ? error : new Error(String(error)));

      if (this.ready === ready) {
        this.ready = undefined;
      }

      throw error;
    }
  }

  async execute(
    source: string,
    context: ToolExecutionContext,
    signal: AbortSignal | undefined,
    tools: NestedTool[],
  ): Promise<RuntimeResponse> {
    throwIfAborted(signal);
    await this.start(signal);
    throwIfAborted(signal);
    const delegates = this.delegateRuntime;
    const { code, maxOutputTokens } = parseExecSource(source);
    const id = ++this.requestId;
    const initial = Promise.withResolvers<HostResultValue>();
    this.initial.set(id, initial);
    void initial.promise.catch(() => null);

    const toolSet = new Map(
      tools.map((tool) => [
        nestedToolKey({
          name: tool.definition.name,
          ...(tool.namespace !== undefined ? { namespace: tool.namespace } : {}),
        }),
        tool,
      ]),
    );

    const started = this.requestWithId(
      id,
      {
        method: "session/execute",
        request: {
          enabled_tools: tools.map(toWireToolDefinition),
          max_output_tokens: maxOutputTokens,
          source: code,
          tool_call_id: `exec-${id}`,
          yield_time_ms: DEFAULT_CODE_MODE_EXEC_YIELD_MS,
        },
        sessionId: this.sessionId,
      },
      context,
      toolSet,
    );

    let cellId: string | undefined;
    let operationId = id;

    const abort = () => {
      if (this.delegateRuntime !== delegates) return;
      const error = abortError();

      if (cellId === undefined) {
        // Before the started reply there is no cell handle to terminate safely.
        this.failAll(error);

        return;
      }

      try {
        this.send({ id: operationId, type: "operation/cancel" });
      } catch {
        // Host teardown is already authoritative.
      }

      this.rejectOperation(operationId, error);
      this.rejectOperation(id, error);
    };

    signal?.addEventListener("abort", abort, { once: true });

    try {
      const startedValue = await started;
      cellId = executionCellId(startedValue);

      if (signal?.aborted === true) {
        abort();
        throw abortError();
      }

      const contentItems: RuntimeResponse["contentItems"] = [];
      let remaining = (maxOutputTokens ?? 10_000) * 4;
      let retainedBytes = 0;
      let response = runtimeResponseFromValue(await initial.promise);

      while (true) {
        throwIfAborted(signal);
        response = await delegates.finishResponse(response);

        for (const item of response.contentItems) {
          if (item.type === "input_text" && remaining === 0) continue;

          const retained =
            item.type === "input_text"
              ? {
                  ...item,
                  text:
                    (item.text ?? "").length > remaining
                      ? `${(item.text ?? "").slice(0, remaining)}\n[Output truncated]`
                      : (item.text ?? ""),
                }
              : item;

          if (retained.type === "input_text")
            remaining = Math.max(0, remaining - (retained.text?.length ?? 0));
          retainedBytes += Buffer.byteLength(retained.text ?? retained.image_url ?? "");

          if (retainedBytes > MAX_FRAME_BYTES)
            throw new Error("Code-mode aggregate output exceeds its memory budget");

          if (retained.type !== "input_text" || retained.text) contentItems.push(retained);
        }

        if (response.kind !== "yielded")
          return { ...response, contentItems, maxOutputTokens: maxOutputTokens ?? 10_000 };

        try {
          context.onUpdate?.({
            content: [],
            details: {
              cellId,
              status: "running",
              traces: response.traces,
              elapsedMs: response.elapsedMs,
            },
          });
        } catch {
          // Presentation callbacks do not own script execution.
        }

        operationId = ++this.requestId;

        const value = await this.requestWithId(operationId, {
          method: "session/wait",
          request: { cell_id: response.cellId, yield_time_ms: DEFAULT_CODE_MODE_EXEC_YIELD_MS },
          sessionId: this.sessionId,
        });

        const outcome = runtimeOutcome(value);

        if (outcome === undefined || outcome === null)
          throw new Error("Code-mode host returned an invalid wait outcome");
        response = parseRuntimeResponse(outcome);
      }
    } catch (error) {
      this.initial.delete(id);

      if (cellId !== undefined) {
        const termination =
          this.delegateRuntime !== delegates || this.child === undefined
            ? Promise.resolve(null)
            : Promise.race([
                this.request({ method: "session/terminate", cellId, sessionId: this.sessionId }),
                delay(DEFAULT_SHUTDOWN_GRACE_MS).then(() => {
                  throw new Error("Code-mode cell termination timed out");
                }),
              ]).catch(() => {
                // A broken host cannot retain a cell after this invocation ends.
                if (this.delegateRuntime === delegates)
                  this.failAll(new Error("Code-mode cell termination failed"));
              });

        await Promise.all([termination, delegates.disposeCell(cellId)]);
      }

      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
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
        delay(DEFAULT_SHUTDOWN_GRACE_MS),
      ]);
    } catch {
      // Process teardown below is authoritative.
    }

    this.failAll(new Error("Code-mode host shut down"));
  }

  private async startProcess(): Promise<void> {
    const child = spawn(this.binary, [], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child = child;
    this.delegateRuntime = new CodeModeDelegateRuntime((message) => {
      // Late settlement from a dead host cannot answer a reused delegate ID on its replacement.
      if (this.child === child) this.send(message);
    });
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
            }`,
          ),
        );
      }
    });
    const handshake = Promise.withResolvers<null>();
    this.pending.set(0, {
      reject: handshake.reject,
      resolve: () => {
        handshake.resolve(null);
      },
    });
    this.send({
      optionalCapabilities: [],
      requiredCapabilities: [],
      supportedVersions: [1],
      type: "connection/hello",
    });
    await handshake.promise;
    await this.request({ method: "session/open", sessionId: this.sessionId });
  }

  private request(
    request: HostRequest,
    context?: ToolExecutionContext,
  ): Promise<HostResultValue | null> {
    return this.requestWithId(++this.requestId, request, context);
  }

  private requestWithId(
    id: number,
    request: HostRequest,
    context?: ToolExecutionContext,
    tools?: Map<string, NestedTool>,
  ): Promise<HostResultValue | null> {
    const result = Promise.withResolvers<HostResultValue | null>();
    this.pending.set(id, {
      ...(context !== undefined ? { context } : {}),
      reject: result.reject,
      resolve: result.resolve,
      ...(tools !== undefined ? { tools } : {}),
    });

    try {
      this.send({ id, request, type: "operation/request" });
    } catch (error) {
      this.pending.delete(id);
      result.reject(error instanceof Error ? error : new Error(String(error)));
    }

    return result.promise;
  }

  private rejectOperation(id: number, error: Error): void {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    pending?.reject(error);
    const initial = this.initial.get(id);
    this.initial.delete(id);
    initial?.reject(error);
  }

  private send(
    message:
      | DelegateResponse
      | {
          optionalCapabilities: [];
          requiredCapabilities: [];
          supportedVersions: [1];
          type: "connection/hello";
        }
      | { id: number; request: HostRequest; type: "operation/request" }
      | { id: number; type: "operation/cancel" },
  ): void {
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
      throw new Error(`Code-mode write queue exceeds ${MAX_QUEUED_WRITE_BYTES} bytes`);
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
        this.failAll(new Error(`Code-mode frame exceeds ${MAX_FRAME_BYTES} bytes`));

        return;
      }

      if (this.buffer.length < length + 4) {
        return;
      }

      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);

      try {
        this.handleMessage(parseHostMessage(payload.toString("utf-8")));
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
      pending?.reject(new Error(`Code-mode handshake rejected: ${JSON.stringify(message.reason)}`));

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

      if (cellId !== undefined && cellId.length > 0 && pending.context !== undefined) {
        this.delegateRuntime.bindCell(cellId, pending.context, pending.tools ?? new Map());
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
    for (const pending of [...this.pending.values(), ...this.initial.values()]) {
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

const abortable = async <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  throwIfAborted(signal);

  if (!signal) {
    return await promise;
  }

  const aborted = Promise.withResolvers<T>();

  const onAbort = () => {
    aborted.reject(abortError());
  };

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    return await Promise.race([promise, aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};
