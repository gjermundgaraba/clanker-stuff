import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const CODEX_TOOLS_STATE_TYPE = "codex-provider-tools";
const CodexToolsStateSchema = Type.Record(Type.String(), Type.Boolean());
type CodexToolsState = Static<typeof CodexToolsStateSchema>;

const savedState = (ctx: ExtensionContext): CodexToolsState | undefined => {
  const entry = ctx.sessionManager
    .getBranch()
    .findLast(
      (candidate) =>
        candidate.type === "custom" &&
        candidate.customType === CODEX_TOOLS_STATE_TYPE
    );
  return entry?.type === "custom" &&
    Value.Check(CodexToolsStateSchema, entry.data)
    ? entry.data
    : undefined;
};

export const createCodexToolSelection = (pi: ExtensionAPI) => {
  let baseline: Record<string, boolean> = {};
  let tools: Record<string, boolean> = {};

  return {
    enabled(names: readonly string[]): string[] {
      return names.filter((name) => tools[name] ?? true);
    },
    restore(ctx: ExtensionContext): void {
      tools = savedState(ctx) ?? baseline;
    },
    setEnabled(name: string, enabled: boolean, _ctx: ExtensionContext): void {
      tools = { ...tools, [name]: enabled };
      pi.appendEntry<CodexToolsState>(CODEX_TOOLS_STATE_TYPE, tools);
    },
    start(ctx: ExtensionContext): void {
      baseline = tools;
      tools = savedState(ctx) ?? baseline;
    },
  };
};
