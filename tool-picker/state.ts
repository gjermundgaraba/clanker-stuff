import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface ToolsState {
  enabledTools: string[];
}

export const TOOLS_STATE_TYPE = "tools-config";

const getLatestSavedEnabledTools = (
  ctx: ExtensionContext
): string[] | undefined => {
  const branchEntries = ctx.sessionManager.getBranch();

  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const entry = branchEntries[index];
    if (entry?.type !== "custom" || entry.customType !== TOOLS_STATE_TYPE) {
      continue;
    }

    const { data } = entry;
    if (
      typeof data === "object" &&
      data !== null &&
      "enabledTools" in data &&
      Array.isArray(data.enabledTools) &&
      data.enabledTools.every((tool) => typeof tool === "string")
    ) {
      return data.enabledTools;
    }
  }

  return undefined;
};

export const persistToolsState = (
  pi: ExtensionAPI,
  enabledTools: Set<string>
): void => {
  pi.appendEntry<ToolsState>(TOOLS_STATE_TYPE, {
    enabledTools: [...enabledTools],
  });
};

export const restoreEnabledTools = (
  ctx: ExtensionContext,
  availableToolNames: Set<string>,
  baselineToolNames: Iterable<string>
): Set<string> => {
  const savedTools = getLatestSavedEnabledTools(ctx) ?? baselineToolNames;

  return new Set(
    [...savedTools].filter((toolName) => availableToolNames.has(toolName))
  );
};
