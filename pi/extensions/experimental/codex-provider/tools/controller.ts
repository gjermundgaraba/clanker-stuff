import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { collectContributions, placeContributions } from "@clanker-stuff/code-mode-tools";

import type { CodexModelCatalog } from "../model-catalog.js";

import { CodeModeRuntime } from "../code-mode/tools.js";
import { PI_SUBAGENTS_NAMESPACE, requestCollaborationContract } from "../collaboration.js";
import { CODE_MODE_STATUS_KEY } from "../footer.js";
import { withExecutionSettings } from "./execution-context.js";
import type { ToolExecutionSettings } from "./execution-context.js";
import { createCodexDirectTools } from "./direct.js";

export const createCodexToolsController = (
  pi: ExtensionAPI,
  setFooterActive: (active: boolean) => void,
  supportsModel: CodexModelCatalog["supportsModel"],
  evaluationToolMode?: "direct" | "code_mode_only",
  executionSettings?: ToolExecutionSettings,
) => {
  const direct = createCodexDirectTools();
  const codeMode = new CodeModeRuntime();
  const directDefinitions = [...direct.definitions];
  const codeDefinitions = [codeMode.createWaitTool()];
  const directNames = directDefinitions.map(({ name }) => name);
  const codeNames = ["exec", "wait"];
  const codexToolNameSet = new Set([...directNames, ...codeNames]);
  let codeModeEnabled = false;
  let currentModel: ExtensionContext["model"];
  let modelRegistry: ExtensionContext["modelRegistry"] | undefined;
  let suppressedPiNames: string[] | undefined;
  let suppressedAsyncNames: string[] = [];
  let tuiAvailable = false;
  let lastContext: ExtensionContext | undefined;
  let execDescription: string | undefined;

  const wrap = (definition: ToolDefinition): ToolDefinition => ({
    ...definition,
    execute: (id, args, signal, onUpdate, ctx) =>
      definition.execute(
        id,
        args,
        signal,
        onUpdate,
        withExecutionSettings(ctx, executionSettings?.take(ctx.sessionManager.getSessionId(), id)),
      ),
  });

  const configuredDefinition = (definition: ToolDefinition): ToolDefinition => ({
    ...definition,
    execute: (id, args, signal, update, ctx) => {
      if (!pi.getAllTools().some(({ name }) => name === definition.name))
        throw new Error(`Nested tool is no longer available: ${definition.name}`);

      return definition.execute(id, args, signal, update, ctx);
    },
  });

  const prepareContributions = (): (() => void) => {
    const nestedOnly =
      currentModel !== undefined &&
      supportsModel(currentModel) &&
      effectiveMode(currentModel) === "code_mode_only";

    const inventories = collectContributions(pi);
    const contributed = inventories.flatMap((inventory) => inventory.tools);
    const collaboration = lastContext ? requestCollaborationContract(pi, lastContext) : undefined;

    const descriptors = [
      ...direct.nestedDefinitions.map((definition) => ({
        definition: configuredDefinition(definition),
      })),
      ...(collaboration?.protocol === "v1"
        ? collaboration.nestedTools.map((tool) => ({
            ...tool,
            definition: configuredDefinition(tool.definition),
            namespace: PI_SUBAGENTS_NAMESPACE,
          }))
        : []),
      ...contributed,
    ];

    try {
      codeMode.prepareNestedTools(descriptors);

      return () => {
        // Pi applies allowlists and exclusions during registration, not staging.
        const configured = new Set(pi.getAllTools().map(({ name }) => name));
        const admitted = descriptors.filter(({ definition }) => configured.has(definition.name));
        codeMode.prepareNestedTools(admitted)();

        const exec = codeModeActive()
          ? codeMode.createExecTool(codeMode.prompt(admitted))
          : undefined;

        if (exec && exec.description !== execDescription) {
          const active = pi.getActiveTools();
          pi.registerTool(wrap(exec));
          pi.setActiveTools(active);
          execDescription = exec.description;
        }

        placeContributions(pi, collectContributions(pi), nestedOnly);
      };
    } catch (error) {
      lastContext?.ui.notify(
        `Code Mode inventory rejected: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      throw error;
    }
  };

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
    if (model === undefined || !supportsModel(model) || !("codexToolMode" in model)) {
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
    model !== undefined && supportsModel(model) && effectiveMode(model) !== "direct";

  const apply = (ctx: ExtensionContext, refreshModel = true): void => {
    lastContext = ctx;
    tuiAvailable = ctx.mode === "tui" && ctx.hasUI;
    modelRegistry = ctx.modelRegistry;

    if (refreshModel) {
      // Catalog refresh replaces registry models without replacing the session's selected object.
      currentModel = resolveModel(ctx.model);
    }

    prepareContributions()();
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

    if (currentModel === undefined || !supportsModel(currentModel)) {
      const remainingNames = activeNames.filter((name) => !codexToolNameSet.has(name));
      pi.setActiveTools([...new Set([...(suppressedPiNames ?? []), ...remainingNames])]);
      suppressedPiNames = undefined;

      return;
    }

    const builtinNames = builtinToolNames();

    suppressedPiNames ??= activeNames.filter((name) => builtinNames.has(name));

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
    prepareContributions,
    takeAccounting: (id: string) => codeMode.takeAccounting(id),
    definitions: [...directDefinitions, ...codeDefinitions].map(wrap),
    async shutdown(reason: SessionShutdownEvent["reason"]): Promise<void> {
      if (reason === "reload") {
        const enabled = collectContributions(pi).flatMap((inventory) =>
          inventory.tools.map(({ definition }) => definition.name),
        );

        pi.setActiveTools([
          ...new Set(
            [
              ...(suppressedPiNames ?? []),
              ...suppressedAsyncNames,
              ...pi.getActiveTools(),
              ...enabled,
            ].filter((name) => !isQuestionnaire(name) || tuiAvailable),
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
