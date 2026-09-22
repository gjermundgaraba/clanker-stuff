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
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  InMemoryCredentialStore,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static, TSchema as TypeBoxSchema } from "typebox";
import { Value } from "typebox/value";
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
  api?: string;
  provider?: string;
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

// The captured payload is the provider transcript: the prompt and tool loadout
// live in its system messages exactly where Pi placed them.
const CapturedProviderPayloadSchema = Type.Object(
  {
    messages: Type.Optional(Type.Unsafe<Context["messages"]>({ type: "array" })),
  },
  { additionalProperties: true },
);

type CapturedProviderPayload = Static<typeof CapturedProviderPayloadSchema>;

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
    onFinalPayload?: (payload: CapturedProviderPayload) => void;
  },
): Provider => {
  const wrap =
    (
      delegate: (
        model: Model<Api>,
        context: TranscriptContext,
        options?: StreamOptions | SimpleStreamOptions,
      ) => AssistantMessageEventStream,
    ) =>
    (
      model: Model<Api>,
      context: TranscriptContext,
      streamOptions?: StreamOptions | SimpleStreamOptions,
    ) => {
      const outer = createAssistantMessageEventStream();

      queueMicrotask(async () => {
        try {
          const syntheticPayload = { messages: context.messages };

          const nextPayload = await streamOptions?.onPayload?.(syntheticPayload, model);

          const finalPayload = Value.Parse(
            CapturedProviderPayloadSchema,
            nextPayload === undefined ? syntheticPayload : nextPayload,
          );

          hookOptions?.onFinalPayload?.(finalPayload);

          const nextContext = normalizeContext({
            messages: finalPayload.messages ?? syntheticPayload.messages,
          });

          const delegateOptions: StreamOptions | SimpleStreamOptions = { ...streamOptions };
          delete delegateOptions.onPayload;
          const inner = delegate(model, nextContext, delegateOptions);

          for await (const event of inner) {
            outer.push(event);
          }
        } catch (error) {
          const errorMessage = {
            ...fauxAssistantMessage("", {
              errorMessage: error instanceof Error ? error.message : String(error),
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
          return credential?.key ? { source: "runtime API key", type: "api_key" } : undefined;
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
    stream: wrap((model, context, options) => provider.stream(model, context, options)),
    streamSimple: wrap((model, context, options) => provider.streamSimple(model, context, options)),
  };
};

const fauxRegistrationFacade = (
  faux: FauxProviderHandle,
  unregister: () => void,
): FauxProviderRegistration => ({
  api: faux.api,
  appendResponses: faux.appendResponses,
  getModel: faux.getModel.bind(faux),
  getPendingResponseCount: faux.getPendingResponseCount,
  models: faux.models,
  setResponses: faux.setResponses,
  state: faux.state,
  unregister,
});

export const createAgentSessionHarness = async (options: AgentSessionHarnessOptions = {}) => {
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

    const providerPayloads: CapturedProviderPayload[] = [];

    const localFaux = fauxProvider({
      ...(options.api !== undefined ? { api: options.api } : {}),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.models !== undefined ? { models: options.models } : {}),
    });

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
      ...(options.skillPaths === undefined ? {} : { additionalSkillPaths: options.skillPaths }),
      agentDir,
      cwd,
      ...(options.extensionFactories === undefined
        ? {}
        : { extensionFactories: options.extensionFactories }),
      noPromptTemplates: true,
      noSkills: !options.skillPaths,
      noThemes: true,
      settingsManager,
      ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    });

    await resourceLoader.reload();

    const createdSession = await createAgentSession({
      agentDir,
      ...(options.tools === undefined ? {} : { customTools: options.tools }),
      cwd,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager,
      settingsManager,
    });

    ({ session } = createdSession);

    const bindOptions: Parameters<AgentSession["bindExtensions"]>[0] = {};

    if (options.mode !== undefined) {
      bindOptions.mode = options.mode;
    }

    if (options.uiContext !== undefined) {
      bindOptions.uiContext = options.uiContext;
    }

    await session.bindExtensions(bindOptions);

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
          (event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type,
        );
      },
      extensionsResult: activeExtensionsResult,
      faux: activeFaux,
      getPendingResponseCount() {
        return activeFaux.getPendingResponseCount();
      },
      lastProviderPayload<TSchema extends TypeBoxSchema>(schema: TSchema): Static<TSchema> {
        const payload = providerPayloads.at(-1);

        if (payload === undefined) {
          throw new Error("No provider payload has been captured");
        }

        // oxlint-disable-next-line typescript/no-unsafe-return -- TypeBox's unresolved Static<TSchema> conditional appears as any to the checker; Parse validates against the caller's schema before returning its derived type.
        return Value.Parse(schema, payload);
      },
      messages() {
        return [...activeSession.messages];
      },
      async prompt(text: string, promptOptions?: PromptOptions) {
        await activeSession.prompt(text, promptOptions);
      },
      providerPayloads<TSchema extends TypeBoxSchema>(schema: TSchema): Static<TSchema>[] {
        // oxlint-disable-next-line typescript/no-unsafe-return -- TypeBox's unresolved Static<TSchema> conditional appears as any to the checker; every payload is parsed against the caller's schema.
        return providerPayloads.map((payload) => Value.Parse(schema, payload));
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

export type AgentSessionHarness = Awaited<ReturnType<typeof createAgentSessionHarness>>;

export type { AgentSessionHarnessOptions };
