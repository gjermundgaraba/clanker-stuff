import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import {
  decideCheckpointCompatibility,
  resolveActiveCheckpointBoundary,
  resolveCheckpointCarrier,
} from "./checkpoint.js";
import type { Checkpoint, CheckpointIdentity } from "./checkpoint.js";
import type { CodexObservation } from "./observability.js";
import { estimateModelVisibleTokens } from "./replay.js";

export interface CodexProviderStatusOptions {
  readonly branch: readonly SessionEntry[];
  readonly entries: readonly SessionEntry[];
  readonly observations: readonly CodexObservation[];
  readonly observabilityError?: string;
  readonly observabilityPath: string;
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

interface CheckpointRecord {
  readonly checkpoint: Checkpoint;
  readonly timestamp: string;
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

const optionalString = (value: unknown) =>
  typeof value === "string" ? value : undefined;

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

const observedContextFrameDiagnostics = (
  observations: readonly CodexObservation[]
) =>
  observations.flatMap((observation) => {
    const { data } = observation;
    if (
      observation.kind !== "context-frame-failure" ||
      !isRecord(data) ||
      (data.frameResult !== "ambiguous" && data.frameResult !== "missing") ||
      !isRecord(data.baseline) ||
      !isRecord(data.event) ||
      !isNonnegativeInteger(data.baseline.messageCount) ||
      !isNonnegativeInteger(data.event.messageCount)
    ) {
      return [];
    }
    return [
      {
        baselineMessages: data.baseline.messageCount,
        eventMessages: data.event.messageCount,
        frameResult: data.frameResult,
        timestamp: observation.timestamp,
      },
    ];
  });

const observedTransportFallbackDiagnostics = (
  observations: readonly CodexObservation[]
) =>
  observations.flatMap((observation) => {
    const { data } = observation;
    if (
      (observation.kind !== "compaction" && observation.kind !== "request") ||
      !isRecord(data) ||
      !isRecord(data.transport) ||
      data.transport.fellBackToSse !== true ||
      (data.transport.configured !== "auto" &&
        data.transport.configured !== "websocket" &&
        data.transport.configured !== "websocket-cached")
    ) {
      return [];
    }
    return [
      {
        configuredTransport: data.transport.configured,
        timestamp: observation.timestamp,
      },
    ];
  });

const requestObservations = (observations: readonly CodexObservation[]) =>
  observations.flatMap((observation) => {
    const { data } = observation;
    if (
      observation.kind !== "request" ||
      !isRecord(data) ||
      !isRecord(data.request) ||
      !isRecord(data.response) ||
      (data.outcome !== "length" &&
        data.outcome !== "stop" &&
        data.outcome !== "toolUse") ||
      typeof data.request.cacheEnabled !== "boolean" ||
      !isNonnegativeInteger(data.response.cacheReadTokens) ||
      !isNonnegativeInteger(data.response.cacheWriteTokens) ||
      !isNonnegativeInteger(data.response.inputTokens)
    ) {
      return [];
    }
    const hashes = data.request.inputItemHashes;
    return [
      {
        cacheEnabled: data.request.cacheEnabled,
        cacheKeyHash: optionalString(data.request.cacheKeyHash),
        cacheReadTokens: data.response.cacheReadTokens,
        cacheWriteTokens: data.response.cacheWriteTokens,
        inputItemHashes:
          Array.isArray(hashes) &&
          hashes.every((value) => typeof value === "string")
            ? hashes
            : undefined,
        inputTokens: data.response.inputTokens,
        instructionsHash: optionalString(data.request.instructionsHash),
        model: optionalString(data.model),
        stableRequestHash: optionalString(data.request.stableRequestHash),
        timestamp: observation.timestamp,
        toolsHash: optionalString(data.request.toolsHash),
      },
    ];
  });

const number = (value: number) => value.toLocaleString("en-US");

const timestamp = (value: number | string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toISOString();
};

const elapsed = (milliseconds: number) => {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  return `${Math.round(minutes / 60)}h`;
};

const commonPrefixLength = (
  left: readonly string[],
  right: readonly string[]
) => {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[index] === right[index]
  ) {
    index += 1;
  }
  return index;
};

const changed = (left: string | undefined, right: string | undefined) =>
  left !== undefined && right !== undefined && left !== right;

const cacheObservationLines = (
  observations: readonly CodexObservation[]
): string[] => {
  const requests = requestObservations(observations);
  const latest = requests.at(0);
  const previous = requests.at(1);
  if (latest === undefined) {
    return ["  Latest: no successful requests recorded"];
  }
  const latestResult = latest.cacheReadTokens > 0 ? "hit" : "miss";
  const key = latest.cacheKeyHash?.slice(0, 12) ?? "none";
  const lines = [
    `  Latest: ${latestResult} at ${timestamp(latest.timestamp)} · ${number(latest.inputTokens)} uncached input · ${number(latest.cacheReadTokens)} cache read · ${number(latest.cacheWriteTokens)} cache write · key ${key}`,
  ];
  if (previous === undefined) {
    lines.push(
      "  Previous: none recorded",
      latest.cacheEnabled
        ? "  Assessment: no earlier request is available for comparison"
        : "  Assessment: prompt caching was disabled for this request"
    );
    return lines;
  }

  const previousResult = previous.cacheReadTokens > 0 ? "hit" : "miss";
  lines.push(
    `  Previous: ${previousResult} ${elapsed(latest.timestamp - previous.timestamp)} earlier · ${number(previous.cacheReadTokens)} cache read`
  );
  const changes: string[] = [];
  if (latest.model !== previous.model) {
    changes.push("model changed");
  }
  if (changed(latest.cacheKeyHash, previous.cacheKeyHash)) {
    changes.push("cache key changed");
  }
  if (changed(latest.instructionsHash, previous.instructionsHash)) {
    changes.push("instructions changed");
  }
  if (changed(latest.toolsHash, previous.toolsHash)) {
    changes.push("tools changed");
  }
  if (
    changed(latest.stableRequestHash, previous.stableRequestHash) &&
    changes.length === 0
  ) {
    changes.push("request settings changed");
  }

  const latestHashes = latest.inputItemHashes;
  const previousHashes = previous.inputItemHashes;
  if (latestHashes && previousHashes) {
    const prefix = commonPrefixLength(previousHashes, latestHashes);
    lines.push(
      `  Input prefix: ${number(prefix)} matching items · ${number(previousHashes.length)} previous · ${number(latestHashes.length)} latest`
    );
    if (prefix < Math.min(previousHashes.length, latestHashes.length)) {
      changes.push(`input changed at item ${number(prefix + 1)}`);
    }
  } else {
    changes.push("request hashes unavailable");
  }

  if (!latest.cacheEnabled) {
    lines.push("  Assessment: prompt caching was disabled for this request");
  } else if (latestResult === "hit") {
    lines.push("  Assessment: cache hit; comparison is informational");
  } else if (changes.length > 0) {
    lines.push(`  Assessment: ${changes.join("; ")}`);
  } else {
    lines.push(
      "  Assessment: no client-visible cause; key, request settings, and prior input prefix match, so the cache was cold or missed server-side"
    );
  }
  return lines;
};

const compactionFailures = (observations: readonly CodexObservation[]) =>
  observations.filter(
    (observation) =>
      observation.kind === "compaction" &&
      isRecord(observation.data) &&
      observation.data.outcome !== "success"
  );

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
  const { observations } = options;
  const observedFrames = observedContextFrameDiagnostics(observations);
  const observedFallbacks = observedTransportFallbackDiagnostics(observations);
  const observedCompactionFailures = compactionFailures(observations);
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

  const latestFrame = observedFrames.at(0);
  const latestFallback = observedFallbacks.at(0);
  const observationCounts = {
    compactions: observations.filter(
      (observation) => observation.kind === "compaction"
    ).length,
    frames: observedFrames.length,
    requests: observations.filter(
      (observation) => observation.kind === "request"
    ).length,
  };
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
    "Cache",
    ...cacheObservationLines(observations),
    "Reliability",
    `  Invalid checkpoint entries: ${branchCheckpoints.invalidCarriers} current branch · ${sessionCheckpoints.invalidCarriers} session`,
    `  Replay blocks: ${observedFrames.length} session${latestFrame === undefined ? "" : ` · latest in session: ${latestFrame.frameResult} at ${timestamp(latestFrame.timestamp)} (${latestFrame.baselineMessages} baseline / ${latestFrame.eventMessages} event messages)`}`,
    `  Transport fallbacks: ${observedFallbacks.length} session${latestFallback === undefined ? "" : ` · latest in session: ${latestFallback.configuredTransport} at ${timestamp(latestFallback.timestamp)}`}`,
    `  Failed compaction requests: ${observedCompactionFailures.length} session`,
    "Observability",
    `  Database: ${options.observabilityPath}`,
    `  Rows (session, 30 days): ${observationCounts.requests} requests · ${observationCounts.compactions} compactions · ${observationCounts.frames} replay blocks`,
    ...(options.observabilityError === undefined ||
    options.observabilityError.length === 0
      ? []
      : [`  Last database error: ${options.observabilityError}`]),
  ].join("\n");
};
