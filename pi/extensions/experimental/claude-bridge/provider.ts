import type {
  McpSdkServerConfigWithInstance,
  Options,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEventStream,
  Message,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { waitFor } from "xstate";

import { childEnv } from "./child.js";
import { toJsonObject } from "./json.js";
import { cliDebugOptions, debug, diagDump, errorMessage } from "./log.js";
import { syncState } from "./machine/conversation.js";
import { createToolServer } from "./mcp-server.js";
import type { McpResult } from "./mcp-server.js";
import {
  applyLongContext,
  catalogModels,
  claudeCodeModelId,
  effortForReasoning,
} from "./models.js";
import { forwardedPrompt, toBridgeContext } from "./prompt.js";
import type { BridgeContext } from "./prompt.js";
import { makePromptStream, userMessage } from "./query/prompt-stream.js";
import { PROVIDER_ID } from "./session/convert.js";
import { discardSession, rebuildSession } from "./session/rebuild.js";
import { settled } from "./sessions.js";
import type { Conversation, Sessions } from "./sessions.js";
import { plan, queryKey } from "./sync.js";
import type { Plan } from "./sync.js";
import { MCP_SERVER_NAME, resolveServedTools } from "./tools.js";
import type { ServedTools } from "./tools.js";
import { Turn } from "./translate.js";
import { turnStart, userTurnBlocks } from "./turn.js";

/** The prompt a query opens with when pi's turn goes on from a tool result no query was
 *  waiting on (a rewritten history, a restart, a failed query): query() cannot resume a
 *  session without a prompt. */
export const CONTINUE_PROMPT =
  "[Your session was restarted from its history. What precedes this ends with the tool " +
  "result you were waiting for. Continue the task from there.]";

export interface ProviderDeps {
  /** The pi sessions this load of the extension serves, and how it starts queries. */
  sessions: Sessions;
  /** Each pi tool's prompt guidelines by name, appended to its MCP description. */
  toolGuidelines: () => ReadonlyMap<string, readonly string[]>;
}

interface Request {
  deps: ProviderDeps;
  model: Model<Api>;
  context: BridgeContext;
  options: SimpleStreamOptions | undefined;
  served: ServedTools;
  key: string;
  answer: (tools: ServedTools, options?: { requireText?: boolean }) => Turn;
}

const describePlan = (decision: Plan): string =>
  decision.kind === "rebuild"
    ? `rebuild reason=${decision.reason}`
    : decision.kind;

type SystemPrompt = NonNullable<Options["systemPrompt"]>;

interface QueryStart {
  systemPrompt: SystemPrompt | undefined;
  cwd: string;
  resume: string | undefined;
  turn: readonly Message[];
}

const toolServers = (
  served: ServedTools,
  conversation: Conversation
): Record<string, McpSdkServerConfigWithInstance> | undefined => {
  if (served.tools.length === 0) {
    return undefined;
  }

  const server = createToolServer(
    MCP_SERVER_NAME,
    served.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: toJsonObject(tool.parameters) ?? {},
      handler: async (toolCallId: string) => {
        const { promise, resolve } = Promise.withResolvers<McpResult>();

        conversation.send({ type: "cc.toolCall", id: toolCallId, resolve });

        return await promise;
      },
    }))
  );

  return { [MCP_SERVER_NAME]: server };
};

const firstMessage = (
  context: BridgeContext,
  start: QueryStart
): SDKUserMessage => {
  const blocks = userTurnBlocks(start.turn);

  if (blocks !== undefined) {
    return userMessage(blocks);
  }

  if (context.messages.at(-1)?.role === "toolResult") {
    return userMessage([{ type: "text", text: CONTINUE_PROMPT }]);
  }

  diagDump("empty_prompt", {
    contextLength: context.messages.length,
    lastMsgRole: context.messages.at(-1)?.role ?? null,
    messageRoles: context.messages
      .map((message, index) => `[${index}]${message.role}`)
      .join(" "),
  });

  return userMessage([{ type: "text", text: "[continue]" }]);
};

const startQuery = (
  request: Request,
  turn: Turn,
  conversation: Conversation,
  start: QueryStart
): void => {
  const { model, context, options, served } = request;
  const cliModel = claudeCodeModelId(model.id);
  const effort = effortForReasoning(model, options?.reasoning);
  const promptStream = makePromptStream();

  promptStream.push(firstMessage(context, start)).catch((error: unknown) => {
    debug("provider: initial prompt push rejected:", error);
  });

  const mcpServers = toolServers(served, conversation);

  const queryOptions: Options = {
    cwd: start.cwd,
    env: childEnv(),
    model: cliModel,
    tools: [],
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
    settingSources: [],
    skills: [],
    strictMcpConfig: true,
    verbatimPrompts: true,
    settings: {
      autoMemoryEnabled: false,
      includeGitInstructions: false,
    },
    ...(start.systemPrompt === undefined
      ? {}
      : { systemPrompt: start.systemPrompt }),
    ...(effort === undefined
      ? {}
      : { effort, extraArgs: { "thinking-display": "summarized" } }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(start.resume === undefined ? {} : { resume: start.resume }),
    ...cliDebugOptions("provider"),
  };

  debug(
    "provider: query",
    `model=${cliModel} msgs=${context.messages.length} tools=${served.tools.length}`,
    `resume=${start.resume?.slice(0, 8) ?? "none"}`
  );

  conversation.send({
    type: "pi.start",
    turn,
    params: { prompt: promptStream.stream, options: queryOptions },
    promptStream,
    key: request.key,
    model,
    signal: options?.signal,
    held: context.messages,
  });
};

const runOneOff = async (request: Request): Promise<void> => {
  const { context, options } = request;
  const system = forwardedPrompt(context.system);
  const piSession = options?.sessionId;
  const cwd = request.deps.sessions.cwd(piSession);
  const start = turnStart(context.messages);
  const unserved: Request = { ...request, served: resolveServedTools([]) };
  const turn = request.answer(unserved.served, { requireText: true });

  const resume = rebuildSession({
    priors: context.messages.slice(0, start),
    cwd,
    modelId: claudeCodeModelId(request.model.id),
    previous: undefined,
  });

  const conversation = request.deps.sessions.ephemeral(piSession);

  startQuery(unserved, turn, conversation, {
    systemPrompt: system,
    cwd,
    resume,
    turn: context.messages.slice(start),
  });

  const done = await waitFor(conversation, (snapshot) =>
    snapshot.matches("idle")
  );

  conversation.stop();

  for (const sessionId of new Set([resume, done.context.ccSessionId])) {
    if (sessionId !== undefined) {
      discardSession(sessionId, cwd);
    }
  }
};

const serve = async (request: Request): Promise<void> => {
  const { context, options } = request;
  const piSession = options?.sessionId;

  if (piSession === undefined || options?.cacheRetention === "none") {
    debug(
      `sync: side (${piSession === undefined ? "no pi session" : "cacheRetention none"})`
    );
    await runOneOff(request);

    return;
  }

  const conversation = request.deps.sessions.conversation(piSession);
  const snapshot = await settled(conversation);
  const state = syncState(snapshot);

  const decision = plan(state, {
    context,
    key: request.key,
    aborted: options?.signal?.aborted === true,
  });

  debug(`sync: ${describePlan(decision)} msgs=${context.messages.length}`);

  if (decision.kind === "rebuild" && decision.reason !== "none") {
    const at = decision.matched;

    debug(
      `sync: held ${state.held.length}, first difference at ${at}: held=${state.held[at]?.role ?? "-"} pi=${context.messages[at]?.role ?? "-"}`
    );
  }

  if (decision.kind === "side") {
    await runOneOff(request);

    return;
  }

  const turn = request.answer(request.served);

  if (decision.kind === "deliver") {
    conversation.send({
      type: "pi.deliver",
      turn,
      results: decision.results,
      steer: decision.steer,
      signal: options?.signal,
    });

    return;
  }

  if (decision.kind === "finish") {
    turn.finish();

    return;
  }

  const append = forwardedPrompt(context.system);

  const systemPrompt: SystemPrompt = {
    type: "preset",
    preset: "claude_code",
    snapshot: false,
    ...(append === undefined ? {} : { append }),
  };

  if (snapshot.matches("active")) {
    conversation.send({ type: "pi.discard" });
  }

  const cwd = request.deps.sessions.cwd(piSession);

  if (decision.kind === "resume") {
    startQuery(request, turn, conversation, {
      systemPrompt,
      cwd,
      resume: decision.session,
      turn: decision.turn,
    });

    return;
  }

  const resume = rebuildSession({
    priors: decision.priors,
    cwd,
    modelId: claudeCodeModelId(request.model.id),
    previous: state.session,
  });

  startQuery(request, turn, conversation, {
    systemPrompt,
    cwd,
    resume,
    turn: decision.turn,
  });
};

export const streamClaudeCode = (
  deps: ProviderDeps,
  model: Model<Api>,
  transcript: TranscriptContext,
  options: SimpleStreamOptions | undefined
): AssistantMessageEventStream => {
  const context = toBridgeContext(transcript);
  const served = resolveServedTools(context.tools, deps.toolGuidelines());
  const stream = createAssistantMessageEventStream();
  let turn: Turn | undefined;

  const key = queryKey(
    context,
    claudeCodeModelId(model.id),
    effortForReasoning(model, options?.reasoning)
  );

  const answer: Request["answer"] = (tools, turnOptions) => {
    turn = new Turn(model, stream, tools.names, turnOptions);

    return turn;
  };

  serve({ deps, model, context, options, served, key, answer }).catch(
    (error: unknown) => {
      debug("provider: request failed", errorMessage(error));

      const failing = turn ?? answer(resolveServedTools([]));

      if (!failing.ended) {
        failing.fail(errorMessage(error));
      }
    }
  );

  return stream;
};

export const providerConfig = (deps: ProviderDeps): ProviderConfig => ({
  baseUrl: PROVIDER_ID,
  apiKey: "not-used",
  api: PROVIDER_ID,
  models: applyLongContext(catalogModels()),
  streamSimple: (model, transcript, options) =>
    streamClaudeCode(deps, model, transcript, options),
});
