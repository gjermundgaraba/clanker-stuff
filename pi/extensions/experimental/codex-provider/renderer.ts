import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { CHECKPOINT_CUSTOM_TYPE, parseCheckpoint } from "./checkpoint.js";
import type { Checkpoint, CheckpointInput } from "./checkpoint.js";
import { estimateModelVisibleTokens } from "./replay.js";

const phaseLabels = {
  "mid-turn": "While the agent was working",
  "overflow-retry": "While recovering from the context limit",
  "pre-sampling": "Before the model replied",
  standalone: "Between turns",
} satisfies Record<Checkpoint["phase"], string>;

const reasonLabels = {
  manual: "Manual — requested by you",
  overflow: "Automatic — context limit exceeded",
  threshold: "Automatic — context threshold reached",
} satisfies Record<Checkpoint["reason"], string>;

const formatNumber = (value: number) => value.toLocaleString("en-US");

const formatSizeChange = (before: number, after: number) => {
  if (before === after) {
    return "unchanged";
  }
  if (before === 0) {
    return "larger";
  }
  const percent = Math.abs(1 - after / before) * 100;
  const absolute = formatNumber(Math.abs(before - after));
  return `~${absolute} ${after < before ? "fewer" : "more"} (${percent.toLocaleString("en-US", { maximumFractionDigits: 1 })}% ${after < before ? "smaller" : "larger"})`;
};

export const formatCheckpointEntry = (
  data: CheckpointInput,
  expanded = false,
): string | undefined => {
  const parsed = parseCheckpoint(data);
  if (!parsed.ok) {
    return undefined;
  }
  const { checkpoint } = parsed;
  const replacementTokens = estimateModelVisibleTokens("", checkpoint.replacement);
  const { usage } = checkpoint.response;
  const lines = [
    `✓ Context compacted successfully · Model: ${checkpoint.identity.model}`,
    `Estimated context size: ~${formatNumber(checkpoint.sourceTokens)} → ~${formatNumber(replacementTokens)} tokens · ${formatSizeChange(checkpoint.sourceTokens, replacementTokens)}`,
    `Trigger: ${reasonLabels[checkpoint.reason]} · Timing: ${phaseLabels[checkpoint.phase]}`,
    `OpenAI compaction usage: ${formatNumber(usage.totalTokens)} tokens total`,
    `Usage breakdown: ${formatNumber(usage.input)} uncached input · ${formatNumber(usage.cacheRead)} cached input · ${formatNumber(usage.output)} output · ${formatNumber(usage.cacheWrite)} cache write`,
    `Checkpoint: saved and validated · Provider window: ${formatNumber(checkpoint.runtime.windowNumber)}`,
  ];
  if (expanded) {
    const retainedUsers = checkpoint.replacement.filter((item) => item.type === "message").length;
    const retainedAgents = checkpoint.replacement.filter(
      (item) => item.type === "agent_message",
    ).length;
    lines.push(
      "Checkpoint details:",
      `Response ID: ${checkpoint.response.id}`,
      `Window IDs: ${checkpoint.runtime.previousWindowId ?? "none"} → ${checkpoint.runtime.currentWindowId}`,
      `Replacement SHA-256: ${checkpoint.replacementSha256}`,
      `Compaction hash: ${checkpoint.runtime.compHash ?? "none"}`,
      `Schema: ${checkpoint.schema} v${checkpoint.version} · ${checkpoint.protocol} · request v${checkpoint.runtime.requestSchemaVersion}`,
      `Effective token limit: ${formatNumber(checkpoint.runtime.effectiveTokenLimit)}`,
      `Replacement: ${formatNumber(checkpoint.replacement.length)} items · 1 compaction · ${formatNumber(retainedUsers)} user · ${formatNumber(retainedAgents)} agent`,
    );
  }
  return lines.join("\n");
};

export const registerCheckpointRenderer = (pi: ExtensionAPI) => {
  pi.registerEntryRenderer(CHECKPOINT_CUSTOM_TYPE, (entry, options, theme) => {
    const text = formatCheckpointEntry(entry.data, options.expanded);
    return text === undefined ? undefined : new Text(theme.fg("accent", text), 1, 0);
  });
};
