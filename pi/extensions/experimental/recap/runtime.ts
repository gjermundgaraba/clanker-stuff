import { randomUUID } from "node:crypto";

import { clampThinkingLevel, contentText, isContextOverflow } from "@earendil-works/pi-ai";
import type { Api, Context, Model, SimpleStreamOptions, UserMessage } from "@earendil-works/pi-ai";
import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getRecapConfigPath, loadRecapConfig } from "./config.js";
import type { RecapConfig } from "./config.js";
import {
  buildRecapPrompt,
  conversationProgress,
  normalizeRecap,
  shouldGenerateRecap,
} from "./conversation.js";
import type { ConversationProgress } from "./conversation.js";
import { RECAP_ENTRY_TYPE, sanitizeRecapText } from "./entry.js";
import type { RecapEntryData } from "./entry.js";

export const RECAP_REQUEST_TIMEOUT_MS = 30_000;

interface RecapSnapshot {
  progress: ConversationProgress;
  prompt: string;
}

interface RecapSessionState {
  inFlight?: AbortController;
  model?: Model<Api>;
  lastUnsuccessful?: RecapSnapshot;
  sessionId: string;
  thinking?: RecapConfig["thinking"];
}

// ModelRegistry.complete takes native API options, not provider-neutral reasoning.
// Use the registered provider's simple adapter when thinking is explicitly configured.
const completeWithThinking = async (
  ctx: ExtensionContext,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  thinking: NonNullable<RecapConfig["thinking"]>,
) => {
  const provider = ctx.modelRegistry.getProvider(model.provider);
  if (provider === undefined) {
    throw new Error(`Provider ${model.provider} was not found by Pi`);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }
  options.signal?.throwIfAborted();
  const level = clampThinkingLevel(model, thinking);
  return await provider
    .streamSimple(auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model, context, {
      ...options,
      apiKey: auth.apiKey,
      env: auth.env,
      headers: auth.headers,
      reasoning: level === "off" ? undefined : level,
    })
    .result();
};

const safeNotification = (prefix: string, message: string): string =>
  sanitizeRecapText(`${prefix}: ${message}`).trim();

class RecapRuntime {
  readonly #configPath: string;
  readonly #pi: ExtensionAPI;
  #state: RecapSessionState | undefined;

  constructor(pi: ExtensionAPI, configPath: string) {
    this.#pi = pi;
    this.#configPath = configPath;
  }

  async start(ctx: ExtensionContext): Promise<void> {
    this.dispose();

    const sessionId = ctx.sessionManager.getSessionId();
    const state: RecapSessionState = { sessionId };
    this.#state = state;

    try {
      const config = await loadRecapConfig(this.#configPath);
      const model = ctx.modelRegistry.find(config.model.provider, config.model.id);
      if (model === undefined) {
        throw new Error(`Model ${config.model.provider}/${config.model.id} was not found by Pi`);
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        throw new Error(auth.error);
      }
      if (this.#state !== state || ctx.sessionManager.getSessionId() !== sessionId) {
        return;
      }
      state.model = model;
      state.thinking = config.thinking;
    } catch (error) {
      if (this.#state !== state || ctx.sessionManager.getSessionId() !== sessionId) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(safeNotification(`Recap disabled (${this.#configPath})`, message), "error");
    }
  }

  cancel(): void {
    const state = this.#state;
    if (state === undefined) {
      return;
    }
    const inFlight = state.inFlight;
    state.inFlight = undefined;
    inFlight?.abort();
  }

  dispose(): void {
    this.cancel();
    this.#state = undefined;
  }

  settled(ctx: ExtensionContext): void {
    const state = this.#state;
    if (
      state?.model === undefined ||
      state.inFlight !== undefined ||
      state.sessionId !== ctx.sessionManager.getSessionId() ||
      !ctx.isIdle()
    ) {
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const progress = conversationProgress(branch);
    if (!shouldGenerateRecap(progress)) {
      return;
    }
    const prompt = buildRecapPrompt(ctx.sessionManager.buildContextEntries());
    if (prompt === undefined) {
      return;
    }

    if (
      state.lastUnsuccessful?.progress.sourceRevision === progress.sourceRevision &&
      state.lastUnsuccessful?.prompt === prompt
    ) {
      return;
    }

    void this.#generate(ctx, { progress, prompt });
  }

  #isFresh(ctx: ExtensionContext, snapshot: RecapSnapshot): boolean {
    const state = this.#state;
    if (
      state === undefined ||
      ctx.sessionManager.getSessionId() !== state.sessionId ||
      !ctx.isIdle()
    ) {
      return false;
    }

    const branch = ctx.sessionManager.getBranch();
    const progress = conversationProgress(branch);
    return (
      progress.sourceRevision === snapshot.progress.sourceRevision &&
      buildRecapPrompt(ctx.sessionManager.buildContextEntries()) === snapshot.prompt
    );
  }

  async #generate(ctx: ExtensionContext, snapshot: RecapSnapshot): Promise<void> {
    const state = this.#state;
    if (state?.model === undefined) {
      return;
    }

    const controller = new AbortController();
    state.inFlight = controller;
    const model = state.model;
    const thinking = state.thinking;
    const timeout = setTimeout(() => {
      controller.abort(new Error("Recap request timed out"));
    }, RECAP_REQUEST_TIMEOUT_MS);

    try {
      const message: UserMessage = {
        content: [{ text: snapshot.prompt, type: "text" }],
        role: "user",
        timestamp: Date.now(),
      };
      // A heuristic preflight only; provider overflow can still occur below this estimate.
      const estimatedTokens = estimateTokens(message);
      if (model.contextWindow > 0 && estimatedTokens >= model.contextWindow) {
        throw new Error(
          `Estimated input (${estimatedTokens} tokens) reaches or exceeds ${model.provider}/${model.id}'s context window (${model.contextWindow} tokens)`,
        );
      }
      const context: Context = { messages: [message] };
      const options: SimpleStreamOptions = {
        cacheRetention: "none",
        sessionId: randomUUID(),
        signal: controller.signal,
        timeoutMs: RECAP_REQUEST_TIMEOUT_MS,
      };
      const response = await raceWithAbortSignal(
        thinking === undefined
          ? ctx.modelRegistry.complete(model, context, options)
          : completeWithThinking(ctx, model, context, options, thinking),
        controller.signal,
      );
      if (isContextOverflow(response, model.contextWindow)) {
        throw new Error("Recap input exceeds the model's context window");
      }
      if (response.stopReason !== "stop") {
        throw new Error(response.errorMessage ?? `Recap model stopped with ${response.stopReason}`);
      }
      const recap = normalizeRecap(contentText(response.content));
      if (recap === undefined) {
        throw new Error("Recap model returned no text");
      }

      const state = this.#state;
      if (state?.inFlight !== controller) {
        return;
      }
      if (!this.#isFresh(ctx, snapshot)) {
        state.inFlight = undefined;
        return;
      }

      const entry: RecapEntryData = {
        completedTurns: snapshot.progress.completedTurns,
        recap,
      };
      this.#pi.appendEntry(RECAP_ENTRY_TYPE, entry);
      state.inFlight = undefined;
    } catch (error) {
      const state = this.#state;
      if (state?.inFlight !== controller) {
        return;
      }
      state.inFlight = undefined;
      if (this.#isFresh(ctx, snapshot)) {
        state.lastUnsuccessful = snapshot;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(safeNotification("Recap skipped", message), "warning");
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const createRecapRuntime = (
  pi: ExtensionAPI,
  configPath = getRecapConfigPath(),
): RecapRuntime => new RecapRuntime(pi, configPath);
