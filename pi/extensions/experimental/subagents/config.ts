// Spawn model errors adapted from OpenAI Codex (Apache-2.0); see ./NOTICE.
import { readFile } from "node:fs/promises";

import { getSupportedThinkingLevels, modelsAreEqual, StringEnum } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const STRICT = { additionalProperties: false } as const;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const ThinkingSchema = StringEnum(THINKING_LEVELS);

const RoleSchema = Type.Object(
  {
    description: Type.Optional(Type.String({ minLength: 1 })),
    instructions: Type.Optional(Type.String()),
    model: Type.Optional(Type.String({ minLength: 1 })),
    thinking: Type.Optional(ThinkingSchema),
  },
  STRICT,
);

const SubagentsConfigSchema = Type.Object(
  {
    delegation: Type.Optional(StringEnum(["explicit", "proactive"] as const)),
    max_concurrent_threads_per_session: Type.Optional(Type.Integer({ minimum: 1 })),
    roles: Type.Optional(
      Type.Record(Type.String({ pattern: "^[a-z0-9_-]+$" }), RoleSchema, STRICT),
    ),
    version: Type.Literal(2),
  },
  STRICT,
);

export type AgentThinkingLevel = (typeof THINKING_LEVELS)[number];

export type RoleConfig = Static<typeof RoleSchema>;

export interface SubagentsConfig {
  delegation: "explicit" | "proactive";
  maxConcurrent: number;
  roles: Record<string, RoleConfig>;
}

export const DEFAULT_CONFIG: SubagentsConfig = {
  delegation: "explicit",
  maxConcurrent: 3,
  roles: {},
};

export type SpawnModelRegistry = Pick<ModelRegistry, "find" | "getAvailable">;

export const parseConfig = <T>(value: T): SubagentsConfig => {
  if (!Value.Check(SubagentsConfigSchema, value)) {
    throw new Error("config must be a strict version 2 object");
  }

  return {
    delegation: value.delegation ?? DEFAULT_CONFIG.delegation,
    maxConcurrent: value.max_concurrent_threads_per_session ?? DEFAULT_CONFIG.maxConcurrent,
    roles: value.roles ?? {},
  };
};

export const loadConfig = async (
  configPath: string,
): Promise<{ config: SubagentsConfig; error: string | undefined }> => {
  try {
    return {
      config: parseConfig(JSON.parse(await readFile(configPath, "utf-8"))),
      error: undefined,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: DEFAULT_CONFIG, error: undefined };
    }

    return {
      config: DEFAULT_CONFIG,
      error: `Invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

const unknownSpawnModel = (requested: string, registry: SpawnModelRegistry): Error =>
  new Error(
    `Unknown model \`${requested}\` for spawn_agent. Available models: ${registry
      .getAvailable()
      .slice(0, 5)
      .map((model) => `${model.provider}/${model.id}`)
      .join(", ")}`,
  );

const findModel = (requested: string, registry: SpawnModelRegistry): Model<Api> => {
  const slash = requested.indexOf("/");

  if (slash < 1 || slash === requested.length - 1) {
    throw new Error("Model overrides must use provider/model-id");
  }

  const model = registry.find(requested.slice(0, slash), requested.slice(slash + 1));

  if (model === undefined) {
    throw unknownSpawnModel(requested, registry);
  }

  return model;
};

export interface ChildSettings {
  instructions: string | undefined;
  model: Model<Api>;
  /** Undefined lets the child session choose its model's default. */
  thinking: AgentThinkingLevel | undefined;
}

export interface SpawnRequest {
  agentType: string | undefined;
  model: string | undefined;
  thinking: AgentThinkingLevel | undefined;
}

export interface ParentSettings {
  model: Model<Api> | undefined;
  registry: SpawnModelRegistry;
  thinking: AgentThinkingLevel | undefined;
}

/** A configured role fixes model and reasoning; explicit requests apply otherwise; the parent fills the rest. */
export const resolveChildSettings = (
  config: SubagentsConfig,
  request: SpawnRequest,
  parent: ParentSettings,
): ChildSettings => {
  const role =
    request.agentType !== undefined && Object.hasOwn(config.roles, request.agentType)
      ? config.roles[request.agentType]
      : undefined;

  if (request.agentType !== undefined && role === undefined) {
    throw new Error(`Unknown agent_type: ${request.agentType}`);
  }

  const requestedModel = role?.model ?? request.model;

  const model =
    requestedModel === undefined ? parent.model : findModel(requestedModel, parent.registry);

  if (model === undefined) {
    throw new Error("No model is selected for the child; select a model or pass one explicitly");
  }

  const explicitThinking = role?.thinking ?? request.thinking;

  if (
    explicitThinking !== undefined &&
    !getSupportedThinkingLevels(model).includes(explicitThinking)
  ) {
    throw new Error(
      `Reasoning effort \`${explicitThinking}\` is not supported for model \`${model.id}\`. Supported reasoning efforts: ${getSupportedThinkingLevels(model).join(", ")}`,
    );
  }

  return {
    instructions: role?.instructions,
    model,
    thinking:
      explicitThinking ?? (modelsAreEqual(model, parent.model) ? parent.thinking : undefined),
  };
};
