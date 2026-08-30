import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";

import { toolOperations } from "./operations.js";
import { createToolOwners } from "./ownership.js";
import { HARNESS_PROFILES } from "./profiles/index.js";
import { createToolSelection } from "./selection.js";

const resolveProfile = (model: Model<Api> | undefined) =>
  model ? HARNESS_PROFILES.find((profile) => profile.matches(model)) : undefined;

const PI_SCOPE = "pi";
const HARNESS_SCOPE = "harness";
const EXTERNAL_SCOPE = "external";

export const createToolsRuntime = (pi: ExtensionAPI) => {
  const owners = createToolOwners(pi);
  const selection = createToolSelection(pi);
  let piToolNames: Set<string> | undefined;
  let currentManagedNames = new Set<string>();
  let currentScope = PI_SCOPE;
  const managedNames = new Set<string>();
  let profileNames = new Set<string>();
  // Discover after Pi binds the runtime, then preserve built-in identity across profile overrides.
  const builtinToolNames = () =>
    (piToolNames ??= new Set(
      pi
        .getAllTools()
        .filter(({ sourceInfo }) => sourceInfo.source === "builtin")
        .map(({ name }) => name),
    ));
  const visibleTools = (ownerModel?: Model<Api>) =>
    pi
      .getAllTools()
      .filter(({ name }) =>
        owners.owns(name)
          ? owners.isVisible(name, ownerModel)
          : !owners.suppresses(name, ownerModel) &&
            (!managedNames.has(name) || currentManagedNames.has(name)),
      );
  const captureCurrentSelection = (ownerModel?: Model<Api>, tools = visibleTools(ownerModel)) => {
    const activeNames = new Set(pi.getActiveTools());
    const visibleNames = tools.map(({ name }) => name);
    if (!owners.hasVisibleTools(ownerModel)) {
      selection.capture(currentScope, currentManagedNames, activeNames);
    }
    selection.capture(
      EXTERNAL_SCOPE,
      visibleNames.filter((name) => !currentManagedNames.has(name) && !owners.owns(name)),
      activeNames,
    );
    return activeNames;
  };

  const apply = (
    ctx: ExtensionContext,
    captureSelection = true,
    previousModel?: Model<Api>,
  ): void => {
    const activeNames = captureSelection
      ? captureCurrentSelection(previousModel)
      : new Set(pi.getActiveTools());

    const profile = resolveProfile(ctx.model);
    const tools = profile ? [...profile.createTools(toolOperations)] : [];
    const selectedNames = tools.map((tool) => tool.name);
    const selectedNameSet = new Set(selectedNames);

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
    currentManagedNames = profile ? selectedNameSet : new Set(builtinToolNames());
    currentScope = profile ? HARNESS_SCOPE : PI_SCOPE;
    const unmanagedNames = pi
      .getAllTools()
      .map(({ name }) => name)
      .filter((name) => !managedNames.has(name) && !owners.owns(name));
    const external = selection.enabled(EXTERNAL_SCOPE, unmanagedNames, activeNames);
    const managed = selection
      .enabled(currentScope, currentManagedNames, profile ? currentManagedNames : activeNames)
      .filter((name) => !owners.suppresses(name, ctx.model));
    const owned = owners.ownedActive(activeNames);
    pi.setActiveTools(
      profile ? [...external, ...managed, ...owned] : [...managed, ...external, ...owned],
    );
  };

  return {
    apply,
    async openPicker(ctx: ExtensionCommandContext): Promise<void> {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/tools requires TUI mode", "error");
        return;
      }
      const tools = visibleTools();
      const activeNames = captureCurrentSelection(undefined, tools);
      const { showToolsPicker } = await import("./picker.js");
      await showToolsPicker(ctx, tools, activeNames, (name, enabled) => {
        if (enabled) {
          activeNames.add(name);
        } else {
          activeNames.delete(name);
        }
        if (owners.setEnabled(name, enabled, ctx)) {
          return;
        }
        selection.setEnabled(
          currentManagedNames.has(name) ? currentScope : EXTERNAL_SCOPE,
          name,
          enabled,
        );
        pi.setActiveTools([...activeNames]);
        selection.persist();
      });
    },
    prepareReload(ctx: ExtensionContext): void {
      const suppressedNames = [...builtinToolNames()].filter((name) =>
        owners.suppresses(name, ctx.model),
      );
      const activeNames = new Set(pi.getActiveTools());
      pi.setActiveTools([
        ...selection.enabled(PI_SCOPE, suppressedNames, activeNames),
        ...activeNames,
      ]);
    },
    restore(ctx: ExtensionContext): void {
      selection.restore(ctx);
      apply(ctx, false);
    },
    start(ctx: ExtensionContext): void {
      currentManagedNames = new Set(builtinToolNames());
      for (const name of currentManagedNames) {
        managedNames.add(name);
      }
      selection.capture(PI_SCOPE, currentManagedNames, new Set(pi.getActiveTools()));
      captureCurrentSelection();
      selection.start(ctx);
      apply(ctx, false);
    },
  };
};
