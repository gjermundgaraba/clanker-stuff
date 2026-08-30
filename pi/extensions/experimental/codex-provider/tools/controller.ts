import {
  TOOL_OWNER_PROTOCOL_VERSION,
  TOOL_OWNER_REQUEST_EVENT,
} from "@clanker-stuff/tool-owner-protocol";
import type { ToolOwnerRegistration } from "@clanker-stuff/tool-owner-protocol";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { CodeModeRuntime } from "../code-mode/tools.js";
import { PI_SUBAGENTS_NAMESPACE, requestCollaborationContract } from "../collaboration.js";
import { CODE_MODE_STATUS_KEY } from "../footer.js";
import { createCodexDirectTools, isCodexToolsModel } from "./direct.js";
import { createCodexToolSelection } from "./selection.js";

const ToolOwnerRequestSchema = Type.Object({
  protocol: Type.Literal(TOOL_OWNER_PROTOCOL_VERSION),
  provide: Type.Function([Type.Unknown()], Type.Void()),
  type: Type.Literal("request"),
});

export const createCodexToolsController = (
  pi: ExtensionAPI,
  setFooterActive: (active: boolean) => void,
) => {
  const direct = createCodexDirectTools();
  const codeMode = new CodeModeRuntime();
  const selection = createCodexToolSelection(pi);
  const directDefinitions = [...direct.definitions];
  const codeDefinitions = codeMode.createTools();
  const directNames = directDefinitions.map(({ name }) => name);
  const codeNames = codeDefinitions.map(({ name }) => name);
  const toolNames = [...directNames, ...codeNames];
  const codexToolNameSet = new Set(toolNames);
  let piToolNames: Set<string> | undefined;
  let codeModeEnabled = false;
  let currentModel: ExtensionContext["model"];
  let suppressedPiNames: string[] = [];
  // Discover after Pi binds the runtime, then preserve built-in identity across profile overrides.
  const builtinToolNames = () =>
    (piToolNames ??= new Set(
      pi
        .getAllTools()
        .filter(({ sourceInfo }) => sourceInfo.source === "builtin")
        .map(({ name }) => name),
    ));

  const codeModeActive = () =>
    codeModeEnabled && currentModel !== undefined && isCodexToolsModel(currentModel);

  const visibleNames = (model: ExtensionContext["model"] = currentModel): string[] => {
    if (model === undefined || !isCodexToolsModel(model)) {
      return [];
    }
    return codeModeEnabled ? codeNames : directNames;
  };

  const apply = (ctx: ExtensionContext): void => {
    const previousModel = currentModel;
    currentModel = ctx.model;
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
    const activeNames = pi.getActiveTools();
    if (ctx.model === undefined || !isCodexToolsModel(ctx.model)) {
      const remainingNames = activeNames.filter((name) => !codexToolNameSet.has(name));
      pi.setActiveTools([...new Set([...suppressedPiNames, ...remainingNames])]);
      suppressedPiNames = [];
      return;
    }
    if (previousModel === undefined || !isCodexToolsModel(previousModel)) {
      suppressedPiNames = activeNames.filter((name) => builtinToolNames().has(name));
    }
    const externalNames = activeNames.filter(
      (name) => !builtinToolNames().has(name) && !codexToolNameSet.has(name),
    );
    pi.setActiveTools([
      ...externalNames,
      ...selection.enabled(codeModeActive() ? codeNames : directNames),
    ]);
  };
  const owner = {
    names: toolNames,
    setEnabled: (name: string, enabled: boolean, ctx: ExtensionContext) => {
      selection.setEnabled(name, enabled, ctx);
      apply(ctx);
    },
    suppressedNames: (model: ExtensionContext["model"] = currentModel) =>
      model !== undefined && isCodexToolsModel(model) ? [...builtinToolNames()] : [],
    visibleNames,
  } satisfies ToolOwnerRegistration;

  return {
    apply,
    beforeAgentStart(
      systemPrompt: string,
      ctx: ExtensionContext,
    ): { systemPrompt: string } | undefined {
      apply(ctx);
      if (!codeModeActive()) {
        return undefined;
      }
      const section = codeMode.prompt();
      return systemPrompt.includes(section)
        ? undefined
        : { systemPrompt: `${systemPrompt.trimEnd()}\n\n${section}` };
    },
    definitions: [...directDefinitions, ...codeDefinitions],
    registerOwner(): void {
      pi.events.on(TOOL_OWNER_REQUEST_EVENT, (request) => {
        if (Value.Check(ToolOwnerRequestSchema, request)) {
          builtinToolNames();
          Value.Parse(ToolOwnerRequestSchema, request).provide(owner);
        }
      });
    },
    async shutdown(reason: SessionShutdownEvent["reason"]): Promise<void> {
      if (reason === "reload") {
        pi.setActiveTools([...new Set([...suppressedPiNames, ...pi.getActiveTools()])]);
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
      ctx.ui.notify(`Code Mode ${codeModeEnabled ? "enabled" : "disabled"}`, "info");
    },
  };
};
