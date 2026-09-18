import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const CHECKPOINT_CUSTOM_TYPE = "codex-provider.checkpoint";

const MarkerDetailsSchema = Type.Object({ type: Type.String() });

export const branchNeedsCodex = (branch: readonly SessionEntry[]): boolean => {
  for (const entry of branch.toReversed()) {
    if (entry.type === "custom" && entry.customType === CHECKPOINT_CUSTOM_TYPE) {
      return true;
    }

    if (entry.type === "compaction") {
      return (
        Value.Check(MarkerDetailsSchema, entry.details) &&
        entry.details.type === CHECKPOINT_CUSTOM_TYPE
      );
    }
  }

  return false;
};
