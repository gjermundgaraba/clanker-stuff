import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import type { ToolExposure, ToolInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vite-plus/test";

import { createIdentityTheme } from "../../../../tests/harness/tui.js";
import { renderOverlay, layoutOverlay } from "../render.js";
import { buildToolsSnapshot } from "../tools.js";
import { buildTree, filterTree } from "../tree.js";

const sourceInfo = createSyntheticSourceInfo("<inventory-test>", {
  source: "test",
});

const tool = (name: string, exposure: ToolExposure): ToolInfo => ({
  name,
  exposure,
  description: `Tool ${name}`,
  parameters: Type.Object({ query: Type.String() }),
  sourceInfo,
});

describe("registered tool inventory", () => {
  it.each([
    { exposure: "direct", active: true, callable: true },
    { exposure: "direct", active: false, callable: false },
    { exposure: "model-only", active: true, callable: false },
    { exposure: "codemode", active: false, callable: true },
    { exposure: "deferred", active: false, callable: true },
    { exposure: "hidden", active: false, callable: false },
  ] as const)(
    "distinguishes $exposure activation ($active) from nested access",
    ({ exposure, active, callable }) => {
      const snapshot = buildToolsSnapshot(
        [tool("example", exposure)],
        active ? ["example"] : []
      );

      expect(snapshot.activeCount).toBe(active ? 1 : 0);
      expect(snapshot.tools[0]?.label).toBe(
        `example · ${exposure} · ${active ? "active" : "inactive"}`
      );
      expect(JSON.parse(snapshot.tools[0]!.body)).toMatchObject({
        active,
        callableFromTools: callable,
        reachesTools: false,
        parameters: { properties: { query: { type: "string" } } },
        sourceInfo: { path: "<inventory-test>", source: "test" },
      });
      expect(snapshot.tools[0]?.estimatedTokens).toBe(0);
    }
  );

  it("snapshots metadata and aliases without executing or retaining reachability hooks", () => {
    const registered = {
      ...tool("mcp__docs__search", "deferred"),
      namespace: {
        name: "mcp__docs",
        aliases: ["docs"],
        description: "Documentation",
      },
      annotations: { readOnlyHint: true },
      reachesTools: () => {
        throw new Error("must not run during inspection");
      },
    };

    const snapshot = buildToolsSnapshot([registered], []);
    registered.namespace.aliases.push("later");
    registered.description = "later";
    expect(JSON.parse(snapshot.tools[0]!.body)).toMatchObject({
      description: "Tool mcp__docs__search",
      namespace: { name: "mcp__docs", aliases: ["docs"] },
      annotations: { readOnlyHint: true },
      reachesTools: true,
    });
    const tree = buildTree(snapshot);
    expect(filterTree(tree, "docs")[0]?.children).toHaveLength(1);

    const rendered = renderOverlay(
      createIdentityTheme(),
      snapshot,
      layoutOverlay(120, 24, false),
      [],
      ""
    ).join("\n");

    expect(rendered).toContain("1 registered · 0 active");
    expect(rendered).toContain("no token estimates");
    expect(rendered).not.toContain("tokens ·");
    expect(rendered).not.toContain("system ~");
  });
});
