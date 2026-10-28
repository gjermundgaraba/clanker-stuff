import type { ToolInfo } from "@earendil-works/pi-coding-agent";

import type { ContextPart } from "./snapshot.js";

export interface ToolsSnapshot {
  readonly kind: "tools";
  readonly capturedAt: number;
  readonly activeCount: number;
  readonly tools: readonly ContextPart[];
}

export const buildToolsSnapshot = (
  tools: readonly ToolInfo[],
  activeTools: readonly string[]
): ToolsSnapshot => {
  const active = new Set(activeTools);

  return {
    kind: "tools",
    capturedAt: Date.now(),
    activeCount: tools.filter((tool) => active.has(tool.name)).length,
    tools: tools
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((tool) => {
        const { reachesTools, ...metadata } = tool;
        const activated = active.has(tool.name);

        return {
          label: `${tool.name} · ${tool.exposure} · ${activated ? "active" : "inactive"}`,
          body: JSON.stringify(
            {
              ...metadata,
              active: activated,
              callableFromTools:
                tool.exposure === "codemode" ||
                tool.exposure === "deferred" ||
                (tool.exposure === "direct" && activated),
              reachesTools: reachesTools !== undefined,
            },
            null,
            2
          ),
          format: "json",
          tone: "code",
          estimatedTokens: 0,
        };
      }),
  };
};
