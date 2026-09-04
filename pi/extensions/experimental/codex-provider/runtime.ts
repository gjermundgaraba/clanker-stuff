import path from "node:path";

import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import type { Model } from "@earendil-works/pi-ai";
import type {
  BeforeProviderHeadersEvent,
  BeforeProviderRequestEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionEvent,
  MessageEndEvent,
  SessionBeforeCompactEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";

import { branchNeedsCodex } from "./checkpoint-marker.js";
import { requestCollaborationContract } from "./collaboration.js";
import { createFastModeConfigStore, createFastModeState } from "./fast-mode.js";
import type { createCodexLifecycle } from "./lifecycle.js";
import { createCodexModelCatalog } from "./model-catalog.js";

type CodexLifecycle = ReturnType<typeof createCodexLifecycle>;
type ModelSelectEvent = Extract<ExtensionEvent, { type: "model_select" }>;

const isCodexModel = (model: Model<string> | undefined): boolean =>
  model?.provider === "openai-codex" && model.api === "openai-codex-responses";

export const createCodexRuntime = (
  pi: ExtensionAPI,
  setFastFooterActive: (active: boolean) => void,
) => {
  const storage = getExtensionStoragePaths("codex-provider");
  const catalog = createCodexModelCatalog(() => {
    pi.events.emit("clanker-codex:account-changed", null);
  });
  const fastMode = createFastModeState(
    pi,
    createFastModeConfigStore(storage.configFile),
    setFastFooterActive,
  );
  let agentRunActive = false;
  let fastContext: ExtensionContext | undefined;
  let pendingModelSelection: { ctx: ExtensionContext; event: ModelSelectEvent } | undefined;
  let pendingStart: ExtensionContext | undefined;
  const applyInheritedFastMode = (ctx: ExtensionContext, publish = false): void => {
    fastContext = ctx;
    const contract = requestCollaborationContract(
      pi,
      ctx,
      undefined,
      publish ? fastMode.localServiceTier() : undefined,
    );
    if (contract?.inheritedServiceTier !== undefined) {
      fastMode.setInheritedServiceTier(contract.inheritedServiceTier);
    }
  };
  const isFastModeEnabled = (): boolean => {
    if (fastContext !== undefined) {
      applyInheritedFastMode(fastContext);
    }
    return fastMode.isEnabled();
  };

  const codex = createLazySingleton<CodexLifecycle>(
    async (signal) => {
      const [{ createCodexLifecycle }, { CodexObservability }] = await Promise.all([
        import("./lifecycle.js"),
        import("./observability.js"),
      ]);
      signal.throwIfAborted();
      return createCodexLifecycle(
        pi,
        new CodexObservability(path.join(storage.dataDir, "codex-provider.sqlite")),
        isFastModeEnabled,
        catalog,
      );
    },
    (loaded) => {
      if (pendingStart !== undefined) {
        const ctx = pendingStart;
        pendingStart = undefined;
        loaded.start(ctx);
      }
      if (pendingModelSelection !== undefined) {
        const selection = pendingModelSelection;
        pendingModelSelection = undefined;
        loaded.modelSelect(selection.event, selection.ctx);
      }
    },
  );
  const requireCodex = async (): Promise<CodexLifecycle> => {
    const loaded = await codex.load();
    if (loaded === undefined) {
      throw new Error("Codex provider is unavailable after shutdown");
    }
    return loaded;
  };
  const maybeLoad = async (required: () => boolean): Promise<CodexLifecycle | undefined> =>
    codex.get() ?? (codex.isLoading() || required() ? await codex.load() : undefined);
  const refreshFastStatus = (ctx: ExtensionContext): void => {
    fastMode.refresh(ctx, catalog.supportsFastMode);
  };

  return {
    agentEnd: (): void => {
      agentRunActive = false;
    },
    agentStart: (): void => {
      agentRunActive = true;
    },
    agentSettled: (ctx: ExtensionContext): void => {
      agentRunActive = false;
      codex.get()?.settled(ctx);
    },
    beforeAgentStart: async (ctx: ExtensionContext): Promise<void> => {
      applyInheritedFastMode(ctx, true);
      const loaded = await maybeLoad(() => isCodexModel(ctx.model));
      loaded?.beforeAgentStart(ctx);
    },
    beforeCompact: async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
      applyInheritedFastMode(ctx, true);
      const loaded = await maybeLoad(
        () => isCodexModel(ctx.model) || branchNeedsCodex(event.branchEntries),
      );
      return await loaded?.beforeCompact(event, ctx, agentRunActive);
    },
    beforeProviderHeaders: async (
      event: BeforeProviderHeadersEvent,
      ctx: ExtensionContext,
    ): Promise<void> => {
      const loaded = await maybeLoad(() => isCodexModel(ctx.model));
      loaded?.beforeProviderHeaders(event, ctx);
    },
    beforeProviderRequest: async (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => {
      const loaded = await maybeLoad(() => isCodexModel(ctx.model));
      return await loaded?.beforeProviderRequest(event, ctx);
    },
    catalog,
    command: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const loaded = await codex.load();
      await loaded?.runCommand(args, ctx);
    },
    context: async (event: ContextEvent, ctx: ExtensionContext) => {
      const loaded = await maybeLoad(
        () => isCodexModel(ctx.model) || branchNeedsCodex(ctx.sessionManager.getBranch()),
      );
      return loaded?.context(event, ctx);
    },
    fast: async (ctx: ExtensionCommandContext): Promise<void> => {
      await fastMode.toggle(ctx);
      applyInheritedFastMode(ctx, true);
      if (!codex.isStopped()) {
        refreshFastStatus(ctx);
      }
    },
    loadProvider: async () => {
      const loaded = await requireCodex();
      return loaded.provider;
    },
    messageEnd: (event: MessageEndEvent, ctx: ExtensionContext): void => {
      codex.get()?.messageEnd(event, ctx);
    },
    modelSelect: (event: ModelSelectEvent, ctx: ExtensionContext): void => {
      applyInheritedFastMode(ctx);
      const loaded = codex.get();
      if (loaded === undefined) {
        pendingModelSelection = { ctx, event };
      } else {
        loaded.modelSelect(event, ctx);
      }
      refreshFastStatus(ctx);
    },
    sessionCompact: (event: SessionCompactEvent, ctx: ExtensionContext): void => {
      codex.get()?.compact(event, ctx);
    },
    sessionCompactFailed: (): void => {
      codex.get()?.compactFailed();
    },
    sessionStart: async (ctx: ExtensionContext, startup: boolean): Promise<void> => {
      agentRunActive = false;
      const loaded = codex.get();
      if (loaded === undefined) {
        pendingStart = ctx;
        pendingModelSelection = undefined;
      } else {
        loaded.start(ctx);
      }
      await fastMode.start(ctx, startup);
      applyInheritedFastMode(ctx, true);
      if (!codex.isStopped()) {
        refreshFastStatus(ctx);
      }
    },
    shutdown: async (ctx: ExtensionContext): Promise<void> => {
      agentRunActive = false;
      fastMode.stop();
      fastContext = undefined;
      pendingStart = undefined;
      pendingModelSelection = undefined;
      await codex.stop((loaded) => {
        loaded.shutdown(ctx);
      });
    },
  };
};
