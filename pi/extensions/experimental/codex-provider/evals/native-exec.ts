import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

export interface Metrics {
  assistantTurns: number;
  estimatedCostUsd: number | null;
  elapsedMs: number;
  firstResponseMs: number | null;
  stopReasons: string[];
  toolCalls: number;
  toolNames: Record<string, number>;
  usage: {
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    reasoning: number;
    totalTokens: number;
  };
}

const NativeExecEventSchema = Type.Object({
  item: Type.Optional(
    Type.Object({
      id: Type.Optional(Type.String()),
      text: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
    }),
  ),
  message: Type.Optional(Type.String()),
  type: Type.Optional(Type.String()),
  usage: Type.Optional(
    Type.Object({
      cache_write_input_tokens: Type.Optional(Type.Number()),
      cached_input_tokens: Type.Optional(Type.Number()),
      input_tokens: Type.Optional(Type.Number()),
      output_tokens: Type.Optional(Type.Number()),
      reasoning_output_tokens: Type.Optional(Type.Number()),
    }),
  ),
});
export type NativeExecEvent = Static<typeof NativeExecEventSchema>;

export const emptyMetrics = (): Metrics => ({
  assistantTurns: 0,
  estimatedCostUsd: null,
  elapsedMs: 0,
  firstResponseMs: null,
  stopReasons: [],
  toolCalls: 0,
  toolNames: {},
  usage: {
    cacheRead: 0,
    cacheWrite: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    totalTokens: 0,
  },
});

const parseNativeEvent = (line: string): NativeExecEvent | undefined => {
  try {
    const value = JSON.parse(line);
    return Value.Check(NativeExecEventSchema, value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const nativeMetrics = (
  events: NativeExecEvent[],
  elapsedMs: number,
  firstResponseMs: number | null,
): Metrics => {
  const metrics = emptyMetrics();
  metrics.elapsedMs = elapsedMs;
  metrics.firstResponseMs = firstResponseMs;
  const completion = events.findLast((event) => event.type === "turn.completed");
  const usage = completion?.usage;
  const inputTokens = usage?.input_tokens ?? 0;
  const cacheRead = usage?.cached_input_tokens ?? 0;
  const cacheWrite = usage?.cache_write_input_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const input = Math.max(0, inputTokens - cacheRead - cacheWrite);
  metrics.usage = {
    cacheRead,
    cacheWrite,
    input,
    output,
    reasoning: usage?.reasoning_output_tokens ?? 0,
    totalTokens: inputTokens + output,
  };
  const toolTypes = new Set([
    "collab_tool_call",
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
  ]);
  const completedIds = new Set<string>();
  for (const event of events) {
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      metrics.assistantTurns += 1;
    }
    const itemType = event.item?.type;
    const itemId = event.item?.id;
    if (
      event.type !== "item.completed" ||
      itemType === undefined ||
      itemId === undefined ||
      !toolTypes.has(itemType) ||
      completedIds.has(itemId)
    ) {
      continue;
    }
    completedIds.add(itemId);
    metrics.toolCalls += 1;
    metrics.toolNames[itemType] = (metrics.toolNames[itemType] ?? 0) + 1;
  }
  let stopReason = "unknown";
  if (completion) {
    stopReason = "stop";
  } else if (events.some((event) => event.type === "turn.failed")) {
    stopReason = "error";
  }
  metrics.stopReasons.push(stopReason);
  return metrics;
};

/** Decode UTF-8 across chunks while retaining the native LF-only JSONL framing. */
export const captureNativeOutput = (
  child: Pick<ChildProcessWithoutNullStreams, "stdout" | "stderr">,
  onEvent: (event: NativeExecEvent) => void,
) => {
  let stdout = "";
  let stderr = "";
  let pendingLine = "";
  const consumeLines = (chunk: string, flush = false) => {
    pendingLine += chunk;
    const lines = pendingLine.split("\n");
    pendingLine = flush ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      const event = parseNativeEvent(line);
      if (event) {
        onEvent(event);
      }
    }
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    consumeLines(chunk);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    flush: () => consumeLines("", true),
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
};
