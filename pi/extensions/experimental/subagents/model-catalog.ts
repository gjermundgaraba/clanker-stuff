// Catalog guidance and errors adapted from OpenAI Codex (Apache-2.0); see NOTICE.
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type SpawnModelRegistry = Pick<ModelRegistry, "find" | "getAvailable">;

export const suggestedSpawnModels = (registry: SpawnModelRegistry): Model<Api>[] =>
  registry.getAvailable().slice(0, 5);

export const spawnModelsDescription = (registry: SpawnModelRegistry): string => {
  const models = suggestedSpawnModels(registry);

  if (models.length === 0) return "No picker-visible model overrides are currently loaded.";

  const descriptions = models.map((model) => {
    const efforts = getSupportedThinkingLevels(model);
    const reasoning = efforts.length === 0 ? "" : ` Reasoning efforts: ${efforts.join(", ")}.`;

    return `- \`${model.provider}/${model.id}\`: ${model.name}.${reasoning}`;
  });

  return `Available model overrides (optional; inherited parent model is preferred):\n${descriptions.join("\n")}`;
};

export const unknownSpawnModel = (requested: string, registry: SpawnModelRegistry): Error =>
  new Error(
    `Unknown model \`${requested}\` for spawn_agent. Available models: ${suggestedSpawnModels(
      registry,
    )
      .map((model) => `${model.provider}/${model.id}`)
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
