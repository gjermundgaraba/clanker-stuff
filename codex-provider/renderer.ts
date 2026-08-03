import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { CHECKPOINT_CUSTOM_TYPE, parseCheckpoint } from "./checkpoint.js";
import type { Checkpoint } from "./checkpoint.js";
import { estimateModelVisibleTokens } from "./replay.js";

const phaseLabels: Record<Checkpoint["phase"], string> = {
  "mid-turn": "while the agent was working",
  "overflow-retry": "while recovering from the context limit",
  "pre-sampling": "before the model replied",
  standalone: "between turns",
};

const reasonLabels: Record<Checkpoint["reason"], string> = {
  manual: "Manual: requested by you",
  overflow: "Automatic: context limit exceeded",
  threshold: "Automatic: context threshold reached",
};

const formatNumber = (value: number) => value.toLocaleString("en-US");

const formatSizeChange = (before: number, after: number) => {
  if (before === after) {
    return "unchanged";
  }
  if (before === 0) {
    return "larger";
  }
  const percent = Math.abs(1 - after / before) * 100;
  return `${percent.toLocaleString("en-US", { maximumFractionDigits: 1 })}% ${after < before ? "smaller" : "larger"}`;
};

export const formatCheckpointEntry = (data: unknown): string | undefined => {
  const parsed = parseCheckpoint(data);
  if (!parsed.ok) {
    return undefined;
  }
  const { checkpoint } = parsed;
  const replacementTokens = estimateModelVisibleTokens(
    "",
    checkpoint.replacement
  );
  const { usage } = checkpoint.response;
  const lines = [
    `✓ Context compacted successfully · ${checkpoint.identity.model}`,
    `Context: ~${formatNumber(checkpoint.sourceTokens)} → ~${formatNumber(replacementTokens)} tokens · ${formatSizeChange(checkpoint.sourceTokens, replacementTokens)}`,
    `${reasonLabels[checkpoint.reason]} · ${phaseLabels[checkpoint.phase]}`,
    `Provider usage: ${formatNumber(usage.totalTokens)} tokens total`,
    `Breakdown: ${formatNumber(usage.input)} uncached input · ${formatNumber(usage.cacheRead)} cached input · ${formatNumber(usage.output)} output · ${formatNumber(usage.cacheWrite)} cache write`,
  ];
  return lines.join("\n");
};

export const registerCheckpointRenderer = (pi: ExtensionAPI) => {
  pi.registerEntryRenderer(CHECKPOINT_CUSTOM_TYPE, (entry, _options, theme) => {
    const text = formatCheckpointEntry(entry.data);
    return text === undefined
      ? undefined
      : new Text(theme.fg("accent", text), 1, 0);
  });
};
