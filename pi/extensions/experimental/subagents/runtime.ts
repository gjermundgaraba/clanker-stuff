import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  BuildSystemPromptOptions,
  ExtensionFactory,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

import type { AgentThinkingLevel } from "./config.js";
import { envelopeText, mailMessage, MailDetailsSchema, SUBAGENT_MESSAGE_TYPE } from "./protocol.js";
import type { Envelope, Mail } from "./protocol.js";

type HistoryMessage = Parameters<SessionManager["appendMessage"]>[0];

type AgentMessage = AgentSession["state"]["messages"][number];

const CHILD_BRIDGE_PATH = "<inline:subagents-child>";

/** Asynchronous user interaction stays with the root session, which owns the user. */
const ROOT_ONLY_TOOLS = ["request_user_input_async", "send_message_to_user_async"];

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

export type ChildTurnOutcome =
  | { status: "completed"; text?: string }
  | { status: "interrupted" }
  | { status: "errored"; error: string };

export interface ChildRuntime {
  /** Requests cancellation of the current turn without waiting for it to settle. */
  abort: () => void;
  /** Appends passive mail now, or at the end of the current turn while one is running. */
  deliver: (mail: Mail) => void;
  dispose: () => Promise<void>;
  readonly model: string;
  readonly sessionFile: string;
  /**
   * Queues a task for the current turn, or returns undefined without one. Resolves once the turn
   * reads it, or with false when the turn settles without reading it.
   */
  steer: (task: Envelope) => Promise<boolean> | undefined;
  /** Runs one prompt to settlement. */
  startTurn: (text: string) => Promise<ChildTurnOutcome>;
  readonly thinkingLevel: AgentThinkingLevel;
}

export interface ChildRuntimeRequest {
  bridge: ExtensionFactory;
  cwd: string;
  dataDir: string;
  history: readonly HistoryMessage[];
  model: Model<Api>;
  modelRegistry: ModelRegistry;
  onDelivered: (mailId: string) => void;
  onError: (cause: unknown) => void;
  prompt: string;
  promptOptions: BuildSystemPromptOptions | undefined;
  sessionFile: string | undefined;
  thinkingLevel: AgentThinkingLevel | undefined;
  tools: readonly string[];
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

export const finalFromMessages = (
  messages: readonly AgentMessage[],
  cancelled: boolean,
): ChildTurnOutcome => {
  const candidate = messages.findLast((message) => message.role === "assistant");

  if (candidate === undefined) {
    // Compaction can summarize away a truncated response before a cancelled run ends.
    return cancelled ? { status: "interrupted" } : { status: "completed" };
  }

  // A request failing after cancellation reports the abort, not an agent error. An abort nobody
  // requested, such as a child extension's, is a failure the parent must hear about.
  if (!cancelled && (candidate.stopReason === "error" || candidate.stopReason === "aborted")) {
    return {
      error:
        candidate.errorMessage ??
        (candidate.stopReason === "aborted" ? "Turn was aborted" : "Agent failed"),
      status: "errored",
    };
  }

  // Cancellation can stop overflow recovery or an explicit unfinished-turn continuation;
  // neither intermediate response is a completed answer.
  if (
    cancelled &&
    (candidate.stopReason === "aborted" ||
      candidate.stopReason === "error" ||
      candidate.stopReason === "length" ||
      candidate.endTurn === false)
  ) {
    return { status: "interrupted" };
  }

  const text = candidate.content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("");

  return text.trim() === "" ? { status: "completed" } : { status: "completed", text };
};

export const cloneModelRuntime = async (
  source: RuntimeModelSource,
  requiredProvider: string,
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
    requiredProvider,
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

interface Turn {
  cancelled: boolean;
  /** Settles a turn cancelled before Pi starts its run, where `session.abort()` has nothing to stop. */
  readonly preflightCancelled: PromiseWithResolvers<undefined>;
  preflight: boolean;
  /** The latest run's signal; an abort nobody requested can leave a complete-looking response. */
  run?: AbortSignal | undefined;
}

export const createChildRuntime: ChildRuntimeFactory = async (request) => {
  const agentDir = getAgentDir();
  const modelRuntime = await cloneModelRuntime(request.modelRegistry, request.model.provider);
  const model = modelRuntime.getModel(request.model.provider, request.model.id);

  if (model === undefined) {
    throw new Error(
      `Model ${request.model.provider}/${request.model.id} is not available to child sessions`,
    );
  }

  const sessionDir = path.join(request.dataDir, "sessions");
  await mkdir(sessionDir, { mode: 0o700, recursive: true });

  const sessionManager =
    request.sessionFile === undefined
      ? SessionManager.create(request.cwd, sessionDir)
      : SessionManager.open(request.sessionFile, sessionDir, request.cwd);

  for (const message of request.history) {
    sessionManager.appendMessage(message);
  }

  const sessionFile = sessionManager.getSessionFile();

  if (sessionFile === undefined) {
    throw new Error("Child session is not persistent");
  }

  const { promptOptions } = request;
  /** The current prompt, from submission until it settles, including after cancellation. */
  let turn: Turn | undefined;

  const settingsManager = SettingsManager.create(request.cwd, agentDir, {
    projectTrusted: request.trusted,
  });

  const resourceLoader = new DefaultResourceLoader({
    agentDir,
    agentsFilesOverride: () => ({ agentsFiles: promptOptions?.contextFiles ?? [] }),
    appendSystemPrompt: [promptOptions?.appendSystemPrompt, request.prompt].filter(
      (value): value is string => value !== undefined && value !== "",
    ),
    cwd: request.cwd,
    // Built-in entries follow the user's `-builtin:<name>` settings and yield to replacements.
    extensionFactories: [
      { builtin: true, factory: createCodemodeExtension(), name: "codemode", replaceable: true },
      {
        builtin: true,
        factory: createToolSearchExtension(),
        name: "tool-search",
        replaceable: true,
      },
      { builtin: true, factory: createMcpExtension(), name: "mcp", replaceable: true },
      {
        factory: async (pi) => {
          // abort() cannot stop a pre-prompt compaction that only starts after preflight cancellation.
          pi.on("session_before_compact", () =>
            turn?.cancelled === true ? { cancel: true } : undefined,
          );
          await request.bridge(pi);
        },
        hidden: true,
        name: "subagents-child",
      },
    ],
    // The bridge replaces the root's own subagents extension inside children.
    extensionsOverride: (base) => ({
      ...base,
      extensions: base.extensions.filter(
        (extension) => !isSubagentHostExtensionPath(extension.resolvedPath),
      ),
    }),
    noContextFiles: true,
    noPromptTemplates: true,
    noSkills: true,
    noThemes: true,
    settingsManager,
    skillsOverride: () => ({ diagnostics: [], skills: promptOptions?.skills ?? [] }),
    ...(promptOptions?.customPrompt === undefined
      ? {}
      : { systemPrompt: promptOptions.customPrompt }),
  });

  await resourceLoader.reload();
  // Reload re-reads settings, so inherited activation is applied afterwards.
  settingsManager.applyOverrides({ defaultTools: [...request.tools] });
  const extensions = resourceLoader.getExtensions();

  if (!extensions.extensions.some((extension) => extension.path === CHILD_BRIDGE_PATH)) {
    const reason = extensions.errors.find((error) => error.path === CHILD_BRIDGE_PATH)?.error;
    throw new Error(`Unable to load the child collaboration bridge: ${reason ?? "not loaded"}`);
  }

  const { session } = await createAgentSession({
    agentDir,
    cwd: request.cwd,
    excludeTools: ROOT_ONLY_TOOLS,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager,
    settingsManager,
    ...(request.thinkingLevel === undefined ? {} : { thinkingLevel: request.thinkingLevel }),
  });

  let running: Promise<void> = Promise.resolve();
  let disposal: Promise<void> | undefined;
  /** Steered tasks the transcript has not shown yet, by message id. */
  const steered = new Map<string, (read: boolean) => void>();

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start" && turn !== undefined) {
      turn.run = session.agent.signal;
    }

    if (
      event.type === "message_end" &&
      event.message.role === "custom" &&
      event.message.customType === SUBAGENT_MESSAGE_TYPE &&
      Value.Check(MailDetailsSchema, event.message.details)
    ) {
      const { id } = event.message.details;
      const read = steered.get(id);

      if (read === undefined) {
        request.onDelivered(id);
      } else {
        steered.delete(id);
        read(true);
      }
    }
  });

  try {
    await session.bindExtensions({ mode: "print" });
  } catch (error) {
    unsubscribe();
    session.dispose();
    throw error;
  }

  const startTurn = async (text: string): Promise<ChildTurnOutcome> => {
    if (session.isStreaming || turn !== undefined) {
      throw new Error("Child is already running");
    }

    const current: Turn = {
      cancelled: false,
      preflight: true,
      preflightCancelled: Promise.withResolvers<undefined>(),
    };

    turn = current;
    const boundary = session.state.messages.at(-1);

    const prompt = session.prompt(text, {
      expandPromptTemplates: false,
      // Throwing here keeps a turn cancelled during preflight from starting its run.
      preflightResult: (disposition) => {
        if (current.cancelled) {
          throw new Error("Child turn was aborted");
        }

        if (disposition !== "started") {
          throw new Error("Child input did not produce a user turn");
        }

        current.preflight = false;
      },
      source: "extension",
    });

    running = (async () => {
      try {
        await prompt;
      } catch {
        // The outcome below reports the failure.
      } finally {
        turn = undefined;

        // Pi reads no more steering once the prompt settles, whatever the timing of the steer.
        for (const read of steered.values()) {
          read(false);
        }

        steered.clear();
      }
    })();

    try {
      await Promise.race([prompt, current.preflightCancelled.promise]);
    } catch (error) {
      return current.cancelled
        ? { status: "interrupted" }
        : { error: error instanceof Error ? error.message : String(error), status: "errored" };
    }

    if (current.cancelled && current.preflight) {
      return { status: "interrupted" };
    }

    const { messages } = session.state;
    const index = boundary === undefined ? -1 : messages.lastIndexOf(boundary);
    const outcome = finalFromMessages(messages.slice(index + 1), current.cancelled);

    // A tool aborting the run, for example, leaves its preliminary response as the last message.
    return outcome.status === "completed" && !current.cancelled && current.run?.aborted === true
      ? { error: "Turn was aborted", status: "errored" }
      : outcome;
  };

  const abort = (): void => {
    if (turn !== undefined) {
      turn.cancelled = true;

      if (turn.preflight) {
        turn.preflightCancelled.resolve(undefined);
      }
    }

    session.clearQueue();
    session.abort().catch(request.onError);
  };

  return {
    abort,
    deliver(mail) {
      session.sendCustomMessage(mailMessage(mail), { triggerTurn: false }).catch(request.onError);
    },
    dispose() {
      disposal ??= (async () => {
        abort();

        try {
          // Shutdown runs alongside the stopping run so handlers blocking preflight can release it.
          const [shutdown] = await Promise.allSettled([
            session.extensionRunner.emit({ reason: "quit", type: "session_shutdown" }),
            running,
          ]);

          if (shutdown.status === "rejected") {
            throw shutdown.reason;
          }
        } finally {
          unsubscribe();
          session.dispose();
        }
      })();

      return disposal;
    },
    get model() {
      // Selection stays readable after disposal for the controller's retirement snapshot.
      // Pi's type allows no model at all.
      const current = session.model ?? model;

      return `${current.provider}/${current.id}`;
    },
    sessionFile,
    startTurn,
    steer(task) {
      // Pi delivers queued steering after the prompt when the run starts, or at the next turn
      // boundary while it runs; the transcript, not Pi's state, shows whether it did.
      if (turn === undefined) {
        return undefined;
      }

      const id = randomUUID();
      const read = Promise.withResolvers<boolean>();
      steered.set(id, read.resolve);

      // sendCustomMessage would append the task at once before the run starts, ahead of the prompt.
      session.agent.steer({
        content: envelopeText(task),
        customType: SUBAGENT_MESSAGE_TYPE,
        details: { from: task.from, id, kind: task.kind, to: task.to },
        display: false,
        role: "custom",
        timestamp: Date.now(),
      });

      return read.promise;
    },
    get thinkingLevel() {
      return session.thinkingLevel;
    },
  };
};
