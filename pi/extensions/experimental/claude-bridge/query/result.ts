// What a Claude Code query's result and rate-limit messages mean for the turn they end.

import type { Api, Model } from "@earendil-works/pi-ai";
import type { SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { debug } from "../log.js";

export interface RateLimitRejection {
  rateLimitType?: SDKRateLimitInfo["rateLimitType"];
  resetsAt?: number;
}

/** Failure text for an SDK result, or undefined when it succeeded. Claude Code reports
 *  API failures (429 capacity, overload, prompt-too-long) with `is_error` on an otherwise
 *  success-shaped result; the dedicated error subtypes carry `errors` instead. */
export function resultErrorText(message: SDKResultMessage): string | undefined {
  if (message.subtype === "success") {
    return message.is_error ? message.result || "Claude Code reported an error" : undefined;
  }

  if (message.errors.length > 0) return message.errors.join("\n");

  return `Claude Code failed: ${message.subtype}`;
}

/** Names a failure as a rate limit when a rejection preceded it.
 *
 *  Pi has no typed rate-limit error, so whatever reacts to one (fallback models, key
 *  rotation) pattern-matches `errorMessage`. Claude Code words a spent subscription as
 *  "You're out of extra usage · resets 6:30pm", which matches none of those patterns.
 *  Leading with "Claude quota exceeded — rate limit" keeps both phrases in a truncated
 *  render, and "quota exceeded" is on pi-ai's non-retryable list (winning over its
 *  retryable "rate limit"), so pi hands a window that resets in hours straight to
 *  fallback instead of retrying it. */
export function describeRateLimitFailure(rejection: RateLimitRejection, failure: string): string {
  const kind = rejection.rateLimitType === undefined ? "" : ` (${rejection.rateLimitType})`;

  // resetsAt is Unix seconds (observed; the SDK leaves the unit undocumented).
  const resets =
    rejection.resetsAt === undefined
      ? ""
      : ` — resets ${new Date(rejection.resetsAt * 1000).toLocaleTimeString()}`;

  return `Claude quota exceeded — rate limit${kind}${resets}: ${failure}`;
}

/** The rejection a rate-limit event reports, or undefined when it reports none. */
export function rateLimitRejection(info: SDKRateLimitInfo): RateLimitRejection | undefined {
  if (info.status !== "rejected") return undefined;

  return {
    ...(info.rateLimitType === undefined ? {} : { rateLimitType: info.rateLimitType }),
    ...(info.resetsAt === undefined ? {} : { resetsAt: info.resetsAt }),
  };
}

/** The notice a rejection raises once. */
export function rateLimitNotice(rejection: RateLimitRejection): string {
  const resetsAt =
    rejection.resetsAt === undefined
      ? "unknown"
      : new Date(rejection.resetsAt * 1000).toLocaleTimeString();

  return `Claude subscription rate limit reached (${rejection.rateLimitType ?? "unknown"}); resets at ${resetsAt}`;
}

// The window Claude Code actually served, which can differ from the one pi registered
// when the runtime entitlement does not match the docs.
export function logServedContextWindow(
  label: string,
  message: SDKResultMessage,
  model: Model<Api>,
): void {
  for (const [servedModel, usage] of Object.entries(message.modelUsage)) {
    debug(
      `${label}: served contextWindow=${usage.contextWindow} maxOutputTokens=${usage.maxOutputTokens} servedModel=${servedModel} registered=${model.contextWindow}`,
    );
  }
}
