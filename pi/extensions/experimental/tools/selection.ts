import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const TOOLS_STATE_TYPE = "tools-config";
const ToolsStateSchema = Type.Object(
  {
    tools: Type.Record(Type.String(), Type.Record(Type.String(), Type.Boolean())),
  },
  { additionalProperties: false },
);

type ToolsState = Static<typeof ToolsStateSchema>;
type ToolStates = ToolsState["tools"];

const savedToolStates = (ctx: ExtensionContext): ToolStates | undefined => {
  const entry = ctx.sessionManager
    .getBranch()
    .findLast(
      (candidate) => candidate.type === "custom" && candidate.customType === TOOLS_STATE_TYPE,
    );
  return entry?.type === "custom" && Value.Check(ToolsStateSchema, entry.data)
    ? entry.data.tools
    : undefined;
};

export const createToolSelection = (pi: ExtensionAPI) => {
  let baseline: ToolStates = {};
  let states: ToolStates = {};

  const capture = (
    scope: string,
    names: Iterable<string>,
    activeNames: ReadonlySet<string>,
  ): void => {
    states = {
      ...states,
      [scope]: {
        ...states[scope],
        ...Object.fromEntries([...names].map((name) => [name, activeNames.has(name)])),
      },
    };
  };

  const restore = (ctx: ExtensionContext): void => {
    states = savedToolStates(ctx) ?? baseline;
  };

  return {
    capture,
    enabled(scope: string, names: Iterable<string>, defaults: ReadonlySet<string>): string[] {
      return [...names].filter((name) => states[scope]?.[name] ?? defaults.has(name));
    },
    persist(): void {
      pi.appendEntry<ToolsState>(TOOLS_STATE_TYPE, { tools: states });
    },
    restore,
    setEnabled(scope: string, name: string, enabled: boolean): void {
      states = {
        ...states,
        [scope]: { ...states[scope], [name]: enabled },
      };
    },
    start(ctx: ExtensionContext): void {
      baseline = states;
      restore(ctx);
    },
  };
};
