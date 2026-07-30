import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { ToolCore } from "./core.js";
import { HARNESS_PROFILES } from "./profiles/index.js";

const GENERIC_TOOL_RESTORERS = {
  bash: (pi: ExtensionAPI, cwd: string) =>
    pi.registerTool(createBashToolDefinition(cwd)),
  edit: (pi: ExtensionAPI, cwd: string) =>
    pi.registerTool(createEditToolDefinition(cwd)),
  find: (pi: ExtensionAPI, cwd: string) =>
    pi.registerTool(createFindToolDefinition(cwd)),
  grep: (pi: ExtensionAPI, cwd: string) =>
    pi.registerTool(createGrepToolDefinition(cwd)),
  ls: (pi: ExtensionAPI, cwd: string) =>
    pi.registerTool(createLsToolDefinition(cwd)),
  read: (pi: ExtensionAPI, cwd: string) =>
    pi.registerTool(createReadToolDefinition(cwd)),
  write: (pi: ExtensionAPI, cwd: string) =>
    pi.registerTool(createWriteToolDefinition(cwd)),
} as const;

const isGenericToolName = (
  name: string
): name is keyof typeof GENERIC_TOOL_RESTORERS =>
  Object.hasOwn(GENERIC_TOOL_RESTORERS, name);

const resolveProfile = (model: Model<Api> | undefined) =>
  model
    ? HARNESS_PROFILES.find((profile) => profile.matches(model))
    : undefined;

export const createToolsRuntime = (pi: ExtensionAPI) => {
  const core = new ToolCore();
  let baseline: string[] | undefined;
  let profileNames = new Set<string>();

  return {
    apply(ctx: ExtensionContext) {
      baseline ??= pi.getActiveTools();

      const profile = resolveProfile(ctx.model);
      const tools = profile ? [...profile.createTools(core)] : [];
      const selectedNames = tools.map((tool) => tool.name);
      const selectedNameSet = new Set(selectedNames);

      const managedNames = new Set([
        ...Object.keys(GENERIC_TOOL_RESTORERS),
        ...profileNames,
        ...selectedNames,
      ]);
      const unmanaged = pi
        .getActiveTools()
        .filter((name) => !managedNames.has(name));

      for (const name of profileNames) {
        if (!selectedNameSet.has(name) && isGenericToolName(name)) {
          GENERIC_TOOL_RESTORERS[name](pi, ctx.cwd);
        }
      }
      for (const tool of tools) {
        pi.registerTool(tool);
      }
      profileNames = selectedNameSet;
      pi.setActiveTools([
        ...new Set(
          profile
            ? [...unmanaged, ...selectedNames]
            : [...baseline, ...unmanaged]
        ),
      ]);
      return profile?.id ?? "generic-pi";
    },
    async dispose() {
      await core.dispose();
    },
  };
};
