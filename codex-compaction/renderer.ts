import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { CHECKPOINT_CUSTOM_TYPE, parseCheckpoint } from "./checkpoint.js";
import { estimateModelVisibleTokens } from "./replay.js";

export const formatCheckpointEntry = (data: unknown) => {
  const parsed = parseCheckpoint(data);
  if (!parsed.ok) {
    return;
  }
  const { checkpoint } = parsed;
  const replacementTokens = estimateModelVisibleTokens(
    "",
    checkpoint.replacement
  );
  const lines = [
    `OpenAI Codex checkpoint · ${checkpoint.identity.model}`,
    `${checkpoint.phase} · ${checkpoint.reason} · ${checkpoint.sourceTokens} source tokens → ~${replacementTokens} replacement tokens`,
  ];
  const { usage } = checkpoint.response;
  lines.push(
    `${usage.input} input · ${usage.output} output · ${usage.cacheRead} cache read · ${usage.cacheWrite} cache write · ${usage.totalTokens} total`
  );
  return lines.join("\n");
};

export const registerCheckpointRenderer = (pi: ExtensionAPI) => {
  pi.registerEntryRenderer(CHECKPOINT_CUSTOM_TYPE, (entry, _options, theme) => {
    const text = formatCheckpointEntry(entry.data);
    return text ? new Text(theme.fg("accent", text), 1, 0) : undefined;
  });
};
