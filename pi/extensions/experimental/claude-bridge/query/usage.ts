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

const resetUsage = (usage: Usage): void => {
  Object.assign(usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  delete usage.cacheWrite1h;
  delete usage.reasoning;
};

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

/** The usage of one pi assistant message, which reports its last Claude Code API
 *  request. A message can span several: a stalled stream and its non-streaming retry, or
 *  a call to a tool the query does not serve, which Claude Code answers itself before
 *  asking again. pi reads a message's usage as one request's prompt, for its cache
 *  warmer, cache-miss detection and footer, so an earlier request's tokens and cost are
 *  not counted. */
export class MessageUsage {
  private request: string | undefined;

  private readonly model: Model<Api>;

  constructor(model: Model<Api>) {
    this.model = model;
  }

  /** Applies a frame from request `id`, by default the request the last frame came
   *  from, onto `target` and prices it. A frame from another request replaces the usage;
   *  counters a frame omits keep their previous value, so a partial frame never zeroes
   *  what an earlier one of the same request set. */
  record(target: Usage, frame: SdkUsage, id = this.request): void {
    if (id !== this.request) {
      resetUsage(target);
      this.request = id;
    }

    overwriteCarriedCounters(target, frame);
    calculateCost(this.model, target);

    const promptTokens = target.input + target.cacheRead + target.cacheWrite;
    const reasoning = frame.output_tokens_details?.thinking_tokens;

    const cachePct =
      promptTokens > 0
        ? Math.round((target.cacheRead / promptTokens) * 100)
        : 0;

    debug(
      `usage: request=${id ?? "unknown"} in=${target.input} out=${target.output} cacheRead=${target.cacheRead} cacheWrite=${target.cacheWrite} total=${target.totalTokens}${present(reasoning) ? ` reasoning=${reasoning}` : ""} cachePct=${cachePct}% model=${this.model.id}`
    );
  }
}
