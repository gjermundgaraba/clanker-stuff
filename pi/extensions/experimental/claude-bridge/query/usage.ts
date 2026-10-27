// Claude Code's SDK usage counters mapped onto pi's AssistantMessage.

import { calculateCost } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

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
}

interface UsageReport {
  /** Cache-read share of the prompt as a whole percentage; 0 for an empty prompt. */
  cachePct: number;
  /** Thinking tokens carried by this frame, absent when it carried none. */
  reasoning?: number;
}

/** Applies one SDK usage frame onto `output.usage`, then recomputes the total and cost.
 *  Counters the frame omits keep their previous value, so a partial frame never zeroes
 *  what an earlier one set. */
export const updateUsage = (
  output: AssistantMessage,
  usage: SdkUsage,
  model: Model<Api>
): UsageReport => {
  if (usage.input_tokens !== null && usage.input_tokens !== undefined) {
    output.usage.input = usage.input_tokens;
  }

  if (usage.output_tokens !== null && usage.output_tokens !== undefined) {
    output.usage.output = usage.output_tokens;
  }

  if (
    usage.cache_read_input_tokens !== null &&
    usage.cache_read_input_tokens !== undefined
  ) {
    output.usage.cacheRead = usage.cache_read_input_tokens;
  }

  if (
    usage.cache_creation_input_tokens !== null &&
    usage.cache_creation_input_tokens !== undefined
  ) {
    output.usage.cacheWrite = usage.cache_creation_input_tokens;
  }

  // A subset of output_tokens, never a separate addend in the total or in cost.
  const reasoning = usage.output_tokens_details?.thinking_tokens;

  if (reasoning !== null && reasoning !== undefined) {
    output.usage.reasoning = reasoning;
  }

  output.usage.totalTokens =
    output.usage.input +
    output.usage.output +
    output.usage.cacheRead +
    output.usage.cacheWrite;
  calculateCost(model, output.usage);

  const promptTokens =
    output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;

  return {
    cachePct:
      promptTokens > 0
        ? Math.round((output.usage.cacheRead / promptTokens) * 100)
        : 0,
    ...(reasoning === null || reasoning === undefined ? {} : { reasoning }),
  };
};

export const recordUsage = (
  output: AssistantMessage,
  usage: SdkUsage,
  model: Model<Api>
): void => {
  const { cachePct, reasoning } = updateUsage(output, usage, model);

  debug(
    `usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoning === undefined ? "" : ` reasoning=${reasoning}`} cachePct=${cachePct}% model=${model.id}`
  );
};
