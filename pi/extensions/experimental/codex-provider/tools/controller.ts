import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import type { CodexModelCatalog } from "../model-catalog.js";
import { CodeModeRuntime } from "../code-mode/tools.js";
import { CODE_MODE_STATUS_KEY } from "../footer.js";
import { createCodexDirectTools } from "./direct.js";

export const createCodexToolsController = (
  pi: ExtensionAPI,
  setFooterActive: (active: boolean) => void,
  supportsModel: CodexModelCatalog["supportsModel"],
  evaluationToolMode?: "direct" | "code_mode_only",
) => {
  const direct = createCodexDirectTools();
  const codeMode = new CodeModeRuntime({ renderers: direct.definitions });
  const directNames = direct.definitions.map(({ name }) => name);
  const codexToolNames = new Set([...directNames, "exec"]);
  let codeModeEnabled = false;
  let currentModel: ExtensionContext["model"];
  let modelRegistry: ExtensionContext["modelRegistry"] | undefined;
  let suppressedPiNames: string[] | undefined;
  let suppressedAsyncNames: string[] = [];
  let tuiAvailable = false;

  const isQuestionnaire = (name: string) =>
    name === "request_user_input" || name === "request_user_input_async";

  const declaredMode = (model: ExtensionContext["model"]) => {
    if (!model || !supportsModel(model) || !("codexToolMode" in model)) return undefined;
    const mode = model.codexToolMode;

    return mode === "direct" || mode === "code_mode" || mode === "code_mode_only"
      ? mode
      : undefined;
  };

  const effectiveMode = (model: ExtensionContext["model"]) =>
    evaluationToolMode ?? declaredMode(model) ?? (codeModeEnabled ? "code_mode_only" : "direct");

  const resolveModel = (model: ExtensionContext["model"]) =>
    model === undefined ? undefined : (modelRegistry?.find(model.provider, model.id) ?? model);

  const apply = (ctx: ExtensionContext, refreshModel = true): void => {
    tuiAvailable = ctx.mode === "tui" && ctx.hasUI;
    modelRegistry = ctx.modelRegistry;

    if (refreshModel) currentModel = resolveModel(ctx.model);
    const supported = currentModel !== undefined && supportsModel(currentModel);
    const codeActive = supported && effectiveMode(currentModel) !== "direct";
    ctx.ui.setStatus(CODE_MODE_STATUS_KEY, codeActive ? "</>" : undefined);
    setFooterActive(codeActive);
    const candidates = [...new Set([...pi.getActiveTools(), ...suppressedAsyncNames])];
    suppressedAsyncNames = [];

    const activeNames = candidates.filter((name) => {
      if (isQuestionnaire(name) && !tuiAvailable) {
        suppressedAsyncNames.push(name);

        return false;
      }

      return true;
    });

    if (!supported) {
      pi.setActiveTools([
        ...new Set([
          ...(suppressedPiNames ?? []),
          ...activeNames.filter((name) => !codexToolNames.has(name)),
        ]),
      ]);
      suppressedPiNames = undefined;

      return;
    }

    const builtins = new Set(
      pi
        .getAllTools()
        .filter(({ sourceInfo }) => sourceInfo.source === "builtin")
        .map(({ name }) => name),
    );

    suppressedPiNames ??= activeNames.filter((name) => builtins.has(name));

    const external = activeNames.filter((name) => {
      if (builtins.has(name) || codexToolNames.has(name)) return false;

      const supportedTools =
        currentModel &&
        "codexSupportedTools" in currentModel &&
        Array.isArray(currentModel.codexSupportedTools)
          ? currentModel.codexSupportedTools
          : [];

      if (name === "send_message_to_user_async" && !supportedTools.includes(name)) {
        suppressedAsyncNames.push(name);

        return false;
      }

      return true;
    });

    // Direct tools stay callable. exec's loadout hides declarations in code-only mode.
    pi.setActiveTools([...external, ...directNames, ...(codeActive ? ["exec"] : [])]);
  };

  return {
    apply,
    definitions: [
      ...direct.definitions,
      codeMode.createExecTool(() => effectiveMode(currentModel) === "code_mode_only"),
    ],
    async shutdown(reason: SessionShutdownEvent["reason"]): Promise<void> {
      if (reason === "reload")
        pi.setActiveTools(
          [
            ...new Set([
              ...(suppressedPiNames ?? []),
              ...suppressedAsyncNames,
              ...pi.getActiveTools(),
            ]),
          ].filter((name) => !codexToolNames.has(name) && (!isQuestionnaire(name) || tuiAvailable)),
        );
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
