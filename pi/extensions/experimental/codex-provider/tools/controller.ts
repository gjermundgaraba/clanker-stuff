import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { CodeModeRuntime } from "../code-mode/tools.js";
import { PI_SUBAGENTS_NAMESPACE, requestCollaborationContract } from "../collaboration.js";
import { CODE_MODE_STATUS_KEY } from "../footer.js";
import { withExecutionSettings } from "./execution-context.js";
import type { ToolExecutionSettings } from "./execution-context.js";
import { createCodexDirectTools, isCodexToolsModel } from "./direct.js";

export const createCodexToolsController = (
  pi: ExtensionAPI,
  setFooterActive: (active: boolean) => void,
  evaluationToolMode?: "direct" | "code_mode_only",
  executionSettings?: ToolExecutionSettings,
) => {
  const direct = createCodexDirectTools();
  const codeMode = new CodeModeRuntime();
  const directDefinitions = [...direct.definitions];
  const codeDefinitions = codeMode.createTools();
  const directNames = directDefinitions.map(({ name }) => name);
  const codeNames = codeDefinitions.map(({ name }) => name);
  const codexToolNameSet = new Set([...directNames, ...codeNames]);
  let codeModeEnabled = false;
  let currentModel: ExtensionContext["model"];
  let modelRegistry: ExtensionContext["modelRegistry"] | undefined;
  let suppressedPiNames: string[] = [];
  let suppressedAsyncNames: string[] = [];
  let tuiAvailable = false;
  const isQuestionnaire = (name: string) =>
    name === "request_user_input" || name === "request_user_input_async";
  const builtinToolNames = () =>
    new Set(
      pi
        .getAllTools()
        .filter(({ sourceInfo }) => sourceInfo.source === "builtin")
        .map(({ name }) => name),
    );

  const declaredMode = (model: ExtensionContext["model"]) => {
    if (model === undefined || !isCodexToolsModel(model) || !("codexToolMode" in model)) {
      return undefined;
    }
    const mode = model.codexToolMode;
    return mode === "direct" || mode === "code_mode" || mode === "code_mode_only"
      ? mode
      : undefined;
  };

  const effectiveMode = (model: ExtensionContext["model"]) =>
    evaluationToolMode ?? declaredMode(model) ?? (codeModeEnabled ? "code_mode_only" : "direct");

  const resolveModel = (model: ExtensionContext["model"]) =>
    model === undefined ? undefined : (modelRegistry?.find(model.provider, model.id) ?? model);

  const codeModeActive = (model: ExtensionContext["model"] = currentModel) =>
    model !== undefined && isCodexToolsModel(model) && effectiveMode(model) !== "direct";

  const apply = (ctx: ExtensionContext, refreshModel = true): void => {
    const previousModel = currentModel;
    tuiAvailable = ctx.mode === "tui" && ctx.hasUI;
    modelRegistry = ctx.modelRegistry;
    if (refreshModel) {
      // Catalog refresh replaces registry models without replacing the session's selected object.
      currentModel = resolveModel(ctx.model);
    }
    const collaboration = requestCollaborationContract(pi, ctx);
    codeMode.setNestedTools([
      ...direct.nestedDefinitions.map((definition) => ({ definition })),
      ...(collaboration?.protocol === "v1"
        ? collaboration.nestedTools.map((tool) => ({
            ...tool,
            namespace: PI_SUBAGENTS_NAMESPACE,
          }))
        : []),
    ]);
    const active = codeModeActive();
    ctx.ui.setStatus(CODE_MODE_STATUS_KEY, active ? "</>" : undefined);
    setFooterActive(active);
    const candidates = [...new Set([...pi.getActiveTools(), ...suppressedAsyncNames])];
    suppressedAsyncNames = [];
    // Questionnaires are external Pi tools, not native catalog capabilities.
    // This final normalizer must not restore them in unsupported answering modes.
    const activeNames = candidates.filter((name) => {
      if (isQuestionnaire(name) && !tuiAvailable) {
        suppressedAsyncNames.push(name);
        return false;
      }
      return true;
    });
    if (currentModel === undefined || !isCodexToolsModel(currentModel)) {
      const remainingNames = activeNames.filter((name) => !codexToolNameSet.has(name));
      pi.setActiveTools([...new Set([...suppressedPiNames, ...remainingNames])]);
      suppressedPiNames = [];
      return;
    }
    const builtinNames = builtinToolNames();
    if (previousModel === undefined || !isCodexToolsModel(previousModel)) {
      suppressedPiNames = activeNames.filter((name) => builtinNames.has(name));
    }
    const externalNames = activeNames.filter((name) => {
      if (builtinNames.has(name) || codexToolNameSet.has(name)) return false;
      const supported =
        currentModel !== undefined &&
        "codexSupportedTools" in currentModel &&
        Array.isArray(currentModel.codexSupportedTools)
          ? currentModel.codexSupportedTools
          : [];
      const available = name !== "send_message_to_user_async" || supported.includes(name);
      if (!available) suppressedAsyncNames.push(name);
      return available;
    });
    const mode = effectiveMode(currentModel);
    const names =
      mode === "code_mode"
        ? [...directNames, ...codeNames]
        : mode === "code_mode_only"
          ? codeNames
          : directNames;
    pi.setActiveTools([...externalNames, ...names]);
  };

  return {
    apply,
    beforeAgentStart(systemPrompt: string): { systemPrompt: string } | undefined {
      if (!codeModeActive()) {
        return undefined;
      }
      const section = codeMode.prompt();
      return systemPrompt.includes(section)
        ? undefined
        : { systemPrompt: `${systemPrompt.trimEnd()}\n\n${section}` };
    },
    definitions: [...directDefinitions, ...codeDefinitions].map((definition): ToolDefinition => ({
      ...definition,
      execute: (id, args, signal, onUpdate, ctx) =>
        definition.execute(
          id,
          args,
          signal,
          onUpdate,
          withExecutionSettings(
            ctx,
            executionSettings?.take(ctx.sessionManager.getSessionId(), id),
          ),
        ),
    })),
    async shutdown(reason: SessionShutdownEvent["reason"]): Promise<void> {
      if (reason === "reload") {
        pi.setActiveTools([
          ...new Set(
            [...suppressedPiNames, ...suppressedAsyncNames, ...pi.getActiveTools()].filter(
              (name) => !isQuestionnaire(name) || tuiAvailable,
            ),
          ),
        ]);
      }
      await codeMode.shutdown();
      await direct.dispose();
    },
    toggle(ctx: ExtensionContext): void {
      modelRegistry = ctx.modelRegistry;
      const mode = declaredMode(resolveModel(ctx.model));
      if (mode !== undefined) {
        apply(ctx);
        const label = {
          direct: "direct tools",
          code_mode: "direct tools with Code Mode",
          code_mode_only: "Code Mode",
        }[mode];
        ctx.ui.notify(`${ctx.model?.id} requires ${label}; /code-mode cannot change it.`, "info");
        return;
      }
      codeModeEnabled = !codeModeEnabled;
      apply(ctx);
      ctx.ui.notify(`Code Mode ${codeModeEnabled ? "enabled" : "disabled"}`, "info");
    },
  };
};
