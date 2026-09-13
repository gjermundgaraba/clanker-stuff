import { raceWithAbortSignal } from "@earendil-works/pi-ai/utils/abort";
import { AsyncLocalStorage } from "node:async_hooks";
import { pathToFileURL } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/client";
import { elicitationParamsSchema } from "./elicitation-schema.js";
import { elicit } from "./interactions.js";
import { sample } from "./sampling.js";
import type { SamplingUsage } from "./sampling.js";

export interface McpCallContext {
  ctx: ExtensionContext;
  model: Model<Api> | undefined;
  signal: AbortSignal;
  reportUsage: (usage: SamplingUsage) => void;
}

/** Binds the SDK's continuation driver, including concurrent rounds, to its originating call. */
export class ContextClient extends Client {
  private readonly contexts = new Map<AbortSignal, McpCallContext>();
  private readonly current = new AsyncLocalStorage<McpCallContext>();
  private readonly work = new WeakMap<McpCallContext, Set<Promise<unknown>>>();
  private readonly urlCompletions = new Map<string, AbortController>();
  private legacyTail: Promise<unknown> = Promise.resolve();

  constructor(
    pi?: Pick<ExtensionAPI, "events">,
    serverName = "server",
    getWorkspace: () => string | undefined = () => undefined,
  ) {
    super(
      { name: "pi-mcp", version: "0.1.0" },
      {
        versionNegotiation: { mode: "auto" },
        capabilities: {
          roots: {},
          elicitation: { form: { applyDefaults: false }, url: {} },
          sampling: pi ? {} : undefined,
        },
      },
    );
    const originatingContext = () =>
      this.current.getStore() ??
      (this.contexts.size === 1 ? this.contexts.values().next().value : undefined);
    const context = () => {
      const owned = originatingContext();
      if (!owned) throw new Error("MCP input request has no unambiguous originating tool call");
      owned.signal.throwIfAborted();
      return owned;
    };
    this.setNotificationHandler("notifications/elicitation/complete", (notification) => {
      this.urlCompletions.get(notification.params.elicitationId)?.abort();
    });
    this.setRequestHandler("roots/list", async () => {
      const owned = originatingContext();
      owned?.signal.throwIfAborted();
      const workspace = owned ? owned.ctx.cwd : getWorkspace();
      return {
        roots: workspace ? [{ uri: pathToFileURL(workspace).href, name: "Workspace" }] : [],
      };
    });
    this.setRequestHandler(
      "elicitation/create",
      { params: elicitationParamsSchema },
      async (params, requestContext) => {
        const owned = context();
        const id = params.mode === "url" ? params.elicitationId : undefined;
        const completion = id ? new AbortController() : undefined;
        if (id && completion) this.urlCompletions.set(id, completion);
        try {
          return await this.track(owned, () =>
            elicit(
              owned.ctx,
              serverName,
              params,
              AbortSignal.any([owned.signal, requestContext.mcpReq.signal]),
              completion?.signal,
            ),
          );
        } finally {
          if (id) this.urlCompletions.delete(id);
        }
      },
    );
    if (pi)
      this.setRequestHandler("sampling/createMessage", async (request, requestContext) => {
        const owned = context();
        return await this.track(owned, () =>
          sample(
            pi,
            owned.ctx,
            owned.model,
            request.params,
            AbortSignal.any([owned.signal, requestContext.mcpReq.signal]),
            owned.reportUsage,
          ),
        );
      });
  }

  protected override _wrapHandler(
    ...[method, handler]: Parameters<Client["_wrapHandler"]>
  ): ReturnType<Client["_wrapHandler"]> {
    if (method !== "elicitation/create") return super._wrapHandler(method, handler);
    return async (request, ctx) => {
      let original!: Awaited<ReturnType<typeof handler>>;
      await super._wrapHandler(method, async (request, ctx) => {
        original = await handler(request, ctx);
        return original;
      })(request, ctx);
      // Retain SDK mode/result validation without replacing valid answers with its
      // Zod-record projection, which drops __proto__. elicit validates every value.
      return original;
    };
  }

  private track<T>(owned: McpCallContext, run: () => Promise<T>): Promise<T> {
    const promise = run();
    this.work.get(owned)?.add(promise);
    return promise;
  }

  protected override _resolveNonCompleteResult(
    ...args: Parameters<Client["_resolveNonCompleteResult"]>
  ): ReturnType<Client["_resolveNonCompleteResult"]> {
    const signal = args[1].options?.signal;
    const owned = signal ? this.contexts.get(signal) : undefined;
    return owned
      ? this.current.run(owned, () => super._resolveNonCompleteResult(...args))
      : super._resolveNonCompleteResult(...args);
  }

  async settleCalls(): Promise<void> {
    await Promise.allSettled(
      [...this.contexts.values()].flatMap((owned) => [...(this.work.get(owned) ?? [])]),
    );
  }

  async withContext<T>(owned: McpCallContext, run: () => Promise<T>): Promise<T> {
    const execute = async () => {
      owned.signal.throwIfAborted();
      const controller = new AbortController();
      const interactionContext: McpCallContext = {
        ...owned,
        signal: AbortSignal.any([owned.signal, controller.signal]),
      };
      // SDK continuation lookup uses the original request signal; reverse work
      // also observes this call's lifetime, including an SDK timeout or failure.
      this.contexts.set(owned.signal, interactionContext);
      const tasks = new Set<Promise<unknown>>();
      this.work.set(interactionContext, tasks);
      try {
        return await this.current.run(interactionContext, run);
      } catch (error) {
        controller.abort(error);
        throw error;
      } finally {
        // Even a successful parent cannot leave orphaned reverse work running.
        controller.abort();
        await Promise.allSettled(tasks);
        this.work.delete(interactionContext);
        this.contexts.delete(owned.signal);
      }
    };
    // Legacy reverse requests carry no originating-call identity. Serialize only that era.
    if (this.getNegotiatedProtocolVersion() !== "2026-07-28") {
      let started = false;
      const start = () => {
        started = true;
        return execute();
      };
      const call = this.legacyTail.then(start, start);
      this.legacyTail = call.catch(() => {});
      try {
        return await raceWithAbortSignal(call, owned.signal);
      } catch (error) {
        // Once started, retain ownership until provider disposal and usage reporting finish.
        if (started) return await call;
        throw error;
      }
    }
    return await execute();
  }
}
