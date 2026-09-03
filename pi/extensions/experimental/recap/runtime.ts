import { randomUUID } from "node:crypto";

import { contentText } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getRecapConfigPath, loadRecapConfig } from "./config.js";
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
export const RECAP_RETRY_DELAY_MS = 30_000;

interface RecapSnapshot {
  progress: ConversationProgress;
  prompt: string;
}

interface RecapSessionState {
  inFlight?: AbortController;
  model?: Model<Api>;
  retryTimer?: ReturnType<typeof setTimeout>;
  sessionId: string;
}

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
    clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
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
      state.retryTimer !== undefined ||
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

    void this.#generate(ctx, { progress, prompt }, 0);
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

  async #generate(ctx: ExtensionContext, snapshot: RecapSnapshot, attempt: 0 | 1): Promise<void> {
    const state = this.#state;
    if (state?.model === undefined) {
      return;
    }

    const controller = new AbortController();
    state.inFlight = controller;
    const model = state.model;
    const timeout = setTimeout(() => {
      controller.abort(new Error("Recap request timed out"));
    }, RECAP_REQUEST_TIMEOUT_MS);

    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      });
      const response = await Promise.race([
        ctx.modelRegistry.complete(
          model,
          {
            messages: [
              {
                content: [{ text: snapshot.prompt, type: "text" }],
                role: "user",
                timestamp: Date.now(),
              },
            ],
          },
          {
            cacheRetention: "none",
            maxTokens: Math.min(model.maxTokens, 4096),
            sessionId: randomUUID(),
            signal: controller.signal,
            timeoutMs: RECAP_REQUEST_TIMEOUT_MS,
          },
        ),
        aborted,
      ]);
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
      if (attempt === 0 && this.#isFresh(ctx, snapshot)) {
        this.#scheduleRetry(ctx, snapshot);
      } else if (attempt === 1 && this.#isFresh(ctx, snapshot)) {
        state.model = undefined;
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(
          safeNotification(
            `Recap disabled (${this.#configPath}) after repeated generation failures`,
            message,
          ),
          "warning",
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  #scheduleRetry(ctx: ExtensionContext, snapshot: RecapSnapshot): void {
    const state = this.#state;
    if (state === undefined || state.retryTimer !== undefined) {
      return;
    }

    const timer = setTimeout(() => {
      if (this.#state !== state || state.retryTimer !== timer) {
        return;
      }
      state.retryTimer = undefined;
      if (this.#isFresh(ctx, snapshot)) {
        void this.#generate(ctx, snapshot, 1);
      }
    }, RECAP_RETRY_DELAY_MS);
    state.retryTimer = timer;
  }
}

export const createRecapRuntime = (
  pi: ExtensionAPI,
  configPath = getRecapConfigPath(),
): RecapRuntime => new RecapRuntime(pi, configPath);
