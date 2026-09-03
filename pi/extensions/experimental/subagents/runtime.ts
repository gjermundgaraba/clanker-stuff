import { chmodSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate as yieldImmediate } from "node:timers/promises";

import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  BuildSystemPromptOptions,
  ExtensionContext,
  ExtensionFactory,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";

import { isThinkingLevel } from "./config.js";
import { PermanentChildError } from "./permanent-error.js";
import { lastPersistedEntryId, TranscriptCursor } from "./transcript.js";

type HistoryMessage = Parameters<SessionManager["appendMessage"]>[0];
const CHILD_BRIDGE_PATH = "<inline:subagents-child>";
export const SUBAGENT_IDENTITY_ENTRY_TYPE = "subagent-child-identity";

const canonicalExtensionPath = (candidate: string): string => {
  try {
    return realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
};
const SUBAGENT_HOST_PATH = canonicalExtensionPath(path.resolve(import.meta.dirname, "index.ts"));
export const isSubagentHostExtensionPath = (candidate: string): boolean =>
  canonicalExtensionPath(candidate) === SUBAGENT_HOST_PATH;

export interface RuntimeMessage {
  content: string;
  customType: string;
  details: {
    communicationId: string;
  };
}

export interface PromptInput {
  images?: ImageContent[];
  text: string;
}

export type ChildTurnOutcome =
  | { status: "completed"; text?: string }
  | { status: "interrupted" }
  | { status: "errored"; error: string };

export interface ChildTurn {
  accepted: Promise<void>;
  settled: Promise<ChildTurnOutcome>;
}

export interface ChildDelivery {
  accepted: Promise<void>;
  settled?: ChildTurn["settled"];
}

export interface ChildRuntime {
  abort: () => Promise<void>;
  commit: () => void;
  dispose: () => Promise<void>;
  isStreaming: () => boolean;
  rollback: () => Promise<void>;
  sendMessage: (
    message: RuntimeMessage,
    onEnqueued?: () => void,
    triggerTurn?: boolean,
  ) => ChildDelivery;
  startTurn: (input: PromptInput) => ChildTurn;
  readonly sessionFile: string;
}

export interface ChildRuntimeRequest {
  bridge: ExtensionFactory;
  cwd: string;
  dataDir: string;
  history: HistoryMessage[];
  identity: string;
  model: Model<Api> | undefined;
  modelRegistry: ModelRegistry;
  prompt: string;
  promptOptions?: BuildSystemPromptOptions;
  sessionFile?: string;
  thinkingLevel?: NonNullable<ExtensionContext["thinkingLevel"]>;
  tools: string[];
  trusted: boolean;
}

export type ChildRuntimeFactory = (request: ChildRuntimeRequest) => Promise<ChildRuntime>;
type RuntimeModelSource = Pick<
  ModelRegistry,
  | "getAll"
  | "getApiKeyForProvider"
  | "getProviderAuthStatus"
  | "getRegisteredNativeProvider"
  | "getRegisteredProviderConfig"
  | "getRegisteredProviderIds"
>;

const IdentitySchema = Type.Object(
  {
    identity: Type.String(),
  },
  { additionalProperties: true },
);
const TextContentSchema = Type.Object(
  {
    text: Type.String(),
    type: Type.Literal("text"),
  },
  { additionalProperties: true },
);
const AssistantCandidateSchema = Type.Object(
  {
    content: Type.Optional(Type.Array(Type.Unknown())),
    errorMessage: Type.Optional(Type.Unknown()),
    role: Type.Literal("assistant"),
    stopReason: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
const CommunicationDetailsSchema = Type.Object(
  {
    communicationId: Type.String(),
  },
  { additionalProperties: true },
);
const StringSchema = Type.String();

const findModel = (
  registry: ModelRegistry,
  provider: string,
  modelId: string,
): Model<Api> | undefined => registry.find(provider, modelId);

const restoreError = (cause: unknown): PermanentChildError =>
  cause instanceof PermanentChildError
    ? cause
    : new PermanentChildError(cause instanceof Error ? cause.message : String(cause), {
        cause,
      });

const validateRestoredSession = (
  sessionFile: string,
  sessionDir: string,
  identity: string,
  cwd: string,
): SessionManager => {
  try {
    const resolvedDirectory = realpathSync(sessionDir);
    const resolvedFile = realpathSync(sessionFile);
    const relative = path.relative(resolvedDirectory, resolvedFile);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new PermanentChildError("Child session file escapes the session directory");
    }
    const info = lstatSync(sessionFile);
    if (info.isSymbolicLink() || !info.isFile() || info.size === 0) {
      throw new PermanentChildError("Child session file must be a nonempty regular file");
    }
    const session = SessionManager.open(resolvedFile, resolvedDirectory, cwd);
    const identities = session
      .getBranch()
      .filter(
        (entry): entry is Extract<typeof entry, { type: "custom" }> =>
          entry.type === "custom" && entry.customType === SUBAGENT_IDENTITY_ENTRY_TYPE,
      );
    if (
      identities.length !== 1 ||
      !Value.Check(IdentitySchema, identities[0]?.data) ||
      identities[0].data.identity !== identity
    ) {
      throw new PermanentChildError("Child session file belongs to a different agent");
    }
    if (lastPersistedEntryId(resolvedFile) !== session.getLeafId()) {
      throw new PermanentChildError("Child session branch is not fully persisted");
    }
    return session;
  } catch (error) {
    throw restoreError(error);
  }
};

const createMaterializedSession = (request: ChildRuntimeRequest, sessionDir: string) => {
  mkdirSync(sessionDir, { mode: 0o700, recursive: true });
  const directoryInfo = lstatSync(sessionDir);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
    throw new Error("Child session directory must be a regular directory");
  }
  chmodSync(sessionDir, 0o700);
  if (request.sessionFile !== undefined) {
    return {
      fresh: false,
      session: validateRestoredSession(
        request.sessionFile,
        sessionDir,
        request.identity,
        request.cwd,
      ),
    };
  }
  const generated = SessionManager.create(request.cwd, sessionDir);
  const sessionFile = generated.getSessionFile();
  if (sessionFile === undefined) {
    throw new Error("Unable to allocate a child session file");
  }
  try {
    writeFileSync(sessionFile, `${JSON.stringify(generated.getHeader())}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const session = SessionManager.open(sessionFile, sessionDir, request.cwd);
    session.appendCustomEntry(SUBAGENT_IDENTITY_ENTRY_TYPE, {
      identity: request.identity,
    });
    for (const message of request.history) {
      session.appendMessage(message);
    }
    if (lastPersistedEntryId(sessionFile) !== session.getLeafId()) {
      throw new Error("Unable to materialize child transcript");
    }
    return { fresh: true, session };
  } catch (error) {
    rmSync(sessionFile, { force: true });
    throw error;
  }
};

export const finalFromMessages = (messages: readonly unknown[]): ChildTurnOutcome => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!Value.Check(AssistantCandidateSchema, candidate)) {
      continue;
    }
    const text = Array.isArray(candidate.content)
      ? candidate.content
          .filter((item) => Value.Check(TextContentSchema, item))
          .map((item) => item.text)
          .join("")
      : undefined;
    if (candidate.stopReason === "error") {
      return {
        error: Value.Check(StringSchema, candidate.errorMessage)
          ? candidate.errorMessage
          : "Agent failed",
        status: "errored",
      };
    }
    if (candidate.stopReason === "aborted") {
      return { status: "interrupted" };
    }
    const completed: Extract<ChildTurnOutcome, { status: "completed" }> = {
      status: "completed",
    };
    if (text !== undefined && text.trim() !== "") {
      completed.text = text;
    }
    return completed;
  }
  return { status: "completed" };
};

export const cloneModelRuntime = async (
  source: RuntimeModelSource,
  requiredProvider?: string,
): Promise<ModelRuntime> => {
  const agentDir = getAgentDir();
  const runtime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  for (const providerId of source.getRegisteredProviderIds()) {
    const nativeProvider = source.getRegisteredNativeProvider(providerId);
    const config = source.getRegisteredProviderConfig(providerId);
    if (nativeProvider) {
      runtime.registerNativeProvider(nativeProvider);
    } else if (config) {
      runtime.registerProvider(providerId, config);
    }
  }
  const providers = new Set([
    ...source.getAll().map((model) => model.provider),
    ...source.getRegisteredProviderIds(),
    ...(requiredProvider === undefined ? [] : [requiredProvider]),
  ]);
  await Promise.all(
    [...providers].map(async (providerId) => {
      try {
        if (source.getProviderAuthStatus(providerId).source !== "runtime") {
          return;
        }
        const apiKey = await source.getApiKeyForProvider(providerId);
        if (apiKey !== undefined && apiKey !== "") {
          await runtime.setRuntimeApiKey(providerId, apiKey);
        }
      } catch (error) {
        if (providerId === requiredProvider) {
          throw error;
        }
      }
    }),
  );
  return runtime;
};

const ignored = async (promise: Promise<unknown>): Promise<void> => {
  try {
    await promise;
  } catch {
    // The owning operation observes or reports the failure.
  }
};

interface VoidDeferred {
  promise: Promise<void>;
  reject: (cause?: unknown) => void;
  resolve: () => void;
}

const createVoidDeferred = (): VoidDeferred => {
  const deferred = Promise.withResolvers<undefined>();
  return {
    promise: deferred.promise,
    reject: deferred.reject,
    resolve: () => {
      deferred.resolve(undefined);
    },
  };
};

export const createChildRuntime: ChildRuntimeFactory = async (request) => {
  const sessionDir = path.join(request.dataDir, "sessions");
  const materialized = createMaterializedSession(request, sessionDir);
  const { session: sessionManager } = materialized;
  const sessionFile = sessionManager.getSessionFile();
  if (sessionFile === undefined) {
    throw new Error("Child session is not persistent");
  }
  let createdSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const restored = sessionManager.buildSessionContext();
    let selectedModel = request.model;
    let selectedThinking = request.thinkingLevel;
    if (!materialized.fresh) {
      if (restored.model === null) {
        throw new PermanentChildError("Restored child session has no selected model");
      }
      selectedModel = findModel(
        request.modelRegistry,
        restored.model.provider,
        restored.model.modelId,
      );
      if (selectedModel === undefined) {
        throw new PermanentChildError(
          `Unable to resolve restored child model ${restored.model.provider}/${restored.model.modelId}`,
        );
      }
      if (!isThinkingLevel(restored.thinkingLevel)) {
        throw new PermanentChildError(
          `Invalid restored child thinking level: ${restored.thinkingLevel}`,
        );
      }
      selectedThinking = restored.thinkingLevel;
    }

    const cursor = new TranscriptCursor(sessionFile);
    let poisonError: PermanentChildError | undefined;
    const customStarts: string[] = [];
    const startedCustom = new Set<string>();
    const pendingCustom = new Map<string, VoidDeferred>();
    const pendingPassive: RuntimeMessage[] = [];
    const terminatingToolCalls = new Set<string>();
    interface ActiveAttempt {
      accepted: VoidDeferred;
      boundary: unknown;
      cancellation: VoidDeferred;
      cancellationError?: Error;
      finished: VoidDeferred;
      preflight: boolean;
      userSeen: boolean;
    }
    let activeAttempt: ActiveAttempt | undefined;
    let settlementFlush: Promise<void> | undefined;
    const poisoned = Promise.withResolvers<never>();
    void ignored(poisoned.promise);
    const poison = (cause: unknown): PermanentChildError => {
      if (poisonError !== undefined) {
        return poisonError;
      }
      poisonError =
        cause instanceof PermanentChildError
          ? cause
          : new PermanentChildError(cause instanceof Error ? cause.message : String(cause), {
              cause,
            });
      poisoned.reject(poisonError);
      if (createdSession !== undefined) {
        void ignored(createdSession.abort());
      }
      return poisonError;
    };
    const assertHealthy = (): void => {
      if (poisonError instanceof Error) {
        throw poisonError;
      }
    };
    const verifyLeaf = async <T>(expectedMessage?: T): Promise<void> => {
      const entry =
        expectedMessage === undefined
          ? sessionManager.getLeafEntry()
          : sessionManager
              .getBranch()
              .findLast(
                (candidate) =>
                  candidate.type === "message" && candidate.message === expectedMessage,
              );
      if (entry === undefined) {
        throw poison(
          new Error(
            expectedMessage === undefined
              ? "Session has no persisted leaf"
              : "Expected session message was not appended",
          ),
        );
      }
      try {
        await cursor.verify(entry.id);
      } catch (error) {
        throw poison(error);
      }
    };
    const verifyCustomDelivery = async (deliveryId: string): Promise<void> => {
      const entry = sessionManager.getLeafEntry();
      if (
        entry?.type !== "custom_message" ||
        !Value.Check(CommunicationDetailsSchema, entry.details) ||
        entry.details.communicationId !== deliveryId
      ) {
        throw poison(
          new Error(
            `Communication ${deliveryId} was not durably identified in the child transcript`,
          ),
        );
      }
      try {
        await cursor.verify(entry.id);
      } catch (error) {
        throw poison(error);
      }
    };

    const { promptOptions } = request;
    const appendedPrompt = [promptOptions?.appendSystemPrompt, request.prompt].filter(
      (value): value is string => Boolean(value),
    );
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(request.cwd, agentDir, {
      projectTrusted: request.trusted,
    });
    const excludedExtensionPaths = new Set<string>();
    const flushPassive = async (triggerTurn: boolean): Promise<void> => {
      const session = createdSession;
      if (session === undefined) {
        throw new Error("Child session is unavailable");
      }
      const pending = pendingPassive.splice(0, triggerTurn ? 1 : pendingPassive.length);
      for (const message of pending) {
        const receipt = pendingCustom.get(message.details.communicationId);
        try {
          await session.sendCustomMessage(
            { ...message, display: false },
            { deliverAs: "steer", triggerTurn },
          );
          if (!triggerTurn) {
            await receipt?.promise;
          }
        } catch (error) {
          const failure = poison(error);
          pendingCustom.get(message.details.communicationId)?.reject(failure);
          pendingCustom.delete(message.details.communicationId);
          throw failure;
        }
      }
    };
    const hostBridge: ExtensionFactory = async (pi) => {
      pi.on("session_before_compact", () =>
        activeAttempt?.cancellationError !== undefined ? { cancel: true } : undefined,
      );
      await request.bridge(pi);
      pi.on("input", () =>
        activeAttempt?.preflight === true && activeAttempt.cancellationError !== undefined
          ? { action: "handled" }
          : undefined,
      );
      pi.on("turn_start", () => {
        terminatingToolCalls.clear();
      });
      pi.on("tool_execution_end", (event) => {
        if (event.result?.terminate === true) {
          terminatingToolCalls.add(event.toolCallId);
        }
      });
      pi.on("turn_end", async (event, ctx) => {
        const terminal =
          ctx.signal?.aborted === true ||
          (event.message.role === "assistant" &&
            (event.message.stopReason === "error" || event.message.stopReason === "aborted"));
        const continues =
          !terminal &&
          event.toolResults.length > 0 &&
          event.toolResults.some(({ toolCallId }) => !terminatingToolCalls.has(toolCallId));
        try {
          if (continues && !ctx.hasPendingMessages()) {
            await flushPassive(true);
          }
        } catch (error) {
          throw poison(error);
        } finally {
          terminatingToolCalls.clear();
        }
      });
      pi.on("agent_settled", async () => {
        const operation = flushPassive(false);
        settlementFlush = operation;
        try {
          await operation;
        } catch (error) {
          throw poison(error);
        } finally {
          if (settlementFlush === operation) {
            settlementFlush = undefined;
          }
        }
      });
      pi.on("tool_call", async () => {
        assertHealthy();
        await cursor.verify();
        if (cursor.parentId !== sessionManager.getLeafId()) {
          throw poison(new Error("Child transcript is behind its in-memory session"));
        }
        assertHealthy();
      });
    };
    const resourceLoader = new DefaultResourceLoader({
      agentDir,
      agentsFilesOverride: () => ({
        agentsFiles: promptOptions?.contextFiles ?? [],
      }),
      appendSystemPrompt: appendedPrompt,
      cwd: request.cwd,
      extensionFactories: [{ factory: hostBridge, hidden: true, name: "subagents-child" }],
      extensionsOverride: (base) => {
        const extensions = base.extensions.filter((extension) => {
          const keep =
            extension.path === CHILD_BRIDGE_PATH ||
            !isSubagentHostExtensionPath(extension.resolvedPath);
          if (!keep) {
            excludedExtensionPaths.add(extension.path);
          }
          return keep;
        });
        return {
          ...base,
          errors: base.errors.filter(
            ({ error, path: extensionPath }) =>
              !excludedExtensionPaths.has(extensionPath) &&
              !(
                extensionPath === CHILD_BRIDGE_PATH &&
                error.startsWith("Tool ") &&
                [...excludedExtensionPaths].some((excludedPath) =>
                  error.endsWith(`conflicts with ${excludedPath}`),
                )
              ),
          ),
          extensions,
        };
      },
      noContextFiles: true,
      noExtensions: !request.trusted,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager,
      skillsOverride: () => ({
        diagnostics: [],
        skills: promptOptions?.skills ?? [],
      }),
      systemPrompt: promptOptions?.customPrompt,
    });
    await resourceLoader.reload();
    const loadedExtensions = resourceLoader.getExtensions();
    const bridgeError = loadedExtensions.errors.find(
      ({ path: extensionPath }) => extensionPath === CHILD_BRIDGE_PATH,
    );
    if (bridgeError !== undefined) {
      throw new Error(`Unable to load the required child bridge: ${bridgeError.error}`);
    }
    if (!loadedExtensions.extensions.some((extension) => extension.path === CHILD_BRIDGE_PATH)) {
      throw new Error("Unable to load the required child bridge");
    }

    const { session } = await createAgentSession({
      agentDir,
      cwd: request.cwd,
      model: selectedModel,
      modelRuntime: await cloneModelRuntime(request.modelRegistry, selectedModel?.provider),
      resourceLoader,
      sessionManager,
      settingsManager,
      thinkingLevel: selectedThinking,
      tools: request.tools,
    });
    createdSession = session;
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => {
      const cancellation = activeAttempt?.cancellationError;
      if (cancellation !== undefined) {
        if (session.agent.signal?.aborted !== true) {
          session.agent.abort();
        }
        throw cancellation;
      }
      return stream(model, context, options);
    };
    const activeModel = session.model;
    const activeContext = sessionManager.buildSessionContext();
    if (
      activeModel !== undefined &&
      (activeContext.model?.provider !== activeModel.provider ||
        activeContext.model.modelId !== activeModel.id)
    ) {
      sessionManager.appendModelChange(activeModel.provider, activeModel.id);
    }
    if (activeContext.thinkingLevel !== session.thinkingLevel) {
      sessionManager.appendThinkingLevelChange(session.thinkingLevel);
    }
    await cursor.verify(sessionManager.getLeafId() ?? undefined);
    await session.bindExtensions({ mode: "print" });

    let committed = !materialized.fresh;
    let disposal: Promise<void> | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "custom") {
        if (Value.Check(CommunicationDetailsSchema, event.message.details)) {
          const { communicationId } = event.message.details;
          customStarts.push(communicationId);
          startedCustom.add(communicationId);
        }
        return;
      }
      if (event.type === "message_end" && event.message.role === "user") {
        const attempt = activeAttempt;
        if (attempt !== undefined) {
          attempt.userSeen = true;
        }
        queueMicrotask(() => {
          void (async () => {
            try {
              await verifyLeaf(event.message);
              attempt?.accepted.resolve();
            } catch (error) {
              attempt?.accepted.reject(error);
            }
          })();
        });
        return;
      }
      if (event.type === "message_end" && event.message.role === "custom") {
        const deliveryId = customStarts.shift();
        if (deliveryId === undefined) {
          queueMicrotask(() => {
            void ignored(verifyLeaf());
          });
          return;
        }
        queueMicrotask(() => {
          void (async () => {
            try {
              await verifyCustomDelivery(deliveryId);
              pendingCustom.get(deliveryId)?.resolve();
            } catch (error) {
              pendingCustom.get(deliveryId)?.reject(error);
            } finally {
              pendingCustom.delete(deliveryId);
              startedCustom.delete(deliveryId);
            }
          })();
        });
        return;
      }
      if (
        event.type === "message_end" &&
        (event.message.role === "assistant" || event.message.role === "toolResult")
      ) {
        queueMicrotask(() => {
          void ignored(verifyLeaf(event.message));
        });
        return;
      }
      if (event.type === "compaction_end") {
        queueMicrotask(() => {
          void ignored(verifyLeaf());
        });
      }
    });

    const startTurn = (input: PromptInput): ChildTurn => {
      assertHealthy();
      if (session.isStreaming || activeAttempt !== undefined) {
        throw new Error("Child is already running");
      }
      const accepted = createVoidDeferred();
      const cancellation = createVoidDeferred();
      const finished = createVoidDeferred();
      const boundary = session.state.messages.at(-1);
      const attempt: ActiveAttempt = {
        accepted,
        boundary,
        cancellation,
        finished,
        preflight: true,
        userSeen: false,
      };
      activeAttempt = attempt;
      const prompt = session.prompt(input.text, {
        expandPromptTemplates: false,
        images: input.images,
        preflightResult: (success) => {
          if (!success) {
            return;
          }
          if (attempt.cancellationError !== undefined) {
            throw attempt.cancellationError;
          }
          attempt.preflight = false;
        },
        source: "extension",
      });
      const settled = (async () => {
        try {
          await Promise.race([prompt, cancellation.promise, poisoned.promise]);
          await yieldImmediate();
          if (!attempt.userSeen) {
            throw new Error("Child input did not produce a user turn");
          }
          await cursor.barrier();
          assertHealthy();
          const { messages } = session.state;
          const index = boundary === undefined ? -1 : messages.lastIndexOf(boundary);
          return finalFromMessages(messages.slice(index + 1));
        } catch (error) {
          accepted.reject(error);
          throw error;
        } finally {
          await ignored(prompt);
          if (activeAttempt === attempt) {
            activeAttempt = undefined;
          }
          attempt.finished.resolve();
        }
      })();
      void ignored(accepted.promise);
      void ignored(cancellation.promise);
      void ignored(settled);
      return { accepted: accepted.promise, settled };
    };

    const cancelAttempt = (cause: Error): void => {
      const attempt = activeAttempt;
      if (attempt === undefined || attempt.cancellationError !== undefined) {
        return;
      }
      attempt.cancellationError = cause;
      if (attempt.preflight) {
        attempt.cancellation.reject(cause);
      }
    };

    const stop = async (failure: Error, waitForAttempt = false): Promise<void> => {
      const attempt = activeAttempt;
      cancelAttempt(failure);
      session.clearQueue();
      session.abortCompaction();
      const postRun =
        attempt !== undefined &&
        !attempt.preflight &&
        session.isStreaming &&
        session.agent.signal === undefined;
      let stopError: unknown;
      try {
        const abort = session.abort();
        if (waitForAttempt || !postRun) {
          await abort;
        } else {
          void ignored(abort);
        }
      } catch (error) {
        stopError = error;
      }
      if (waitForAttempt) {
        await attempt?.finished.promise;
      }
      try {
        await settlementFlush;
      } catch (error) {
        stopError ??= error;
      }
      await Promise.allSettled(
        [...pendingCustom]
          .filter(([deliveryId]) => startedCustom.has(deliveryId))
          .map(([, delivery]) => delivery.promise),
      );
      for (const [deliveryId, delivery] of pendingCustom) {
        if (!startedCustom.has(deliveryId)) {
          delivery.reject(failure);
          pendingCustom.delete(deliveryId);
        }
      }
      pendingPassive.length = 0;
      if (stopError !== undefined) {
        throw stopError;
      }
      assertHealthy();
    };

    const runtime: ChildRuntime = {
      async abort() {
        await stop(new Error("Child turn was aborted"));
      },
      commit() {
        committed = true;
      },
      dispose() {
        if (disposal === undefined) {
          const deferred = createVoidDeferred();
          disposal = deferred.promise;
          void (async () => {
            const failure = new PermanentChildError("Child runtime was disposed");
            const preflight = activeAttempt?.preflight === true;
            const stopping = stop(failure, true);
            try {
              if (preflight) {
                const shutdown = session.extensionRunner.emit({
                  reason: "quit",
                  type: "session_shutdown",
                });
                const [stopResult, shutdownResult] = await Promise.allSettled([stopping, shutdown]);
                if (shutdownResult.status === "rejected") {
                  throw shutdownResult.reason;
                }
                if (stopResult.status === "rejected") {
                  throw stopResult.reason;
                }
              } else {
                try {
                  await stopping;
                } finally {
                  await session.extensionRunner.emit({
                    reason: "quit",
                    type: "session_shutdown",
                  });
                }
              }
            } finally {
              try {
                unsubscribe();
              } finally {
                session.dispose();
              }
            }
          })().then(deferred.resolve, deferred.reject);
        }
        return disposal;
      },
      isStreaming: () => session.isStreaming,
      async rollback() {
        try {
          await runtime.dispose();
        } finally {
          if (!committed) {
            rmSync(sessionFile, { force: true });
          }
        }
      },
      sendMessage(message, onEnqueued, triggerTurn = false) {
        assertHealthy();
        if (triggerTurn && !session.isStreaming) {
          return startTurn({ text: message.content });
        }
        const { communicationId: deliveryId } = message.details;
        const accepted = createVoidDeferred();
        pendingCustom.set(deliveryId, accepted);
        const streaming = session.isStreaming;
        if (streaming && !triggerTurn) {
          pendingPassive.push(message);
          onEnqueued?.();
          return { accepted: accepted.promise };
        }
        const operation = (async () => {
          try {
            await session.sendCustomMessage(
              { ...message, display: false },
              {
                deliverAs: "steer",
                triggerTurn: streaming && triggerTurn,
              },
            );
            onEnqueued?.();
          } catch (error) {
            pendingCustom.delete(deliveryId);
            accepted.reject(poison(error));
          }
        })();
        void ignored(operation);
        return { accepted: accepted.promise };
      },
      sessionFile,
      startTurn,
    };
    return runtime;
  } catch (error) {
    try {
      if (createdSession !== undefined) {
        await ignored(
          createdSession.extensionRunner.emit({
            reason: "quit",
            type: "session_shutdown",
          }),
        );
        createdSession.dispose();
      }
    } finally {
      if (materialized.fresh) {
        rmSync(sessionFile, { force: true });
      }
    }
    throw error;
  }
};
