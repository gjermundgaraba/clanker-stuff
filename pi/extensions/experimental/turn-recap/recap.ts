import { randomUUID } from "node:crypto";

import { clampThinkingLevel, contentText, isContextOverflow } from "@earendil-works/pi-ai";
import type { UserMessage } from "@earendil-works/pi-ai";
// Package imports avoid Pi's Jiti root alias swallowing pi-ai subpaths.
import { raceWithAbortSignal } from "#pi-abort";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { RecapConfig } from "./config.js";
import { normalizeRecap, sanitizeRecapText } from "./conversation.js";
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
  const controller = new AbortController();
  const signal = AbortSignal.any([parentSignal, controller.signal]);

  const timeout = setTimeout(() => {
    controller.abort(new Error("Recap request timed out"));
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

    const response = await raceWithAbortSignal(
      ctx.modelRegistry
        .streamSimple(
          model,
          { messages: [message] },
          {
            cacheRetention: "none",
            sessionId: randomUUID(),
            signal,
            timeoutMs: RECAP_REQUEST_TIMEOUT_MS,
            ...(level === "off" ? {} : { reasoning: level }),
          },
        )
        .result(),
      signal,
    );

    usage = emptyUsage();
    addUsage(usage, response.usage);

    if (isContextOverflow(response, model.contextWindow)) {
      throw new Error("Recap input exceeds the model's context window");
    }

    if (response.stopReason !== "stop") {
      throw new Error(response.errorMessage ?? `Recap model stopped with ${response.stopReason}`);
    }

    const text = normalizeRecap(contentText(response.content));

    if (text === undefined) throw new Error("Recap model returned no text");

    return { status: "ready", text, usage };
  } catch (error) {
    return {
      status: "failed",
      error: sanitizeRecapText(error instanceof Error ? error.message : String(error)),
      ...(usage === undefined ? {} : { usage }),
    };
  } finally {
    clearTimeout(timeout);
  }
};
