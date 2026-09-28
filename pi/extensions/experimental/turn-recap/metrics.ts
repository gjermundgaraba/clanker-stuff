import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

const count = Type.Integer({ minimum: 0 });

const amount = Type.Number({ minimum: 0 });

const closed = { additionalProperties: false } as const;

export const UsageSchema = Type.Object(
  {
    input: count,
    output: count,
    cacheRead: count,
    cacheWrite: count,
    reasoning: count,
    reports: count,
    reasoningReports: count,
    cost: amount,
  },
  closed,
);

export type ReportedUsage = Static<typeof UsageSchema>;

export const MetricsSchema = Type.Object(
  {
    usage: UsageSchema,
    toolCalls: count,
    toolErrors: count,
    responses: count,
    compactions: count,
    models: Type.Array(Type.String()),
    /** Context the run added, from reported sizes. */
    contextGrowth: count,
    /** Pi's current context estimate, for the window details. */
    context: Type.Optional(
      Type.Object(
        {
          tokens: Type.Union([count, Type.Null()]),
          contextWindow: amount,
          percent: Type.Union([amount, Type.Null()]),
        },
        closed,
      ),
    ),
  },
  closed,
);

export type Metrics = Static<typeof MetricsSchema>;

export const emptyUsage = (): ReportedUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  reports: 0,
  reasoningReports: 0,
  cost: 0,
});

export const addUsage = (total: ReportedUsage, usage: Usage): void => {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.cost += usage.cost.total;
  total.reports += 1;

  if (usage.reasoning !== undefined) {
    total.reasoning += usage.reasoning;
    total.reasoningReports += 1;
  }
};

export const totalTokens = (usage: ReportedUsage): number =>
  usage.input + usage.output + usage.cacheRead + usage.cacheWrite;

/** The context a response was sent. Provider totals are not summed alike, so parts are used. */
const prompt = (usage: Usage): number => usage.input + usage.cacheRead + usage.cacheWrite;

/** Usage whose parts report a context; failed responses and empty prompts do not. */
const measured = (entry: SessionEntry): Usage | undefined => {
  if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
  const { stopReason, usage } = entry.message;

  return stopReason !== "aborted" && stopReason !== "error" && prompt(usage) > 0
    ? usage
    : undefined;
};

/** Output a later prompt carries: providers drop reasoning once a new user prompt arrives. */
const kept = (usage: Usage): number => Math.max(0, usage.output - (usage.reasoning ?? 0));

/**
 * Adds up every rise in the prompt size the run's responses report, from the last reported size
 * before the run (zero without one) to the last response's kept output. Compaction and edits
 * shrink the next prompt; a shrink adds nothing.
 */
const contextGrowth = (branch: readonly SessionEntry[], runStart: number): number => {
  let previous = 0;
  let growth = 0;
  let output = 0;

  for (const [index, entry] of branch.entries()) {
    const usage = measured(entry);

    if (!usage) continue;

    if (index < runStart) {
      previous = prompt(usage) + kept(usage);
      continue;
    }

    growth += Math.max(0, prompt(usage) - previous);
    previous = prompt(usage);
    output = kept(usage);
  }

  return growth + output;
};

/** codex-provider records compaction inside a turn as this custom entry, not a Pi compaction. */
const INLINE_COMPACTION = "codex-provider.checkpoint";

/**
 * Counts the run from `runStart` in raw branch entries, not projected context: edits/compaction
 * cannot erase spent usage. Earlier entries only supply the context the run started from.
 */
export const collectMetrics = (branch: readonly SessionEntry[], runStart = 0): Metrics => {
  const entries = branch.slice(runStart);
  const usage = emptyUsage();
  const models = new Set<string>();
  let toolCalls = 0;
  let toolErrors = 0;
  let responses = 0;
  let compactions = 0;

  for (const entry of entries) {
    if (entry.type === "message") {
      const message = entry.message;

      if (message.role === "assistant") {
        responses += 1;
        addUsage(usage, message.usage);
        models.add(`${message.provider}/${message.responseModel ?? message.model}`);
        toolCalls += message.content.filter((block) => block.type === "toolCall").length;
      } else if (message.role === "toolResult") {
        if (message.isError) toolErrors += 1;

        if (message.usage) addUsage(usage, message.usage);
      }
    } else if (entry.type === "usage") {
      addUsage(usage, entry.usage);
      models.add(`${entry.provider}/${entry.model}`);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (entry.type === "compaction") compactions += 1;

      if (entry.usage) addUsage(usage, entry.usage);
    } else if (entry.type === "custom" && entry.customType === INLINE_COMPACTION) {
      compactions += 1;
    }
  }

  return {
    usage,
    toolCalls,
    toolErrors,
    responses,
    compactions,
    models: [...models],
    contextGrowth: contextGrowth(branch, runStart),
  };
};
