import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
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
import { showToolsPicker } from "./picker.js";
import { isCodexModel } from "./profiles/codex.js";
import { HARNESS_PROFILES } from "./profiles/index.js";
import { createToolSelection } from "./selection.js";

const resolveProfile = (model: Model<Api> | undefined) =>
  model
    ? HARNESS_PROFILES.find((profile) => profile.matches(model))
    : undefined;

const PI_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"];
const PI_SCOPE = "pi";
const HARNESS_SCOPE = "harness";
const CODE_MODE_SCOPE = "code-mode";
const EXTERNAL_SCOPE = "external";

export const createToolsRuntime = (pi: ExtensionAPI) => {
  const operations = new ToolOperations();
  const codeMode = new CodeModeRuntime();
  const selection = createToolSelection(pi);
  let codeModeEnabled = false;
  const piToolNames = () =>
    pi
      .getAllTools()
      .map(({ name }) => name)
      .filter((name) => PI_TOOL_NAMES.includes(name));
  let codeModeDefinitions: ToolDefinition[] = [];
  let currentManagedNames = new Set(PI_TOOL_NAMES);
  let currentScope = PI_SCOPE;
  const managedNames = new Set(PI_TOOL_NAMES);
  let profileNames = new Set<string>();
  const visibleTools = () =>
    pi
      .getAllTools()
      .filter(
        ({ name }) => !managedNames.has(name) || currentManagedNames.has(name)
      );
  const isCodeModeActive = (model: Model<Api> | undefined) =>
    codeModeEnabled && model !== undefined && isCodexModel(model);
  const captureCurrentSelection = (tools = visibleTools()) => {
    const activeNames = new Set(pi.getActiveTools());
    const visibleNames = tools.map(({ name }) => name);
    selection.capture(currentScope, currentManagedNames, activeNames);
    selection.capture(
      EXTERNAL_SCOPE,
      visibleNames.filter((name) => !currentManagedNames.has(name)),
      activeNames
    );
    return activeNames;
  };

  const apply = (ctx: ExtensionContext, captureSelection = true) => {
    const activeNames = captureSelection
      ? captureCurrentSelection()
      : new Set(pi.getActiveTools());

    const profile = resolveProfile(ctx.model);
    const profileTools = profile ? [...profile.createTools(operations)] : [];
    const useCodeMode = profile?.id === "codex" && isCodeModeActive(ctx.model);
    codeModeDefinitions = useCodeMode ? profileTools : [];
    const tools = useCodeMode
      ? codeMode.createTools(profileTools)
      : profileTools;
    const selectedNames = tools.map((tool) => tool.name);
    const selectedNameSet = new Set(selectedNames);
    let nextScope = PI_SCOPE;
    if (profile) {
      nextScope = useCodeMode ? CODE_MODE_SCOPE : HARNESS_SCOPE;
    }

    for (const name of selectedNames) {
      managedNames.add(name);
    }

    if (profileNames.has("grep") && !selectedNameSet.has("grep")) {
      pi.registerTool(createGrepToolDefinition(ctx.cwd));
    }
    for (const tool of tools) {
      pi.registerTool(tool);
    }
    profileNames = selectedNameSet;
    currentManagedNames = profile ? selectedNameSet : new Set(piToolNames());
    currentScope = nextScope;
    const unmanagedNames = pi
      .getAllTools()
      .map(({ name }) => name)
      .filter((name) => !managedNames.has(name));
    const external = selection.enabled(
      EXTERNAL_SCOPE,
      unmanagedNames,
      activeNames
    );
    const managed = selection.enabled(
      currentScope,
      currentManagedNames,
      profile ? currentManagedNames : activeNames
    );
    pi.setActiveTools(
      profile ? [...external, ...managed] : [...managed, ...external]
    );
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
    async openPicker(ctx: ExtensionCommandContext): Promise<void> {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tools requires TUI mode", "error");
        return;
      }
      const tools = visibleTools();
      const activeNames = captureCurrentSelection(tools);
      await showToolsPicker(ctx, tools, activeNames, (name, enabled) => {
        if (enabled) {
          activeNames.add(name);
        } else {
          activeNames.delete(name);
        }
        selection.setEnabled(
          currentManagedNames.has(name) ? currentScope : EXTERNAL_SCOPE,
          name,
          enabled
        );
        pi.setActiveTools([...activeNames]);
        selection.persist();
      });
    },
    restore(ctx: ExtensionContext): void {
      selection.restore(ctx);
      apply(ctx, false);
    },
    rewriteProviderRequest(payload: unknown, ctx: ExtensionContext) {
      return isCodeModeActive(ctx.model)
        ? rewriteResponsesLiteRequest(payload)
        : undefined;
    },
    start(ctx: ExtensionContext): void {
      currentManagedNames = new Set(piToolNames());
      captureCurrentSelection();
      selection.start(ctx);
      apply(ctx, false);
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
