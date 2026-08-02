import { parseCompactionItem } from "./checkpoint.js";
import type { CanonicalCompactionItem } from "./checkpoint.js";

interface SseEvent {
  readonly [key: string]: unknown;
  readonly type?: string;
}

export interface CompactionSseResult {
  readonly compaction: CanonicalCompactionItem;
  readonly responseId: string;
}

export type CompactionSseFailureCode =
  | "http"
  | "invalid-output"
  | "premature"
  | "terminal-error";

export type CompactionSseFailure = Error & {
  readonly compactionSseCode: CompactionSseFailureCode;
  readonly status?: number;
};

const TERMINAL_TYPES = new Set([
  "error",
  "response.completed",
  "response.done",
  "response.error",
  "response.failed",
  "response.incomplete",
]);
const SUCCESS_TYPES = new Set(["response.completed", "response.done"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const abortError = (signal: AbortSignal) =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");

const assertNotAborted = (signal?: AbortSignal) => {
  if (signal?.aborted === true) {
    throw abortError(signal);
  }
};

const compactionSseFailure = (
  compactionSseCode: CompactionSseFailureCode,
  message: string,
  status?: number
): CompactionSseFailure =>
  Object.assign(new Error(message), {
    compactionSseCode,
    ...(status === undefined ? {} : { status }),
  });

export const isCompactionSseFailure = (
  value: unknown
): value is CompactionSseFailure =>
  value instanceof Error &&
  "compactionSseCode" in value &&
  typeof value.compactionSseCode === "string";

const parseData = (dataLines: readonly string[]): SseEvent | undefined => {
  const data = dataLines.join("\n");
  if (data.length === 0 || data === "[DONE]") {
    return undefined;
  }
  const parsed: unknown = JSON.parse(data);
  if (!isRecord(parsed)) {
    throw new Error("SSE data was not a JSON object");
  }
  return parsed;
};

const readCompactionSse = async (
  response: Response,
  signal?: AbortSignal
): Promise<{
  readonly compactionItems: readonly unknown[];
  readonly terminal: SseEvent | undefined;
}> => {
  if (response.body === null) {
    throw new Error("SSE response has no body");
  }
  assertNotAborted(signal);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const compactionItems: unknown[] = [];
  const dataLines: string[] = [];
  let buffer = "";
  let terminal: SseEvent | undefined;

  const cancelReader = async () => {
    try {
      await reader.cancel(signal?.reason);
    } catch {
      // The provider's branch may already have cancelled the shared source.
    }
  };
  const onAbort = () => void cancelReader();
  signal?.addEventListener("abort", onAbort, { once: true });

  const dispatch = () => {
    const event = parseData(dataLines);
    dataLines.length = 0;
    if (event === undefined) {
      return;
    }
    if (
      event.type === "response.output_item.done" &&
      isRecord(event.item) &&
      (event.item.type === "compaction" ||
        event.item.type === "compaction_summary")
    ) {
      compactionItems.push(event.item);
    }
    if (event.type !== undefined && TERMINAL_TYPES.has(event.type)) {
      terminal = event;
    }
  };

  const processLine = (line: string) => {
    if (line.length === 0) {
      dispatch();
      return;
    }
    if (line === "data") {
      dataLines.push("");
      return;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  };

  const drainLines = (atEnd: boolean) => {
    while (buffer.length > 0) {
      const lf = buffer.indexOf("\n");
      const cr = buffer.indexOf("\r");
      let index: number;
      if (lf === -1) {
        index = cr;
      } else if (cr === -1) {
        index = lf;
      } else {
        index = Math.min(lf, cr);
      }
      if (index === -1) {
        if (atEnd) {
          processLine(buffer);
          buffer = "";
        }
        return;
      }
      if (buffer[index] === "\r" && index === buffer.length - 1 && !atEnd) {
        return;
      }
      const line = buffer.slice(0, index);
      const separatorLength =
        buffer[index] === "\r" && buffer[index + 1] === "\n" ? 2 : 1;
      buffer = buffer.slice(index + separatorLength);
      processLine(line);
      if (terminal) {
        return;
      }
    }
  };

  try {
    while (true) {
      assertNotAborted(signal);
      // oxlint-disable-next-line no-await-in-loop -- stream reads are sequential
      const readResult: unknown = await reader.read();
      if (
        !isRecord(readResult) ||
        typeof readResult.done !== "boolean" ||
        (readResult.value !== undefined &&
          !(readResult.value instanceof Uint8Array))
      ) {
        throw new Error("SSE reader returned an invalid chunk");
      }
      const { done, value } = readResult;
      assertNotAborted(signal);
      if (done) {
        buffer += decoder.decode();
        drainLines(true);
        if (dataLines.length > 0) {
          dispatch();
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      drainLines(false);
      if (terminal !== undefined) {
        break;
      }
    }
    return { compactionItems, terminal };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await cancelReader();
    reader.releaseLock();
  }
};

export const collectCompactionSse = async (
  response: Response,
  signal?: AbortSignal
): Promise<CompactionSseResult> => {
  if (!response.ok) {
    throw compactionSseFailure(
      "http",
      `Compaction response failed with HTTP ${response.status}`,
      response.status
    );
  }
  let observation: Awaited<ReturnType<typeof readCompactionSse>>;
  try {
    observation = await readCompactionSse(response, signal);
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    throw compactionSseFailure(
      error instanceof SyntaxError ? "invalid-output" : "premature",
      error instanceof SyntaxError
        ? "Compaction SSE contained invalid JSON"
        : "Compaction SSE could not be read"
    );
  }
  const { terminal } = observation;
  if (terminal?.type === undefined || terminal.type.length === 0) {
    throw compactionSseFailure(
      "premature",
      "Compaction SSE closed before a terminal event"
    );
  }
  if (!SUCCESS_TYPES.has(terminal.type)) {
    throw compactionSseFailure(
      "terminal-error",
      `Compaction SSE ended with ${terminal.type}`
    );
  }
  const completedResponse = isRecord(terminal.response)
    ? terminal.response
    : undefined;
  if (
    completedResponse === undefined ||
    completedResponse.status !== "completed" ||
    typeof completedResponse.id !== "string" ||
    completedResponse.id.length === 0 ||
    completedResponse.id !== completedResponse.id.trim()
  ) {
    throw compactionSseFailure(
      "invalid-output",
      "Compaction terminal event is not a completed response"
    );
  }

  let compactions: CanonicalCompactionItem[];
  try {
    compactions = observation.compactionItems.map((item) =>
      parseCompactionItem(item, { allowAlias: true })
    );
  } catch {
    throw compactionSseFailure(
      "invalid-output",
      "Compaction SSE contained an invalid compaction item"
    );
  }
  const compaction = compactions.length === 1 ? compactions[0] : undefined;
  if (compaction === undefined) {
    throw compactionSseFailure(
      "invalid-output",
      `Compaction SSE expected exactly one compaction item, got ${compactions.length}`
    );
  }
  return {
    compaction,
    responseId: completedResponse.id,
  };
};
