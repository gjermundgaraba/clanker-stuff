import { readFile } from "node:fs/promises";

import { StringEnum } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

const STRICT = { additionalProperties: false } as const;
const ProtocolModeSchema = StringEnum(["auto", "off", "v1", "v2"] as const);
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ThinkingSchema = StringEnum(THINKING_LEVELS);
const RoleSchema = Type.Object(
  {
    description: Type.Optional(Type.String({ minLength: 1 })),
    instructions: Type.Optional(Type.String()),
    model: Type.Optional(Type.String({ minLength: 1 })),
    nicknames: Type.Optional(
      Type.Array(
        Type.String({
          maxLength: 64,
          minLength: 1,
          pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$",
        }),
        { minItems: 1 },
      ),
    ),
    provider: Type.Optional(Type.String({ minLength: 1 })),
    thinking: Type.Optional(ThinkingSchema),
  },
  STRICT,
);
const PromptSchema = Type.Object(
  {
    child: Type.Optional(Type.String()),
    delegation: Type.Optional(StringEnum(["explicit", "proactive"] as const)),
    v1: Type.Optional(Type.Object({ root: Type.Optional(Type.String()) }, STRICT)),
    v2: Type.Optional(
      Type.Object(
        {
          child: Type.Optional(Type.String()),
          root: Type.Optional(Type.String()),
        },
        STRICT,
      ),
    ),
  },
  STRICT,
);
const SubagentsConfigSchema = Type.Object(
  {
    expose_spawn_agent_model_overrides: Type.Optional(Type.Boolean()),
    max_concurrent_threads_per_session: Type.Optional(Type.Integer({ minimum: 1 })),
    prompts: Type.Optional(PromptSchema),
    protocols: Type.Optional(Type.Record(Type.String({ minLength: 1 }), ProtocolModeSchema)),
    roles: Type.Optional(
      Type.Record(Type.String({ pattern: "^[a-z0-9_-]+$" }), RoleSchema, STRICT),
    ),
    version: Type.Literal(1),
  },
  STRICT,
);

export type ProtocolMode = Static<typeof ProtocolModeSchema>;
export type RoleConfig = Static<typeof RoleSchema>;
export interface SubagentsConfig {
  expose_spawn_agent_model_overrides: boolean;
  max_concurrent_threads_per_session?: number;
  prompts: {
    child?: string;
    delegation: "explicit" | "proactive";
    v1?: { root?: string };
    v2?: { child?: string; root?: string };
  };
  protocols: Record<string, ProtocolMode>;
  roles: Record<string, RoleConfig>;
  version: 1;
}

export const DEFAULT_CONFIG: SubagentsConfig = {
  expose_spawn_agent_model_overrides: true,
  prompts: { delegation: "explicit" },
  protocols: {},
  roles: {},
  version: 1,
};

export const roleInstructions = (
  config: SubagentsConfig,
  roleName: string | undefined,
): string | undefined =>
  roleName === undefined ? undefined : config.roles[roleName]?.instructions;

export const parseConfig = <T>(value: T): SubagentsConfig => {
  if (!Value.Check(SubagentsConfigSchema, value)) {
    throw new Error("config must be a strict version 1 object");
  }
  for (const [name, role] of Object.entries(value.roles ?? {})) {
    if (role.provider !== undefined && role.model === undefined) {
      throw new Error(`Role ${name} must set model when provider is set`);
    }
  }
  return {
    ...value,
    expose_spawn_agent_model_overrides: value.expose_spawn_agent_model_overrides ?? true,
    prompts: { delegation: "explicit", ...value.prompts },
    protocols: value.protocols ?? {},
    roles: value.roles ?? {},
  };
};

export const loadConfig = async (
  configPath: string,
): Promise<{ config: SubagentsConfig; error?: string }> => {
  try {
    return {
      config: parseConfig(JSON.parse(await readFile(configPath, "utf-8"))),
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { config: structuredClone(DEFAULT_CONFIG) };
    }
    return {
      config: structuredClone(DEFAULT_CONFIG),
      error: `Invalid ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

export type AgentThinkingLevel = (typeof THINKING_LEVELS)[number];
export interface ChildSettings {
  instructions?: string;
  model: Model<Api> | undefined;
  thinking: AgentThinkingLevel | undefined;
}
type ModelLookup = Pick<ModelRegistry, "find" | "getAll">;

export const isThinkingLevel = (value: string): value is AgentThinkingLevel =>
  THINKING_LEVELS.some((level) => level === value);

const findModel = (provider: string, modelId: string, registry: ModelLookup): Model<Api> => {
  const model = registry.find(provider, modelId);
  if (!model) {
    throw new Error(`Unknown model: ${provider}/${modelId}`);
  }
  return model;
};

export const parseModelOverride = (
  requested: string | undefined,
  registry: ModelLookup,
  fallback?: Model<Api>,
): Model<Api> | undefined => {
  if (requested === undefined || requested === "") {
    return fallback;
  }
  const separator = requested.indexOf("/");
  if (separator === -1) {
    const models = registry.getAll();
    const inheritedProvider = fallback
      ? models.find(
          (candidate) => candidate.provider === fallback.provider && candidate.id === requested,
        )
      : undefined;
    if (inheritedProvider !== undefined) {
      return inheritedProvider;
    }
    const matches = models.filter((candidate) => candidate.id === requested);
    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous model: ${requested}; use provider/model format`);
    }
    throw new Error(`Unknown model: ${requested}`);
  }
  if (separator < 1 || separator === requested.length - 1) {
    throw new Error("model must be a model id or use provider/model format");
  }
  return findModel(requested.slice(0, separator), requested.slice(separator + 1), registry);
};

export const resolveChildSettings = (
  config: SubagentsConfig,
  roleName: string | undefined,
  requestedModel: string | undefined,
  requestedThinking: AgentThinkingLevel | undefined,
  registry: ModelLookup,
  parentModel: Model<Api> | undefined,
  parentThinking?: AgentThinkingLevel,
): ChildSettings => {
  const role =
    roleName !== undefined && Object.hasOwn(config.roles, roleName)
      ? config.roles[roleName]
      : undefined;
  if (roleName !== undefined && role === undefined) {
    throw new Error(`Unknown agent_type: ${roleName}`);
  }
  let model = parseModelOverride(requestedModel, registry, parentModel);
  if (role?.model !== undefined) {
    model =
      role.provider === undefined
        ? parseModelOverride(role.model, registry, parentModel)
        : findModel(role.provider, role.model, registry);
  }
  const settings: ChildSettings = {
    model,
    thinking: role?.thinking ?? requestedThinking ?? parentThinking,
  };
  if (role?.instructions !== undefined) {
    settings.instructions = role.instructions;
  }
  return settings;
};
