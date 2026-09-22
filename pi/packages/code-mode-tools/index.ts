import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";

const RequestSchema = Type.Object(
  { accept: Type.Function([Type.Unknown()], Type.Unknown()) },
  { additionalProperties: false },
);

export const CONTRIBUTIONS_REQUEST = "clanker-code-mode:tools-request";

export const CONTRIBUTIONS_PUBLISH = "clanker-code-mode:tools-publish";

const CommitSchema = Type.Function([], Type.Unknown());

const PublishSchema = Type.Object({
  accept: Type.Function([CommitSchema], Type.Unknown()),
  reject: Type.Function([Type.String()], Type.Unknown()),
});

type PlacementAPI = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">;

export const placeContributions = (
  pi: PlacementAPI,
  inventories: readonly ToolInventory[],
  nestedOnly: boolean,
): void => {
  const owned = new Set(inventories.flatMap((inventory) => inventory.ownedNames));
  pi.setActiveTools([
    ...pi.getActiveTools().filter((name) => !owned.has(name)),
    ...(nestedOnly
      ? []
      : inventories.flatMap((inventory) =>
          inventory.tools.map(({ definition }) => definition.name),
        )),
  ]);
};

/** Prepare synchronously; report rejection through the request, not the event bus's swallowed exceptions. */
export const onContributionPublish = (
  pi: Pick<ExtensionAPI, "events">,
  prepare: () => (() => void) | undefined,
): void => {
  pi.events.on(CONTRIBUTIONS_PUBLISH, (request) => {
    if (!Value.Check(PublishSchema, request)) return;

    try {
      const commit = prepare();

      if (commit) request.accept(commit);
    } catch (error) {
      request.reject(error instanceof Error ? error.message : String(error));
    }
  });
};

export interface ToolAccounting {
  usage?: Usage;
  details?: unknown;
}

export interface ContributedTool {
  definition: ToolDefinition;
  resultMode: "content";
  takeAccounting?: (id: string) => ToolAccounting | undefined;
}

export interface ToolInventory {
  ownedNames: string[];
  tools: ContributedTool[];
}

const DefinitionSchema = Type.Object({
  name: Type.String(),
  label: Type.String(),
  description: Type.String(),
  parameters: Type.Record(Type.String(), Type.Unknown()),
  execute: Type.Function([], Type.Unknown()),
});

const InventorySchema = Type.Object({
  ownedNames: Type.Array(Type.String()),
  tools: Type.Array(
    Type.Object({
      definition: DefinitionSchema,
      resultMode: Type.Literal("content"),
      takeAccounting: Type.Optional(Type.Function([Type.String()], Type.Unknown())),
    }),
  ),
});

// The event bus is untyped. Validate executable shape; implementations remain trusted extension code.
const isInventory = (value: unknown): value is ToolInventory => Value.Check(InventorySchema, value);

/** Owners stage definitions, then publish their complete enabled selection. */
export class ContributedTools {
  private definitions = new Map<string, ToolDefinition>();
  private readonly staged = new Map<string, ToolDefinition>();
  private proposal: { definitions: Map<string, ToolDefinition>; enabled: Set<string> } | undefined;
  private enabled = new Set<string>();

  constructor(
    private readonly pi: Pick<
      ExtensionAPI,
      "events" | "registerTool" | "getAllTools" | "getActiveTools" | "setActiveTools"
    >,
    private readonly takeAccounting?: (id: string) => ToolAccounting | undefined,
  ) {
    pi.events.on(CONTRIBUTIONS_REQUEST, (request) => {
      if (Value.Check(RequestSchema, request))
        request.accept(
          this.proposal
            ? this.buildSnapshot(this.proposal.definitions, this.proposal.enabled)
            : this.snapshot(),
        );
    });
  }

  // Registration is staged: no inventory event until the owner calls setEnabled.
  registerTool<T extends TSchema, D>(definition: ToolDefinition<T, D>): void {
    this.staged.set(definition.name, defineTool(definition));
  }

  getAllTools = () => this.pi.getAllTools();

  setEnabled(names?: readonly string[]): void {
    const definitions = new Map([...this.definitions, ...this.staged]);

    const enabled = new Set(
      (names ?? [...definitions.keys()]).filter((name) => definitions.has(name)),
    );

    this.proposal = { definitions, enabled };

    try {
      const registered = new Set(this.pi.getAllTools().map(({ name }) => name));

      for (const name of this.staged.keys())
        if (registered.has(name) && !this.definitions.has(name))
          throw new Error(`Contributed tool name is already registered: ${name}`);
      let commit: (() => void) | undefined;
      let failure: string | undefined;
      this.pi.events.emit(CONTRIBUTIONS_PUBLISH, {
        accept: (value: unknown) => {
          if (!Value.Check(CommitSchema, value)) {
            failure = "Invalid contribution commit";

            return;
          }

          if (commit) {
            failure = "Multiple contribution placement providers";

            return;
          }

          commit = value;
        },
        reject: (message: string) => {
          failure = message;
        },
      });

      if (failure !== undefined) throw new Error(failure);
      collectContributions(this.pi);

      // Validation has completed. Pi registration itself is not a transactional API.
      for (const definition of this.staged.values()) this.pi.registerTool(definition);
      this.definitions = definitions;
      this.enabled = enabled;
      this.proposal = undefined;

      if (commit) commit();
      else placeContributions(this.pi, collectContributions(this.pi), false);
    } finally {
      this.proposal = undefined;
      this.staged.clear();
    }
  }

  snapshot(): ToolInventory {
    const inventory = this.buildSnapshot(this.definitions, this.enabled);

    if (inventory.tools.length === 0) return inventory;
    const configured = new Set(this.pi.getAllTools().map(({ name }) => name));

    return {
      ...inventory,
      tools: inventory.tools.filter(({ definition }) => configured.has(definition.name)),
    };
  }

  private buildSnapshot(
    definitions: Map<string, ToolDefinition>,
    enabled: Set<string>,
  ): ToolInventory {
    return {
      ownedNames: [...definitions.keys()],
      tools: [...definitions.values()]
        .filter((definition) => enabled.has(definition.name))
        .map((definition) => ({
          definition: {
            ...definition,
            execute: (id, args, signal, update, ctx) => {
              if (
                !this.enabled.has(definition.name) ||
                this.definitions.get(definition.name) !== definition ||
                !this.pi.getAllTools().some(({ name }) => name === definition.name)
              )
                throw new Error(`Nested tool is no longer available: ${definition.name}`);

              return definition.execute(id, args, signal, update, ctx);
            },
          },
          resultMode: "content",
          ...(this.takeAccounting ? { takeAccounting: this.takeAccounting } : {}),
        })),
    };
  }
}

export const collectContributions = (pi: Pick<ExtensionAPI, "events">): ToolInventory[] => {
  const inventories: ToolInventory[] = [];
  let invalid = false;
  pi.events.emit(CONTRIBUTIONS_REQUEST, {
    accept: (value: unknown) => {
      if (!isInventory(value)) {
        invalid = true;

        return;
      }

      inventories.push(value);
    },
  });

  if (invalid) throw new Error("Invalid Code Mode tool inventory");

  return inventories;
};

export const sumUsages = (usages: readonly Usage[]): Usage | undefined => {
  let total: Usage | undefined;

  for (const usage of usages) {
    if (!total) {
      total = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    }

    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
      total[key] += usage[key];

    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
      total.cost[key] += usage.cost[key];

    if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  }

  return total;
};
