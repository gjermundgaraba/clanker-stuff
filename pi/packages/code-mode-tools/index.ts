import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";

const CONTENT_OUTPUT_SCHEMA = Type.Object(
  {
    content: Type.Array(
      Type.Union([
        Type.Object(
          { type: Type.Literal("text"), text: Type.String() },
          { additionalProperties: false },
        ),
        Type.Object(
          { type: Type.Literal("image"), image_url: Type.String() },
          { additionalProperties: false },
        ),
      ]),
    ),
  },
  { additionalProperties: false },
);

/** Owner-managed registration and structured content, using Pi's ordinary capability registry. */
export class ContentTools {
  private readonly staged = new Map<string, ToolDefinition>();
  private definitions = new Map<string, ToolDefinition>();
  private enabled = new Set<string>();

  constructor(private readonly pi: Pick<ExtensionAPI, "getAllTools" | "registerTool">) {}

  getAllTools = () => this.pi.getAllTools();

  registerTool<T extends TSchema, D>(definition: ToolDefinition<T, D>): void {
    this.staged.set(
      definition.name,
      defineTool({
        ...definition,
        outputSchema: CONTENT_OUTPUT_SCHEMA,
        execute: async (id, args, signal, onUpdate, ctx) => {
          const result = await definition.execute(id, args, signal, onUpdate, ctx);

          return {
            ...result,
            structuredContent: {
              content: result.content.map((item) =>
                item.type === "text"
                  ? { type: "text" as const, text: item.text }
                  : {
                      type: "image" as const,
                      image_url: `data:${item.mimeType};base64,${item.data}`,
                    },
              ),
            },
          };
        },
      }),
    );
  }

  setEnabled(names?: readonly string[]): void {
    const registered = new Set(this.pi.getAllTools().map((tool) => tool.name));

    for (const name of this.staged.keys()) {
      if (registered.has(name) && !this.definitions.has(name))
        throw new Error(`Tool name is already registered: ${name}`);
    }

    const definitions = new Map([...this.definitions, ...this.staged]);
    const enabled = new Set(names ?? definitions.keys());

    try {
      for (const [name, definition] of definitions) {
        if (
          definition !== this.definitions.get(name) ||
          enabled.has(name) !== this.enabled.has(name)
        ) {
          this.pi.registerTool({
            ...definition,
            exposure: enabled.has(name) ? "direct" : "hidden",
          });
        }
      }

      this.definitions = definitions;
      this.enabled = enabled;
    } finally {
      this.staged.clear();
    }
  }
}

export const sumUsages = (usages: readonly Usage[]): Usage | undefined => {
  let total: Usage | undefined;

  for (const usage of usages) {
    total ??= {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
      total[key] += usage[key];

    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
      total.cost[key] += usage.cost[key];

    if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  }

  return total;
};
