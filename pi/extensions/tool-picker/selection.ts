import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const STATE_TYPE = "tool-picker-config";
const BASELINE_TYPE = "tool-picker-baseline";
const ToolStatesSchema = Type.Record(Type.String(), Type.Boolean());
export type ToolStates = Static<typeof ToolStatesSchema>;

const savedStates = (
  entries: readonly SessionEntry[],
  customType: string,
): ToolStates | undefined => {
  const entry = entries.findLast(
    (candidate) => candidate.type === "custom" && candidate.customType === customType,
  );
  return entry?.type === "custom" && Value.Check(ToolStatesSchema, entry.data)
    ? entry.data
    : undefined;
};

export const createToolSelection = (pi: ExtensionAPI) => {
  let baseline: ToolStates = {};
  let baselineSaved = false;
  const snapshot = (): ToolStates => {
    const active = new Set(pi.getActiveTools());
    return Object.fromEntries(pi.getAllTools().map(({ name }) => [name, active.has(name)]));
  };
  const saveBaseline = (): void => {
    if (!baselineSaved) {
      pi.appendEntry<ToolStates>(BASELINE_TYPE, baseline);
      baselineSaved = true;
    }
  };
  const restore = (ctx: ExtensionContext): ToolStates => {
    const states = savedStates(ctx.sessionManager.getBranch(), STATE_TYPE);
    if (states !== undefined) {
      saveBaseline();
    }
    return { ...baseline, ...states };
  };

  return {
    restore,
    save(ctx: ExtensionContext): void {
      saveBaseline();
      pi.appendEntry<ToolStates>(STATE_TYPE, {
        ...savedStates(ctx.sessionManager.getBranch(), STATE_TYPE),
        ...snapshot(),
      });
    },
    start(ctx: ExtensionContext): ToolStates {
      // Reload preserves active tools, so recover the original baseline from the whole session.
      const savedBaseline = savedStates(ctx.sessionManager.getEntries(), BASELINE_TYPE);
      const initial = snapshot();
      baselineSaved =
        savedBaseline !== undefined &&
        Object.keys(initial).every((name) => Object.hasOwn(savedBaseline, name));
      baseline = { ...initial, ...savedBaseline };
      return restore(ctx);
    },
  };
};
