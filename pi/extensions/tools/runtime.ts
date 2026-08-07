import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  RESPONSES_LITE_HEADER,
  rewriteResponsesLiteRequest,
} from "./code-mode/provider.js";
import { CodeModeRuntime } from "./code-mode/tools.js";
import { ToolOperations } from "./operations.js";
import { isCodexModel } from "./profiles/codex.js";
import { HARNESS_PROFILES } from "./profiles/index.js";

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

  const apply = (ctx: ExtensionContext) => {
    baseline ??= pi.getActiveTools();

    const profile = resolveProfile(ctx.model);
    const profileTools = profile ? [...profile.createTools(operations)] : [];
    const useCodeMode = profile?.id === "codex" && isCodeModeActive(ctx.model);
    codeModeDefinitions = useCodeMode ? profileTools : [];
    const tools = useCodeMode
      ? codeMode.createTools(profileTools)
      : profileTools;
    const selectedNames = tools.map((tool) => tool.name);
    const selectedNameSet = new Set(selectedNames);

    const managedNames = new Set([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
      ...profileNames,
      ...selectedNames,
    ]);
    const unmanaged = pi
      .getActiveTools()
      .filter((name) => !managedNames.has(name));

    if (profileNames.has("grep") && !selectedNameSet.has("grep")) {
      pi.registerTool(createGrepToolDefinition(ctx.cwd));
    }
    for (const tool of tools) {
      pi.registerTool(tool);
    }
    profileNames = selectedNameSet;
    pi.setActiveTools([
      ...new Set(
        profile ? [...unmanaged, ...selectedNames] : [...baseline, ...unmanaged]
      ),
    ]);
  };

  return {
    apply,
    applyProviderHeaders(
      headers: Record<string, string | null>,
      ctx: ExtensionContext
    ) {
      if (isCodeModeActive(ctx.model)) {
        headers[RESPONSES_LITE_HEADER] = "true";
      }
    },
    augmentSystemPrompt(systemPrompt: string, ctx: ExtensionContext) {
      let result: { systemPrompt: string } | undefined;
      if (isCodeModeActive(ctx.model) && codeModeDefinitions.length > 0) {
        const section = codeMode.prompt(codeModeDefinitions);
        if (!systemPrompt.includes(section)) {
          result = {
            systemPrompt: `${systemPrompt.trimEnd()}\n\n${section}`,
          };
        }
      }
      return result;
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
    toggleCodeMode(ctx: ExtensionContext): void {
      codeModeEnabled = !codeModeEnabled;
      apply(ctx);
      ctx.ui.notify(
        `Code Mode ${codeModeEnabled ? "enabled" : "disabled"}`,
        "info"
      );
    },
  };
};
