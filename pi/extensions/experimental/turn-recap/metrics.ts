import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai";
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
  closed
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
    contextGrowth: count,
    modelMs: amount,
    toolMs: amount,
    context: Type.Optional(
      Type.Object(
        {
          tokens: Type.Union([count, Type.Null()]),
          contextWindow: amount,
          percent: Type.Union([amount, Type.Null()]),
        },
        closed
      )
    ),
  },
  closed
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

const prompt = (usage: Usage): number =>
  usage.input + usage.cacheRead + usage.cacheWrite;

const measured = (entry: SessionEntry): Usage | undefined => {
  if (entry.type !== "message" || entry.message.role !== "assistant") {
    return undefined;
  }

  const { stopReason, usage } = entry.message;

  return stopReason !== "aborted" && stopReason !== "error" && prompt(usage) > 0
    ? usage
    : undefined;
};

const kept = (usage: Usage): number =>
  Math.max(0, usage.output - (usage.reasoning ?? 0));

const contextGrowth = (
  branch: readonly SessionEntry[],
  runStart: number
): number => {
  let previous = 0;
  let growth = 0;
  let output = 0;

  for (const [index, entry] of branch.entries()) {
    const usage = measured(entry);

    if (!usage) {
      continue;
    }

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

const toolTime = (results: readonly ToolResultMessage[]): number => {
  const spans = results
    .flatMap(({ durationMs, timestamp }) =>
      durationMs === undefined
        ? []
        : [{ start: timestamp - durationMs, end: timestamp }]
    )
    .toSorted((a, b) => a.start - b.start);

  let total = 0;
  let reached = -Infinity;

  for (const { start, end } of spans) {
    total += Math.max(0, end - Math.max(start, reached));
    reached = Math.max(reached, end);
  }

  return total;
};

export const collectMetrics = (
  branch: readonly SessionEntry[],
  runStart = 0
): Metrics => {
  const entries = branch.slice(runStart);
  const usage = emptyUsage();
  const models = new Set<string>();
  let toolCalls = 0;
  let toolErrors = 0;
  let responses = 0;
  let compactions = 0;
  let modelMs = 0;
  const toolResults: ToolResultMessage[] = [];

  for (const entry of entries) {
    if (entry.type === "message") {
      const { message } = entry;

      if (message.role === "assistant") {
        responses += 1;
        modelMs += message.durationMs ?? 0;
        addUsage(usage, message.usage);
        models.add(
          `${message.provider}/${message.responseModel ?? message.model}`
        );
        toolCalls += message.content.filter(
          (block) => block.type === "toolCall"
        ).length;
      } else if (message.role === "toolResult") {
        toolResults.push(message);

        if (message.isError) {
          toolErrors += 1;
        }

        const nested = message.nestedCalls?.calls ?? [];
        toolCalls += nested.length;
        toolErrors += nested.filter((call) => call.status === "error").length;

        if (message.usage) {
          addUsage(usage, message.usage);
        }
      }
    } else if (entry.type === "usage") {
      addUsage(usage, entry.usage);
      models.add(`${entry.provider}/${entry.model}`);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (entry.type === "compaction") {
        compactions += 1;
      }

      if (entry.usage) {
        addUsage(usage, entry.usage);
      }
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
    modelMs,
    toolMs: toolTime(toolResults),
  };
};
