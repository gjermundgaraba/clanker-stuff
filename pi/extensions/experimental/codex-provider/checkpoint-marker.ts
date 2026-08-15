import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const CHECKPOINT_CUSTOM_TYPE = "codex-provider.checkpoint";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const branchNeedsCodex = (branch: readonly SessionEntry[]): boolean => {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      entry.type === "custom" &&
      entry.customType === CHECKPOINT_CUSTOM_TYPE
    ) {
      return true;
    }
    if (entry.type === "compaction") {
      return (
        isRecord(entry.details) && entry.details.type === CHECKPOINT_CUSTOM_TYPE
      );
    }
  }
  return false;
};
