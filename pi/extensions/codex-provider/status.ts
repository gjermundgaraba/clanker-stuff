import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE,
  decideCheckpointCompatibility,
  resolveActiveCheckpointBoundary,
  resolveCheckpointCarrier,
} from "./checkpoint.js";
import type { Checkpoint, CheckpointIdentity } from "./checkpoint.js";
import { CODEX_TRANSPORT_FALLBACK_DIAGNOSTIC_TYPE } from "./provider.js";
import { estimateModelVisibleTokens } from "./replay.js";

export interface CodexProviderStatusOptions {
  readonly branch: readonly SessionEntry[];
  readonly entries: readonly SessionEntry[];
  readonly sessionId: string;
  readonly current?: {
    readonly autoCompactTokens?: number;
    readonly contextUsage?: {
      readonly contextWindow: number;
      readonly percent: number | null;
      readonly tokens: number | null;
    };
    readonly identity?: CheckpointIdentity;
    readonly model?: string;
    readonly reasoning?: string;
  };
}

interface ContextFrameDiagnostic {
  readonly baselineMessages: number;
  readonly eventMessages: number;
  readonly frameResult: "ambiguous" | "missing";
  readonly timestamp: string;
}

interface CheckpointRecord {
  readonly checkpoint: Checkpoint;
  readonly timestamp: string;
}

interface TransportFallbackDiagnostic {
  readonly configuredTransport: "auto" | "websocket" | "websocket-cached";
  readonly timestamp: number;
}

const phaseLabels: Record<Checkpoint["phase"], string> = {
  "mid-turn": "while working",
  "overflow-retry": "context-limit recovery",
  "pre-sampling": "before reply",
  standalone: "between turns",
};

const reasonLabels: Record<Checkpoint["reason"], string> = {
  manual: "manual",
  overflow: "automatic context limit",
  threshold: "automatic threshold",
};

const carrierLabels = {
  inline: "checkpoint entry",
  lifecycle: "Pi compaction",
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonnegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const checkpoints = (entries: readonly SessionEntry[]) => {
  const unique = new Map<string, CheckpointRecord>();
  let invalidCarriers = 0;
  for (const entry of entries) {
    const carrier = resolveCheckpointCarrier(entry);
    if (carrier.kind === "none" || carrier.kind === "pi-compaction") {
      continue;
    }
    if (carrier.kind === "invalid-checkpoint") {
      invalidCarriers += 1;
      continue;
    }
    const { checkpoint } = carrier;
    unique.set(`${checkpoint.response.id}\0${checkpoint.replacementSha256}`, {
      checkpoint,
      timestamp: entry.timestamp,
    });
  }
  return { invalidCarriers, values: [...unique.values()] };
};

const contextFrameDiagnostics = (
  entries: readonly SessionEntry[]
): ContextFrameDiagnostic[] => {
  const diagnostics: ContextFrameDiagnostic[] = [];
  for (const entry of entries) {
    if (
      entry.type !== "custom" ||
      entry.customType !== CHECKPOINT_DIAGNOSTIC_CUSTOM_TYPE ||
      !isRecord(entry.data) ||
      entry.data.kind !== "context-frame" ||
      entry.data.version !== 1 ||
      (entry.data.frameResult !== "ambiguous" &&
        entry.data.frameResult !== "missing") ||
      !isRecord(entry.data.baseline) ||
      !isRecord(entry.data.event) ||
      !isNonnegativeInteger(entry.data.baseline.messageCount) ||
      !isNonnegativeInteger(entry.data.event.messageCount)
    ) {
      continue;
    }
    diagnostics.push({
      baselineMessages: entry.data.baseline.messageCount,
      eventMessages: entry.data.event.messageCount,
      frameResult: entry.data.frameResult,
      timestamp: entry.timestamp,
    });
  }
  return diagnostics;
};

const transportFallbackDiagnostics = (
  entries: readonly SessionEntry[]
): TransportFallbackDiagnostic[] => {
  const diagnostics: TransportFallbackDiagnostic[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant") {
      continue;
    }
    for (const diagnostic of entry.message.diagnostics ?? []) {
      const configuredTransport = diagnostic.details?.configuredTransport;
      if (
        diagnostic.type === CODEX_TRANSPORT_FALLBACK_DIAGNOSTIC_TYPE &&
        (configuredTransport === "auto" ||
          configuredTransport === "websocket" ||
          configuredTransport === "websocket-cached") &&
        Number.isFinite(diagnostic.timestamp)
      ) {
        diagnostics.push({
          configuredTransport,
          timestamp: diagnostic.timestamp,
        });
      }
    }
  }
  return diagnostics;
};

const number = (value: number) => value.toLocaleString("en-US");

const timestamp = (value: number | string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toISOString();
};

const tally = (values: readonly string[]) =>
  [...new Set(values)]
    .map(
      (value) =>
        `${value} ${values.filter((candidate) => candidate === value).length}`
    )
    .join(", ");

const sizeChange = (before: number, after: number) => {
  if (before === after) {
    return "unchanged";
  }
  const direction = after < before ? "reduced" : "increased";
  const difference = Math.abs(before - after);
  return before === 0
    ? `${direction} by ~${number(difference)}`
    : `${direction} by ~${number(difference)} (${((difference / before) * 100).toLocaleString("en-US", { maximumFractionDigits: 1 })}%)`;
};

const latestCheckpointLine = (record: CheckpointRecord | undefined) => {
  if (!record) {
    return "  Latest (current branch): none";
  }
  const { checkpoint } = record;
  const replacementTokens = estimateModelVisibleTokens(
    "",
    checkpoint.replacement
  );
  return `  Latest (current branch): ~${number(checkpoint.sourceTokens)} → ~${number(replacementTokens)} estimated tokens · ${sizeChange(checkpoint.sourceTokens, replacementTokens)} · ${reasonLabels[checkpoint.reason]} · ${phaseLabels[checkpoint.phase]} · provider usage ${number(checkpoint.response.usage.totalTokens)}`;
};

const aggregateLine = (records: readonly CheckpointRecord[]) => {
  const values = records.map((record) => record.checkpoint);
  if (values.length === 0) {
    return "  Aggregate (session): no Codex compactions";
  }
  const total = (select: (checkpoint: Checkpoint) => number) =>
    values.reduce((sum, checkpoint) => sum + select(checkpoint), 0);
  return [
    `  Estimated volume (session): ~${number(total((value) => value.sourceTokens))} source → ~${number(total((value) => estimateModelVisibleTokens("", value.replacement)))} replacement tokens`,
    `  OpenAI usage (session): ${number(total((value) => value.response.usage.totalTokens))} total · ${number(total((value) => value.response.usage.input))} uncached input · ${number(total((value) => value.response.usage.cacheRead))} cache read · ${number(total((value) => value.response.usage.output))} output · ${number(total((value) => value.response.usage.cacheWrite))} cache write`,
    `  Triggers (session): ${tally(values.map((value) => reasonLabels[value.reason]))} · Timing: ${tally(values.map((value) => phaseLabels[value.phase]))}`,
  ].join("\n");
};

const recentLine = (records: readonly CheckpointRecord[]) => {
  const recent = records
    .slice(-3)
    .map(
      ({ checkpoint, timestamp: value }) =>
        `${timestamp(value)} ${reasonLabels[checkpoint.reason]} / ${phaseLabels[checkpoint.phase]}`
    );
  return `  Recent (current branch, max 3): ${recent.join("; ") || "none"}`;
};

const activeCheckpointText = (
  active: ReturnType<typeof resolveActiveCheckpointBoundary>,
  identity: CheckpointIdentity | undefined
) => {
  if (active.kind === "invalid-checkpoint") {
    return `invalid · ${carrierLabels[active.carrier]}`;
  }
  if (active.kind === "pi-compaction") {
    return "none (Pi compaction active)";
  }
  if (active.kind === "none") {
    return "none";
  }
  if (!identity) {
    return `valid · compatibility unavailable · provider window ${active.checkpoint.runtime.windowNumber} · ${carrierLabels[active.carrier]}`;
  }
  const compatibility = decideCheckpointCompatibility(
    active.checkpoint,
    identity
  );
  const compatibilityText = compatibility.compatible
    ? "compatible"
    : `incompatible (${compatibility.field})`;
  return `valid · ${compatibilityText} · provider window ${active.checkpoint.runtime.windowNumber} · ${carrierLabels[active.carrier]}`;
};

export const formatCodexProviderStatus = (
  options: CodexProviderStatusOptions
): string => {
  const branchCheckpoints = checkpoints(options.branch);
  const sessionCheckpoints = checkpoints(options.entries);
  const branchFrames = contextFrameDiagnostics(options.branch);
  const sessionFrames = contextFrameDiagnostics(options.entries);
  const branchFallbacks = transportFallbackDiagnostics(options.branch);
  const sessionFallbacks = transportFallbackDiagnostics(options.entries);
  const active = resolveActiveCheckpointBoundary(options.branch);
  const model = options.current?.model;
  const reasoning = options.current?.reasoning;
  const currentParts: string[] = [];
  if (model !== undefined) {
    currentParts.push(model);
  }
  if (reasoning !== undefined) {
    currentParts.push(`reasoning ${reasoning}`);
  }
  const context = options.current?.contextUsage;
  const contextParts: string[] = [];
  if (context !== undefined) {
    contextParts.push(
      `${context.tokens === null ? "unknown" : number(context.tokens)} / ${number(context.contextWindow)} tokens${context.percent === null ? "" : ` (${context.percent.toFixed(1)}%)`}`
    );
  }
  if (options.current?.autoCompactTokens !== undefined) {
    contextParts.push(
      `compaction threshold ${number(options.current.autoCompactTokens)}`
    );
  }

  const latestFrame = branchFrames.at(-1) ?? sessionFrames.at(-1);
  const latestFallback = branchFallbacks.at(-1) ?? sessionFallbacks.at(-1);
  const latestFrameScope =
    branchFrames.length > 0 ? "current branch" : "session";
  const latestFallbackScope =
    branchFallbacks.length > 0 ? "current branch" : "session";
  return [
    "Codex provider status",
    `Session: ${options.sessionId}`,
    "Current",
    `  Model: ${currentParts.length === 0 ? "unavailable" : currentParts.join(" · ")}`,
    `  Context: ${contextParts.length === 0 ? "unavailable" : contextParts.join(" · ")}`,
    `  Checkpoint: ${activeCheckpointText(active, options.current?.identity)}`,
    "Compactions",
    `  Count: ${branchCheckpoints.values.length} current branch · ${sessionCheckpoints.values.length} session`,
    latestCheckpointLine(branchCheckpoints.values.at(-1)),
    recentLine(branchCheckpoints.values),
    aggregateLine(sessionCheckpoints.values),
    "Reliability",
    `  Invalid checkpoint entries: ${branchCheckpoints.invalidCarriers} current branch · ${sessionCheckpoints.invalidCarriers} session`,
    `  Replay blocks: ${branchFrames.length} current branch · ${sessionFrames.length} session${latestFrame ? ` · latest on ${latestFrameScope}: ${latestFrame.frameResult} at ${timestamp(latestFrame.timestamp)} (${latestFrame.baselineMessages} baseline / ${latestFrame.eventMessages} event messages)` : ""}`,
    `  Transport fallbacks: ${branchFallbacks.length} current branch · ${sessionFallbacks.length} session${latestFallback ? ` · latest on ${latestFallbackScope}: ${latestFallback.configuredTransport} at ${timestamp(latestFallback.timestamp)}` : ""}`,
  ].join("\n");
};
