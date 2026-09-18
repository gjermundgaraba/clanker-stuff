import { boundRuntimeToolResult, sanitizeTraceInput } from "./trace-values.js";
// Adapted from @howaboua/pi-codex-conversion 3.0.4 (MIT).
import type { RuntimeResponse, RuntimeToolResult, RuntimeToolTrace } from "./types.js";

const MAX_TRACE_COUNT = 50;

const MAX_TRACE_INPUT_CHARS = 16_384;

const MAX_TRACE_IMAGE_CHARS = 16 * 1024 * 1024;

interface CellTraces {
  traces: RuntimeToolTrace[];
  droppedCount: number;
  startedAt: number;
  elapsedMs?: number;
}

export class CodeModeTraceStore {
  private readonly cells = new Map<string, CellTraces>();

  startCell(cellId: string): void {
    this.cells.set(cellId, { traces: [], droppedCount: 0, startedAt: performance.now() });
  }

  finishCell(cellId: string): void {
    const cell = this.cells.get(cellId);

    if (cell) cell.elapsedMs ??= Math.max(0, performance.now() - cell.startedAt);
  }

  clear(): void {
    this.cells.clear();
  }

  delete(cellId: string): void {
    this.cells.delete(cellId);
  }

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Trace capture accepts arbitrary delegated arguments; sanitizeTraceInput bounds and normalizes them before storage.
  start(cellId: string, id: string, name: string, input: unknown): RuntimeToolTrace {
    const cell = this.cells.get(cellId);

    if (!cell) throw new Error(`Code-mode cell trace is unavailable: ${cellId}`);
    const { traces } = cell;

    if (traces.length >= MAX_TRACE_COUNT) {
      traces.shift();
      cell.droppedCount++;
    }

    const trace: RuntimeToolTrace = {
      id,
      input: sanitizeTraceInput(input, MAX_TRACE_INPUT_CHARS),
      name,
      status: "running",
    };

    traces.push(trace);

    return trace;
  }

  captureResult(
    cellId: string,
    current: RuntimeToolTrace,
    result: RuntimeToolResult,
  ): RuntimeToolResult {
    const usedImageChars = (this.cells.get(cellId)?.traces ?? [])
      .filter((trace) => trace !== current)
      .flatMap((trace) => trace.result?.content ?? [])
      .reduce(
        (total, item) => total + (item.type === "image" && item.data ? item.data.length : 0),
        0,
      );

    return boundRuntimeToolResult(result, Math.max(0, MAX_TRACE_IMAGE_CHARS - usedImageChars));
  }

  snapshot(cellId: string) {
    const cell = this.cells.get(cellId);

    return {
      cellId,
      elapsedMs:
        cell === undefined
          ? undefined
          : (cell.elapsedMs ?? Math.max(0, performance.now() - cell.startedAt)),
      // Stored traces are already normalized JSON; snapshots must not alias them.
      traces: structuredClone(cell?.traces ?? []),
      droppedTraceCount: cell?.droppedCount || undefined,
    };
  }

  attach(response: RuntimeResponse): RuntimeResponse {
    const { elapsedMs, traces, droppedTraceCount } = this.snapshot(response.cellId);

    if (response.kind !== "yielded") {
      this.delete(response.cellId);
    }

    const enriched = { ...response, ...(elapsedMs !== undefined ? { elapsedMs } : {}) };

    if (traces.length > 0) {
      enriched.traces = traces;
    }

    if (droppedTraceCount !== undefined) {
      enriched.droppedTraceCount = droppedTraceCount;
    }

    return enriched;
  }
}
