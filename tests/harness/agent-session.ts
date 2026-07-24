import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  FauxModelDefinition,
  FauxProviderRegistration,
  FauxResponseStep,
  Model,
  SimpleStreamOptions,
  StreamOptions,
} from "@earendil-works/pi-ai";
import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  getApiProvider,
  registerApiProvider,
  registerFauxProvider,
  unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionFactory,
  ExtensionUIContext,
  PromptOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";

import { createTempDir } from "../helpers/fs.js";

export type {
  FauxModelDefinition,
  FauxProviderRegistration,
  FauxResponseStep,
} from "@earendil-works/pi-ai";
export type {
  AgentSession,
  AgentSessionEvent,
  ExtensionUIContext,
  PromptOptions as AgentSessionPromptOptions,
} from "@earendil-works/pi-coding-agent";

interface AgentSessionHarnessOptions {
  extensionFactories?: ExtensionFactory[];
  models?: FauxModelDefinition[];
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  skillPaths?: string[];
  cwd?: string;
  sessionDir?: string;
  continueSession?: boolean;
  uiContext?: ExtensionUIContext;
  withConfiguredAuth?: boolean;
}

const CONCURRENT_WRAPPED_FAUX_PROVIDER_ERROR =
  "Concurrent use of the wrapped faux provider is unsupported; clean up the active agent-session harness before creating another.";

let activeWrappedFauxProviderToken: symbol | undefined;

const claimWrappedFauxProviderSlot = () => {
  if (activeWrappedFauxProviderToken) {
    throw new Error(CONCURRENT_WRAPPED_FAUX_PROVIDER_ERROR);
  }

  const token = Symbol("agent-session-harness");
  activeWrappedFauxProviderToken = token;

  return () => {
    if (activeWrappedFauxProviderToken === token) {
      activeWrappedFauxProviderToken = undefined;
    }
  };
};

const applyCapturedPayloadToContext = (
  context: Context,
  payload: unknown
): Context => {
  if (!payload || typeof payload !== "object") {
    return context;
  }

  const candidate = payload as {
    systemPrompt?: unknown;
    messages?: unknown;
    tools?: unknown;
  };

  return {
    ...context,
    ...(typeof candidate.systemPrompt === "string"
      ? { systemPrompt: candidate.systemPrompt }
      : {}),
    ...(Array.isArray(candidate.messages)
      ? { messages: candidate.messages }
      : {}),
    ...(Array.isArray(candidate.tools) ? { tools: candidate.tools } : {}),
  };
};

/**
 * Test-only wrapper for the faux provider used by createAgentSessionHarness().
 *
 * createAgentSession() exposes before_provider_request through the provider's
 * onPayload callback, but the stock faux provider does not surface onPayload in
 * a way tests can observe. This wrapper forwards onPayload manually so real
 * AgentSession tests can assert provider-payload behavior without reaching into
 * private runtime APIs.
 *
 * Provider registration in pi-ai is process-global. Because this wrapper
 * replaces the registered faux provider for the current process, only one active
 * harness may install it at a time unless this implementation changes.
 */
const enableFauxProviderPayloadHooks = (
  api: string,
  hookOptions?: {
    onFinalPayload?: (payload: unknown) => void;
  }
) => {
  const provider = getApiProvider(api);
  if (!provider) {
    throw new Error(`Faux API provider not registered: ${api}`);
  }

  const sourceId = `agent-session-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const wrap =
    (
      delegate: (
        model: Model<Api>,
        context: Context,
        options?: StreamOptions | SimpleStreamOptions
      ) => AssistantMessageEventStream
    ) =>
    (
      model: Model<Api>,
      context: Context,
      streamOptions?: StreamOptions | SimpleStreamOptions
    ) => {
      const outer = createAssistantMessageEventStream();

      queueMicrotask(async () => {
        try {
          const syntheticPayload = {
            messages: context.messages,
            systemPrompt: context.systemPrompt,
            tools: context.tools,
          };
          const nextPayload = await streamOptions?.onPayload?.(
            syntheticPayload,
            model
          );
          const finalPayload =
            nextPayload === undefined ? syntheticPayload : nextPayload;

          hookOptions?.onFinalPayload?.(finalPayload);

          const nextContext = applyCapturedPayloadToContext(
            context,
            finalPayload
          );
          const inner = delegate(model, nextContext, {
            ...streamOptions,
            onPayload: undefined,
          });

          for await (const event of inner) {
            outer.push(event);
          }
        } catch (error) {
          outer.push({
            error: fauxAssistantMessage("", {
              errorMessage:
                error instanceof Error ? error.message : String(error),
              stopReason: "error",
            }),
            reason: "error",
            type: "error",
          });
        }
      });

      return outer;
    };

  registerApiProvider(
    {
      api: provider.api,
      stream: wrap(provider.stream),
      streamSimple: wrap(provider.streamSimple),
    },
    sourceId
  );

  return () => {
    unregisterApiProviders(sourceId);
  };
};

export const createAgentSessionHarness = async (
  options: AgentSessionHarnessOptions = {}
) => {
  const releaseWrappedFauxProviderSlot = claimWrappedFauxProviderSlot();
  let tempDir: string | undefined;
  let faux: FauxProviderRegistration | undefined;
  let disableFauxPayloadHooks: (() => void) | undefined;
  let session: AgentSession | undefined;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;

    try {
      session?.dispose();
    } finally {
      session = undefined;

      try {
        disableFauxPayloadHooks?.();
      } finally {
        disableFauxPayloadHooks = undefined;

        try {
          faux?.unregister();
        } finally {
          faux = undefined;
          releaseWrappedFauxProviderSlot();

          if (tempDir && existsSync(tempDir)) {
            rmSync(tempDir, { force: true, recursive: true });
          }
        }
      }
    }
  };

  try {
    tempDir = await createTempDir("agent-session-");
    const cwd = options.cwd ?? tempDir;
    const agentDir = path.join(tempDir, "agent");
    mkdirSync(agentDir, { recursive: true });

    const providerPayloads: unknown[] = [];

    const registeredFaux = registerFauxProvider({ models: options.models });
    faux = registeredFaux;
    disableFauxPayloadHooks = enableFauxProviderPayloadHooks(
      registeredFaux.api,
      {
        onFinalPayload(payload) {
          providerPayloads.push(payload);
        },
      }
    );
    registeredFaux.setResponses([]);

    const withConfiguredAuth = options.withConfiguredAuth ?? true;
    const model = registeredFaux.getModel();

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    modelRuntime.registerProvider(model.provider, {
      api: model.api,
      apiKey: "FAUX_API_KEY",
      baseUrl: model.baseUrl,
      models: registeredFaux.models.map((registeredModel) => ({
        api: registeredModel.api,
        contextWindow: registeredModel.contextWindow,
        cost: registeredModel.cost,
        id: registeredModel.id,
        input: registeredModel.input,
        maxTokens: registeredModel.maxTokens,
        name: registeredModel.name,
        reasoning: registeredModel.reasoning,
      })),
    });

    if (withConfiguredAuth) {
      await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
    }

    let sessionManager: ReturnType<typeof SessionManager.inMemory>;
    if (!options.sessionDir) {
      sessionManager = SessionManager.inMemory(cwd);
    } else if (options.continueSession) {
      sessionManager = SessionManager.continueRecent(cwd, options.sessionDir);
    } else {
      sessionManager = SessionManager.create(cwd, options.sessionDir);
    }
    const settingsManager = SettingsManager.inMemory(options.settings);
    const resourceLoader = new DefaultResourceLoader({
      additionalSkillPaths: options.skillPaths,
      agentDir,
      cwd,
      extensionFactories: options.extensionFactories,
      noPromptTemplates: true,
      noSkills: !options.skillPaths,
      noThemes: true,
      settingsManager,
      systemPrompt: options.systemPrompt,
    });
    await resourceLoader.reload();

    const createdSession = await createAgentSession({
      agentDir,
      customTools: options.tools,
      cwd,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
    });
    ({ session } = createdSession);

    await session.bindExtensions(
      options.uiContext ? { uiContext: options.uiContext } : {}
    );

    const events: AgentSessionEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });

    const activeSession = session;
    const activeFaux = registeredFaux;
    const activeExtensionsResult = createdSession.extensionsResult;
    const activeResourceLoader = resourceLoader;
    const harnessTempDir = tempDir;
    const harnessAgentDir = agentDir;

    return {
      agentDir: harnessAgentDir,
      appendResponses(responses: FauxResponseStep[]) {
        activeFaux.appendResponses(responses);
      },
      cleanup,
      events() {
        return [...events];
      },
      eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
        return events.filter(
          (event): event is Extract<AgentSessionEvent, { type: T }> =>
            event.type === type
        );
      },
      extensionsResult: activeExtensionsResult,
      faux: activeFaux,
      getPendingResponseCount() {
        return activeFaux.getPendingResponseCount();
      },
      lastProviderPayload() {
        return providerPayloads.at(-1);
      },
      messages() {
        return [...activeSession.messages];
      },
      async prompt(text: string, promptOptions?: PromptOptions) {
        await activeSession.prompt(text, promptOptions);
      },
      providerPayloads() {
        return [...providerPayloads];
      },
      resourceLoader: activeResourceLoader,
      session: activeSession,
      sessionManager,
      setResponses(responses: FauxResponseStep[]) {
        activeFaux.setResponses(responses);
      },
      tempDir: harnessTempDir,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
};

export type AgentSessionHarness = Awaited<
  ReturnType<typeof createAgentSessionHarness>
>;
export type { AgentSessionHarnessOptions };
