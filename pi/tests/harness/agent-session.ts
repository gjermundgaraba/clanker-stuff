import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  FauxModelDefinition,
  FauxProviderHandle,
  FauxProviderRegistration,
  FauxResponseStep,
  Model,
  Provider,
  SimpleStreamOptions,
  StreamOptions,
} from "@earendil-works/pi-ai";
import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  ExtensionContext,
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
  mode?: ExtensionContext["mode"];
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
 */
const wrapFauxProviderPayloadHooks = (
  provider: Provider,
  hookOptions?: {
    onFinalPayload?: (payload: unknown) => void;
  }
): Provider => {
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
          const errorMessage = {
            ...fauxAssistantMessage("", {
              errorMessage:
                error instanceof Error ? error.message : String(error),
              stopReason: "error",
            }),
            api: model.api,
            model: model.id,
            provider: model.provider,
          };
          outer.push({
            error: errorMessage,
            reason: "error",
            type: "error",
          });
        }
      });

      return outer;
    };

  return {
    ...provider,
    auth: {
      ...provider.auth,
      apiKey: {
        async check({ credential }) {
          return credential?.key
            ? { source: "runtime API key", type: "api_key" }
            : undefined;
        },
        name: provider.auth.apiKey?.name ?? "Faux",
        async resolve({ credential }) {
          return credential?.key
            ? {
                auth: { apiKey: credential.key },
                source: "runtime API key",
              }
            : undefined;
        },
      },
    },
    stream: wrap(provider.stream),
    streamSimple: wrap(provider.streamSimple),
  };
};

const fauxRegistrationFacade = (
  faux: FauxProviderHandle,
  unregister: () => void
): FauxProviderRegistration => ({
  api: faux.api,
  appendResponses: faux.appendResponses,
  getModel: faux.getModel,
  getPendingResponseCount: faux.getPendingResponseCount,
  models: faux.models,
  setResponses: faux.setResponses,
  state: faux.state,
  unregister,
});

export const createAgentSessionHarness = async (
  options: AgentSessionHarnessOptions = {}
) => {
  let tempDir: string | undefined;
  let faux: FauxProviderRegistration | undefined;
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
        faux?.unregister();
      } finally {
        faux = undefined;

        if (tempDir && existsSync(tempDir)) {
          rmSync(tempDir, { force: true, recursive: true });
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

    const localFaux = fauxProvider({ models: options.models });
    localFaux.setResponses([]);

    const withConfiguredAuth = options.withConfiguredAuth ?? true;
    const model = localFaux.getModel();

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
    });
    const wrappedProvider = wrapFauxProviderPayloadHooks(localFaux.provider, {
      onFinalPayload(payload) {
        providerPayloads.push(payload);
      },
    });
    modelRuntime.registerNativeProvider(wrappedProvider);
    let unregistered = false;
    const registeredFaux = fauxRegistrationFacade(localFaux, () => {
      if (unregistered) {
        return;
      }

      unregistered = true;
      modelRuntime.unregisterProvider(wrappedProvider.id);
    });
    faux = registeredFaux;

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

    await session.bindExtensions({
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.uiContext === undefined
        ? {}
        : { uiContext: options.uiContext }),
    });

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
