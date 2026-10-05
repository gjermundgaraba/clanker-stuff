import { randomUUID } from "node:crypto";

import { clampThinkingLevel, contentText } from "@earendil-works/pi-ai";
import type { UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RecapConfig } from "./config.js";
import { errorText, normalizeRecap } from "./conversation.js";
import type { Recap } from "./entry.js";
import { addUsage, emptyUsage } from "./metrics.js";
import type { ReportedUsage } from "./metrics.js";

export const RECAP_REQUEST_TIMEOUT_MS = 30_000;

export const generateRecap = async (
  ctx: ExtensionContext,
  config: RecapConfig,
  prompt: string,
  parentSignal: AbortSignal,
): Promise<Recap> => {
  const deadline = new AbortController();
  const signal = AbortSignal.any([parentSignal, deadline.signal]);
  // Removes the abort listener below once the request settles either way.
  const settled = new AbortController();

  const timeout = setTimeout(() => {
    deadline.abort(new Error("Recap request timed out"));
  }, RECAP_REQUEST_TIMEOUT_MS);

  let usage: ReportedUsage | undefined;

  try {
    const model = ctx.modelRegistry.find(config.model.provider, config.model.id);

    if (model === undefined) {
      throw new Error(`Model ${config.model.provider}/${config.model.id} was not found by Pi`);
    }

    const message: UserMessage = {
      content: [{ text: prompt, type: "text" }],
      role: "user",
      timestamp: Date.now(),
    };

    const level = clampThinkingLevel(model, config.thinking);

    // Stop waiting once aborted, even for a provider that ignores cancellation. This listener
    // runs before the provider's, so an abort always reports its own cause. Promise.race handles
    // this rejection, so an abort after the response is not an unhandled rejection.
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
        signal: settled.signal,
      });
    });

    const response = await Promise.race([
      ctx.modelRegistry
        .streamSimple(
          model,
          { messages: [message] },
          {
            cacheRetention: "none",
            sessionId: randomUUID(),
            signal,
            ...(level === "off" ? {} : { reasoning: level }),
          },
        )
        .result(),
      aborted,
    ]);

    usage = emptyUsage();
    addUsage(usage, response.usage);

    if (response.stopReason !== "stop") {
      throw new Error(response.errorMessage ?? `Recap model stopped with ${response.stopReason}`);
    }

    const text = normalizeRecap(contentText(response.content));

    if (text === undefined) throw new Error("Recap model returned no text");

    return { status: "ready", text, usage };
  } catch (error) {
    return {
      status: "failed",
      error: errorText(error),
      ...(usage === undefined ? {} : { usage }),
    };
  } finally {
    clearTimeout(timeout);
    settled.abort();
  }
};
