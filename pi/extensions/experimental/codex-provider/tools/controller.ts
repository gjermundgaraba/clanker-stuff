import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

import { CodeModeRuntime } from "../code-mode/tools.js";
import { CODE_MODE_STATUS_KEY } from "../footer.js";
import { createCodexDirectTools, isCodexToolsModel } from "./direct.js";
import { createCodexToolSelection } from "./selection.js";

const TOOL_OWNER_CHANNEL = "clanker-stuff:tools:owner";
const PI_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"];

export const createCodexToolsController = (
  pi: ExtensionAPI,
  setFooterActive: (active: boolean) => void
) => {
  const direct = createCodexDirectTools();
  const codeMode = new CodeModeRuntime();
  const selection = createCodexToolSelection(pi);
  const directDefinitions = [...direct.definitions];
  const codeDefinitions = codeMode.createTools(directDefinitions);
  const directNames = directDefinitions.map(({ name }) => name);
  const codeNames = codeDefinitions.map(({ name }) => name);
  const toolNames = [...directNames, ...codeNames];
  const codexToolNameSet = new Set(toolNames);
  const codexManagedNameSet = new Set([...PI_TOOL_NAMES, ...toolNames]);
  let codeModeEnabled = false;
  let currentModel: ExtensionContext["model"];
  let suppressedPiNames: string[] = [];

  const codeModeActive = () =>
    codeModeEnabled &&
    currentModel !== undefined &&
    isCodexToolsModel(currentModel);

  const visibleNames = (
    model: ExtensionContext["model"] = currentModel
  ): string[] => {
    if (model === undefined || !isCodexToolsModel(model)) {
      return [];
    }
    return codeModeEnabled ? codeNames : directNames;
  };

  const apply = (ctx: ExtensionContext): void => {
    const previousModel = currentModel;
    currentModel = ctx.model;
    const active = codeModeActive();
    ctx.ui.setStatus(CODE_MODE_STATUS_KEY, active ? "</>" : undefined);
    setFooterActive(active);
    const activeNames = pi.getActiveTools();
    if (ctx.model === undefined || !isCodexToolsModel(ctx.model)) {
      const remainingNames = activeNames.filter(
        (name) => !codexToolNameSet.has(name)
      );
      pi.setActiveTools([
        ...new Set([...suppressedPiNames, ...remainingNames]),
      ]);
      suppressedPiNames = [];
      return;
    }
    if (previousModel === undefined || !isCodexToolsModel(previousModel)) {
      suppressedPiNames = activeNames.filter((name) =>
        PI_TOOL_NAMES.includes(name)
      );
    }
    const externalNames = activeNames.filter(
      (name) => !codexManagedNameSet.has(name)
    );
    pi.setActiveTools([
      ...externalNames,
      ...selection.enabled(codeModeActive() ? codeNames : directNames),
    ]);
  };
  const publishOwner = (): void => {
    pi.events.emit(TOOL_OWNER_CHANNEL, {
      names: toolNames,
      setEnabled: (name: string, enabled: boolean, ctx: ExtensionContext) => {
        selection.setEnabled(name, enabled, ctx);
        apply(ctx);
      },
      suppressedNames: (model: ExtensionContext["model"] = currentModel) =>
        model !== undefined && isCodexToolsModel(model) ? PI_TOOL_NAMES : [],
      visibleNames,
    });
  };

  return {
    apply,
    beforeAgentStart(
      systemPrompt: string,
      ctx: ExtensionContext
    ): { systemPrompt: string } | undefined {
      apply(ctx);
      if (!codeModeActive()) {
        return undefined;
      }
      const section = codeMode.prompt(directDefinitions);
      return systemPrompt.includes(section)
        ? undefined
        : { systemPrompt: `${systemPrompt.trimEnd()}\n\n${section}` };
    },
    definitions: [...directDefinitions, ...codeDefinitions],
    publishOwner,
    async shutdown(reason: SessionShutdownEvent["reason"]): Promise<void> {
      if (reason === "reload") {
        pi.setActiveTools([
          ...new Set([...suppressedPiNames, ...pi.getActiveTools()]),
        ]);
      }
      await codeMode.shutdown();
      await direct.dispose();
    },
    start(ctx: ExtensionContext): void {
      selection.start(ctx);
      apply(ctx);
    },
    sync(ctx: ExtensionContext): void {
      selection.restore(ctx);
      apply(ctx);
    },
    toggle(ctx: ExtensionContext): void {
      codeModeEnabled = !codeModeEnabled;
      apply(ctx);
      ctx.ui.notify(
        `Code Mode ${codeModeEnabled ? "enabled" : "disabled"}`,
        "info"
      );
    },
  };
};
