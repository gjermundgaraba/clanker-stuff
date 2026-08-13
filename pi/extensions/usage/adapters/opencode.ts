import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import type {
  UsageFetchResult,
  UsageWindow,
  UsageWindowId,
} from "../providers.js";
import { usageFailure, usageResult } from "../providers.js";
import { isDefined, makeUsageWindow, parseIso } from "./util.js";

const CODEXBAR_HISTORY_PATH = path.join(
  homedir(),
  "Library",
  "Application Support",
  "com.steipete.codexbar",
  "history",
  "opencodego.json"
);

const CODEXBAR_MISSING_MESSAGE =
  "CodexBar history not found (open CodexBar so it can fetch usage from the web)";

const STALE_AFTER_MS = 2 * 60 * 60_000;

const HISTORY_WINDOW_MAP: {
  id: UsageWindowId;
  name: "session" | "weekly" | "monthly";
}[] = [
  { id: "5h", name: "session" },
  { id: "7d", name: "weekly" },
  { id: "month", name: "monthly" },
];

const HistoryEntrySchema = Type.Object({
  capturedAt: Type.String(),
  resetsAt: Type.Optional(Type.String()),
  usedPercent: Type.Number(),
});

const HistoryWindowSchema = Type.Object({
  entries: Type.Array(HistoryEntrySchema),
  name: Type.String(),
});

const CodexBarHistorySchema = Type.Object({
  accounts: Type.Optional(
    Type.Record(Type.String(), Type.Array(HistoryWindowSchema))
  ),
  preferredAccountKey: Type.Optional(Type.String()),
  unscoped: Type.Optional(Type.Array(HistoryWindowSchema)),
});

type HistoryWindow = Static<typeof HistoryWindowSchema>;

const mapHistoryWindow = (
  window: HistoryWindow | undefined,
  id: UsageWindowId
): UsageWindow | undefined => {
  const latest = window?.entries.at(-1);
  if (latest === undefined || Number.isNaN(Date.parse(latest.capturedAt))) {
    return undefined;
  }
  return makeUsageWindow(
    id,
    100 - latest.usedPercent,
    parseIso(latest.resetsAt)
  );
};

const latestCapturedAt = (windows: HistoryWindow[]): number | undefined => {
  let latest: number | undefined;
  for (const window of windows) {
    const entry = window.entries.at(-1);
    if (entry === undefined) {
      continue;
    }
    const ms = Date.parse(entry.capturedAt);
    if (!Number.isNaN(ms) && (latest === undefined || ms > latest)) {
      latest = ms;
    }
  }
  return latest;
};

const resolveWindows = (
  data: Static<typeof CodexBarHistorySchema>
): HistoryWindow[] => {
  if (data.unscoped && data.unscoped.length > 0) {
    return data.unscoped;
  }
  const { accounts, preferredAccountKey: key } = data;
  if (accounts === undefined) {
    return [];
  }
  if (key !== undefined && accounts[key] !== undefined) {
    return accounts[key];
  }
  for (const windows of Object.values(accounts)) {
    if (windows.length > 0) {
      return windows;
    }
  }
  return [];
};

export const parseCodexBarHistory = (
  data: unknown,
  nowMs: number = Date.now()
): UsageFetchResult => {
  if (!Value.Check(CodexBarHistorySchema, data)) {
    return usageFailure("invalid CodexBar history");
  }

  const windows = resolveWindows(data);
  if (windows.length === 0) {
    return usageFailure(CODEXBAR_MISSING_MESSAGE, "unavailable");
  }

  const byName = new Map<string, HistoryWindow>();
  for (const window of windows) {
    byName.set(window.name, window);
  }

  const renderedWindows = HISTORY_WINDOW_MAP.map(({ name, id }) => ({
    history: byName.get(name),
    id,
  }));
  const mapped = renderedWindows
    .map(({ history, id }) => mapHistoryWindow(history, id))
    .filter(isDefined);

  if (mapped.length === 0) {
    return usageFailure(CODEXBAR_MISSING_MESSAGE, "unavailable");
  }

  const captured = latestCapturedAt(
    renderedWindows.flatMap(({ history }) => (history ? [history] : []))
  );
  if (captured !== undefined && nowMs - captured > STALE_AFTER_MS) {
    return usageFailure(CODEXBAR_MISSING_MESSAGE, "unavailable");
  }

  return usageResult({
    fetchedAt: nowMs,
    provider: "opencode-go",
    windows: mapped,
  });
};

export interface RunCodexBarUsageOptions {
  filePath?: string;
  now?: () => number;
}

export const runCodexBarUsage = async (
  options: RunCodexBarUsageOptions = {}
): Promise<UsageFetchResult> => {
  const now = options.now ?? Date.now;
  const filePath = options.filePath ?? CODEXBAR_HISTORY_PATH;

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return usageFailure(CODEXBAR_MISSING_MESSAGE, "unavailable");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return usageFailure("invalid CodexBar history");
  }

  return parseCodexBarHistory(parsed, now());
};
