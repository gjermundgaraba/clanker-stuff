// Catalog guidance and errors adapted from OpenAI Codex (Apache-2.0); see NOTICE.
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

// Optional model metadata shared structurally with providers (no package dependency).
const MetadataSchema = Type.Object({
  description: Type.Optional(Type.String()),
  defaultReasoningEffort: Type.Optional(Type.String()),
  serviceTiers: Type.Array(Type.String()),
  showInPicker: Type.Boolean(),
});

export type SpawnModelRegistry = Pick<ModelRegistry, "find" | "getAvailable">;

const metadata = (model: Model<Api>) =>
  "spawnAgentMetadata" in model && Value.Check(MetadataSchema, model.spawnAgentMetadata)
    ? model.spawnAgentMetadata
    : undefined;

export const supportsSpawn = (model: Model<Api>, protocol: "v1" | "v2"): boolean =>
  protocol !== "v2" || !("multiAgentVersion" in model && model.multiAgentVersion === "disabled");

export const suggestedSpawnModels = (
  registry: SpawnModelRegistry,
  provider: string | undefined,
  protocol: "v1" | "v2",
): Model<Api>[] => {
  // getAvailable is Pi's authenticated, provider-filtered picker snapshot.
  return registry
    .getAvailable()
    .filter((model) => model.provider === provider && metadata(model)?.showInPicker !== false)
    .filter((model) => supportsSpawn(model, protocol))
    .slice(0, 5);
};

export const spawnModelsDescription = (
  registry: SpawnModelRegistry,
  provider: string | undefined,
  protocol: "v1" | "v2",
): string => {
  const models = suggestedSpawnModels(registry, provider, protocol);
  if (models.length === 0) return "No picker-visible model overrides are currently loaded.";
  const descriptions = models.map((model) => {
    const info = metadata(model);
    const efforts = getSupportedThinkingLevels(model).map((effort) =>
      effort === info?.defaultReasoningEffort ? `${effort} (default)` : effort,
    );
    const reasoning = efforts.length === 0 ? "" : ` Reasoning efforts: ${efforts.join(", ")}.`;
    const tiers = info?.serviceTiers ?? [];
    const service = tiers.length === 0 ? "" : ` Service tiers: ${tiers.join(", ")}.`;
    return `- \`${model.id}\`: ${info?.description ?? model.name}${reasoning}${service}`;
  });
  return `Available model overrides (optional; inherited parent model is preferred):\n${descriptions.join("\n")}`;
};

export const unknownSpawnModel = (
  requested: string,
  registry: SpawnModelRegistry,
  provider: string,
  protocol: "v1" | "v2",
): Error =>
  new Error(
    `Unknown model \`${requested}\` for spawn_agent. Available models: ${suggestedSpawnModels(
      registry,
      provider,
      protocol,
    )
      .map((model) => model.id)
      .join(", ")}`,
  );

export const validateSpawnReasoning = (model: Model<Api>, effort: ModelThinkingLevel): void => {
  const supported = getSupportedThinkingLevels(model);
  if (!supported.includes(effort)) {
    throw new Error(
      `Reasoning effort \`${effort}\` is not supported for model \`${model.id}\`. Supported reasoning efforts: ${supported.join(", ")}`,
    );
  }
};
