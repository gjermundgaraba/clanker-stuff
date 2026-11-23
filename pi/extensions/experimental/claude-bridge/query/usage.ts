import { calculateCost } from "@earendil-works/pi-ai";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";

import { debug } from "../log.js";

/** The usage counters Claude Code reports. Every field is optional because
 *  `message_start`, `message_delta` and a complete assistant message each carry a
 *  different subset. */
export interface SdkUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
  /** The split of `cache_creation_input_tokens` by retention; Claude Code writes 1h. */
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
}

interface UsageReport {
  cachePct: number;
  reasoning?: number;
}

const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const present = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined;

const overwriteCarriedCounters = (usage: Usage, frame: SdkUsage): void => {
  if (present(frame.input_tokens)) {
    usage.input = frame.input_tokens;
  }

  if (present(frame.output_tokens)) {
    usage.output = frame.output_tokens;
  }

  if (present(frame.cache_read_input_tokens)) {
    usage.cacheRead = frame.cache_read_input_tokens;
  }

  if (present(frame.cache_creation_input_tokens)) {
    usage.cacheWrite = frame.cache_creation_input_tokens;
  }

  const oneHourCacheWrite = frame.cache_creation?.ephemeral_1h_input_tokens;

  if (present(oneHourCacheWrite)) {
    usage.cacheWrite1h = oneHourCacheWrite;
  }

  const reasoning = frame.output_tokens_details?.thinking_tokens;

  if (present(reasoning)) {
    usage.reasoning = reasoning;
  }

  usage.totalTokens =
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
};

const addOptional = (
  sum: number | undefined,
  value: number | undefined
): number | undefined => (value === undefined ? sum : (sum ?? 0) + value);

/** The usage of one pi assistant message, which can span several Claude Code API
 *  requests: a stalled stream and its non-streaming retry, or a call to a tool the query
 *  does not serve, which Claude Code answers itself before asking again. Each request is
 *  kept under its API message id, so a repeated frame updates its request rather than
 *  counting it twice, and is priced on its own, since a pricing tier depends on one
 *  request's prompt. */
export class MessageUsage {
  private readonly requests = new Map<string, Usage>();

  private readonly model: Model<Api>;

  constructor(model: Model<Api>) {
    this.model = model;
  }

  /** Applies a frame to request `id`, then writes the sum of every request onto
   *  `target`. Counters a frame omits keep their previous value, so a partial frame never
   *  zeroes what an earlier one set. Tokens and costs are what was billed; `totalTokens`
   *  stays the latest request's prompt plus output, since pi reads it as the context
   *  size. */
  record(target: Usage, id: string, frame: SdkUsage): UsageReport {
    let request = this.requests.get(id);

    if (request === undefined) {
      request = emptyUsage();
      this.requests.set(id, request);
    }

    overwriteCarriedCounters(request, frame);
    calculateCost(this.model, request);

    const sum = emptyUsage();
    let latest = request;

    for (const usage of this.requests.values()) {
      sum.input += usage.input;
      sum.output += usage.output;
      sum.cacheRead += usage.cacheRead;
      sum.cacheWrite += usage.cacheWrite;
      sum.cost.input += usage.cost.input;
      sum.cost.output += usage.cost.output;
      sum.cost.cacheRead += usage.cost.cacheRead;
      sum.cost.cacheWrite += usage.cost.cacheWrite;
      sum.cost.total += usage.cost.total;

      const cacheWrite1h = addOptional(sum.cacheWrite1h, usage.cacheWrite1h);
      const reasoning = addOptional(sum.reasoning, usage.reasoning);

      if (cacheWrite1h !== undefined) {
        sum.cacheWrite1h = cacheWrite1h;
      }

      if (reasoning !== undefined) {
        sum.reasoning = reasoning;
      }

      latest = usage;
    }

    sum.totalTokens = latest.totalTokens;
    Object.assign(target, sum);

    const promptTokens = latest.input + latest.cacheRead + latest.cacheWrite;
    const reasoning = frame.output_tokens_details?.thinking_tokens;

    const cachePct =
      promptTokens > 0
        ? Math.round((latest.cacheRead / promptTokens) * 100)
        : 0;

    debug(
      `usage: request=${id} in=${target.input} out=${target.output} cacheRead=${target.cacheRead} cacheWrite=${target.cacheWrite} total=${target.totalTokens}${present(reasoning) ? ` reasoning=${reasoning}` : ""} cachePct=${cachePct}% model=${this.model.id}`
    );

    return { cachePct, ...(present(reasoning) ? { reasoning } : {}) };
  }
}
