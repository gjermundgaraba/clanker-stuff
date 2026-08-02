import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
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

import {
  RESPONSES_LITE_HEADER,
  rewriteResponsesLiteRequest,
} from "./code-mode/provider.js";
import { CodeModeRuntime } from "./code-mode/tools.js";
import { ToolOperations } from "./operations.js";
import { isCodexModel } from "./profiles/codex.js";
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
  const operations = new ToolOperations();
  const codeMode = new CodeModeRuntime();
  let baseline: string[] | undefined;
  let codeModeEnabled = false;
  let codeModeDefinitions: ToolDefinition[] = [];
  let profileNames = new Set<string>();
  const isCodeModeActive = (model: Model<Api> | undefined) =>
    codeModeEnabled && model !== undefined && isCodexModel(model);

  return {
    apply(ctx: ExtensionContext) {
      baseline ??= pi.getActiveTools();

      const profile = resolveProfile(ctx.model);
      const profileTools = profile ? [...profile.createTools(operations)] : [];
      const useCodeMode =
        profile?.id === "codex" && isCodeModeActive(ctx.model);
      codeModeDefinitions = useCodeMode ? profileTools : [];
      const tools = useCodeMode
        ? codeMode.createTools(profileTools)
        : profileTools;
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
      return useCodeMode ? "codex-code-mode" : (profile?.id ?? "generic-pi");
    },
    applyProviderHeaders(
      headers: Record<string, string | null>,
      ctx: ExtensionContext
    ) {
      if (isCodeModeActive(ctx.model)) {
        headers[RESPONSES_LITE_HEADER] = "true";
      }
    },
    augmentSystemPrompt(systemPrompt: string, ctx: ExtensionContext) {
      if (!(isCodeModeActive(ctx.model) && codeModeDefinitions.length > 0)) {
        return;
      }
      const heading = "Tools available in exec:";
      if (systemPrompt.includes(heading)) {
        return systemPrompt;
      }
      const section = codeMode.prompt(codeModeDefinitions);
      const markers = ["\nCurrent shell:", "\nCurrent date:"]
        .map((marker) => systemPrompt.indexOf(marker))
        .filter((index) => index !== -1);
      const insertAt =
        markers.length > 0 ? Math.min(...markers) : systemPrompt.length;
      return `${systemPrompt.slice(0, insertAt).trimEnd()}\n\n${section}${systemPrompt.slice(insertAt)}`;
    },
    async dispose() {
      await codeMode.shutdown();
      await operations.dispose();
    },
    rewriteProviderRequest(payload: unknown, ctx: ExtensionContext) {
      return isCodeModeActive(ctx.model)
        ? rewriteResponsesLiteRequest(payload)
        : undefined;
    },
    toggleCodeMode() {
      codeModeEnabled = !codeModeEnabled;
      return codeModeEnabled;
    },
  };
};
