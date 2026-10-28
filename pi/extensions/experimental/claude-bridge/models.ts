import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Pi's chat-model registration entry, the only kind this provider registers. */
export type ProviderChatModelConfig = Exclude<
  ProviderModelConfig,
  { type: "image" | "classifier" }
>;

const TWO_HUNDRED_K_CONTEXT = 200_000;

const ONE_M_CONTEXT = 1_000_000;

const isDatedAlias = (id: string): boolean => /-20\d{6}$/u.test(id);

const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];

interface VersionRank {
  family: string;
  major: number;
  minor: number;
}

const versionRank = (id: string): VersionRank => {
  const [, family = "", major, minor] = id.split("-");

  return { family, major: Number(major) || 0, minor: Number(minor) || 0 };
};

const familyTier = (id: string): number => {
  const tier = FAMILY_ORDER.indexOf(versionRank(id).family);

  return tier === -1 ? FAMILY_ORDER.length : tier;
};

/** pi-ai's Anthropic models projected onto pi's provider registration, newest
 *  generation first. Costs are zero: usage is billed to the Claude subscription. */
export const buildModels = (
  catalog: ReadonlyArray<Model<Api>>
): ProviderChatModelConfig[] =>
  catalog
    .filter((model) => !isDatedAlias(model.id))
    .toSorted((a, b) => {
      const tierDelta = familyTier(a.id) - familyTier(b.id);

      if (tierDelta !== 0) {
        return tierDelta;
      }

      const ra = versionRank(a.id);
      const rb = versionRank(b.id);

      if (ra.major !== rb.major) {
        return rb.major - ra.major;
      }

      if (ra.minor !== rb.minor) {
        return rb.minor - ra.minor;
      }

      return a.id.localeCompare(b.id);
    })
    .map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(model.thinkingLevelMap === undefined
        ? {}
        : { thinkingLevelMap: model.thinkingLevelMap }),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));

export const catalogModels = (): ProviderChatModelConfig[] =>
  buildModels(getBuiltinModels("anthropic"));

interface ClaudeCodeRuntimeModel {
  cliModelId: string;
  contextWindow: number;
}

const MEASURED_ONE_M = new Set([
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

export const resolveClaudeCodeRuntimeModel = (
  modelId: string
): ClaudeCodeRuntimeModel =>
  MEASURED_ONE_M.has(modelId)
    ? { cliModelId: `${modelId}[1m]`, contextWindow: ONE_M_CONTEXT }
    : { cliModelId: modelId, contextWindow: TWO_HUNDRED_K_CONTEXT };

export const claudeCodeModelId = (modelId: string): string =>
  resolveClaudeCodeRuntimeModel(modelId).cliModelId;

/** Registered metadata must match the window the bridge requests from Claude Code. */
export const applyLongContext = (
  models: readonly ProviderChatModelConfig[]
): ProviderChatModelConfig[] =>
  models.map((model) => {
    const { contextWindow } = resolveClaudeCodeRuntimeModel(model.id);

    const name =
      contextWindow > TWO_HUNDRED_K_CONTEXT && !/\b1M\b/iu.test(model.name)
        ? `${model.name} 1M`
        : model.name;

    return contextWindow === model.contextWindow && name === model.name
      ? model
      : { ...model, contextWindow, name };
  });

const REASONING_TO_EFFORT: Record<ThinkingLevel, EffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
  max: "max",
};

const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** Pi's reasoning level as a Claude Code effort. The model's own thinkingLevelMap wins:
 *  pi-ai ships one for most Claude models, and a null entry marks the level unsupported,
 *  so no effort is sent and Claude Code's default applies. A map value is trusted only
 *  when it names an effort Claude Code accepts. */
export const effortForReasoning = (
  model: Model<Api>,
  reasoning: ThinkingLevel | undefined
): EffortLevel | undefined => {
  if (reasoning === undefined) {
    return undefined;
  }

  const mapped = model.thinkingLevelMap?.[reasoning];

  if (mapped === undefined) {
    return REASONING_TO_EFFORT[reasoning];
  }

  return EFFORT_LEVELS.find((level) => level === mapped);
};
