// The `claude-bridge` provider: Claude Code models served through the Agent SDK.
//
// Each call finds its pi session's conversation, decides from pi's history what the call
// is (sync.ts), and hands it to the conversation machine: tool results to the query
// parked on them, or a new query that resumes or rebuilds Claude Code's session. Streams
// hold no state, so every evaluation registers and pi may call any of them.

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
import type { QueryFunction } from "./child.js";
import { conversationFor, ephemeralConversation, notifySession, settled } from "./conversations.js";
import type { Conversation } from "./conversations.js";
import { cliDebugOptions, debug, diagDump, errorMessage } from "./log.js";
import { syncState } from "./machine/conversation.js";
import { createToolServer, jsonSchema } from "./mcp-server.js";
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
import { sessionCwdFor } from "./session/cwd.js";
import { discardSession, rebuildSession } from "./session/rebuild.js";
import { matchedPrefix, plan, queryKey } from "./sync.js";
import type { Plan, RebuildReason } from "./sync.js";
import { MCP_SERVER_NAME, resolveServedTools } from "./tools.js";
import type { ServedTools } from "./tools.js";
import { Turn } from "./translate.js";
import { steerBlocks, turnStart } from "./turn.js";

/** The prompt a query opens with when pi's turn goes on from a tool result after its
 *  history was rewritten: query() cannot resume a session without a prompt. */
export const CONTINUE_AFTER_REWRITE_PROMPT =
  "[Your context was compacted. What precedes this is a summary plus the most recent messages, " +
  "ending with the tool result you were waiting for. Continue the task from there.]";

/** The same, when no query was parked on the result (a restart, a failed query). */
export const CONTINUE_AFTER_RESUME_PROMPT =
  "[Your session was interrupted and resumed. What precedes this ends with the tool result " +
  "you were waiting for. Continue the task from there.]";

export interface ProviderDeps {
  runQuery: QueryFunction;
  /** Each pi tool's prompt guidelines by name, appended to its MCP description. */
  toolGuidelines: () => ReadonlyMap<string, readonly string[]>;
}

export const providerConfig = (deps: ProviderDeps): ProviderConfig => ({
  baseUrl: PROVIDER_ID,
  apiKey: "not-used",
  api: PROVIDER_ID,
  models: applyLongContext(catalogModels()),
  streamSimple: (model, transcript, options) => streamClaudeCode(deps, model, transcript, options),
});

export function streamClaudeCode(
  deps: ProviderDeps,
  model: Model<Api>,
  transcript: TranscriptContext,
  options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
  const context = toBridgeContext(transcript);
  const served = resolveServedTools(context.tools, deps.toolGuidelines());
  const turn = new Turn(model, createAssistantMessageEventStream(), served.toPi);

  const key = queryKey(
    context,
    claudeCodeModelId(model.id),
    effortForReasoning(model, options?.reasoning),
  );

  serve({ deps, model, context, options, served, turn, key }).catch((error: unknown) => {
    debug("provider: request failed", errorMessage(error));

    if (!turn.ended) turn.fail(errorMessage(error));
  });

  return turn.stream;
}

interface Request {
  deps: ProviderDeps;
  model: Model<Api>;
  context: BridgeContext;
  options: SimpleStreamOptions | undefined;
  served: ServedTools;
  /** This call's answer: everything reaches pi through it. */
  turn: Turn;
  /** What a query started for this call is fixed to (`queryKey`). */
  key: string;
}

const describePlan = (decision: Plan): string =>
  decision.kind === "rebuild" ? `rebuild reason=${decision.reason}` : decision.kind;

async function serve(request: Request): Promise<void> {
  const { context, options, turn } = request;
  const piSession = options?.sessionId;

  // pi passes its session id on every agent turn, so a call without one is an
  // extension's one-off. Compaction, branch and bug-report summaries come with a session
  // id pi minted for the call, and cacheRetention "none". Neither continues a
  // conversation.
  if (piSession === undefined || options?.cacheRetention === "none") {
    debug(`sync: side (${piSession === undefined ? "no pi session" : "cacheRetention none"})`);
    await runOneOff(request);

    return;
  }

  const conversation = conversationFor(piSession, request.deps.runQuery);
  const snapshot = await settled(conversation);
  const state = syncState(snapshot);

  const decision = plan(state, {
    context,
    key: request.key,
    aborted: options?.signal?.aborted === true,
  });

  debug(`sync: ${describePlan(decision)} msgs=${context.messages.length}`);

  if (decision.kind === "rebuild" && decision.reason !== "none") {
    const at = matchedPrefix(context.messages, state.held);

    debug(
      `sync: held ${state.held.length}, first difference at ${at}: held=${state.held[at]?.role ?? "-"} pi=${context.messages[at]?.role ?? "-"}`,
    );
  }

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

  if (decision.kind === "side") {
    await runOneOff(request);

    return;
  }

  // After an abort during a tool call, pi calls back with the run's aborted signal and
  // the tool's result: end the turn, so pi waits for the next real message.
  if (decision.kind === "finish") {
    turn.finish();

    return;
  }

  // Refused before anything is touched: a parked query stays for pi's next request.
  const append = forwardedPrompt(context.system);

  // Pi owns the prompt: rendered fresh on every request rather than recorded in the
  // session, where a resume would keep the old one.
  const systemPrompt: SystemPrompt = {
    type: "preset",
    preset: "claude_code",
    snapshot: false,
    ...(append === undefined ? {} : { append }),
  };

  if (snapshot.matches("active")) conversation.send({ type: "pi.discard" });

  const cwd = sessionCwdFor(piSession);

  if (decision.kind === "resume") {
    startQuery(request, conversation, {
      systemPrompt,
      cwd,
      resume: decision.session,
      turn: decision.turn,
    });

    return;
  }

  const resume = rebuildSession(
    {
      priors: decision.priors,
      cwd,
      toSdk: request.served.toSdk,
      modelId: claudeCodeModelId(request.model.id),
      previous: state.session,
    },
    (message) => notifySession(piSession, message),
  );

  startQuery(request, conversation, {
    systemPrompt,
    cwd,
    resume,
    turn: decision.turn,
    reason: decision.reason,
  });
}

/** A request that is no session's conversation: a summary, an extension's one-off, or a
 *  call made beside a running query. It runs in a conversation of its own over a session
 *  written from its history and deleted afterwards, under its own system prompt rather
 *  than Claude Code's. Its tools are not served: no later call could deliver their
 *  results to it. */
async function runOneOff(request: Request): Promise<void> {
  const { context, options } = request;
  const system = forwardedPrompt(context.system);
  const piSession = options?.sessionId;
  const cwd = sessionCwdFor(piSession);
  const start = turnStart(context.messages);
  const unserved: Request = { ...request, served: resolveServedTools([]) };

  const resume = rebuildSession(
    {
      priors: context.messages.slice(0, start),
      cwd,
      toSdk: unserved.served.toSdk,
      modelId: claudeCodeModelId(request.model.id),
      previous: undefined,
    },
    (message) => notifySession(piSession, message),
  );

  const conversation = ephemeralConversation(request.deps.runQuery, piSession);

  startQuery(unserved, conversation, {
    systemPrompt: system,
    cwd,
    resume,
    turn: context.messages.slice(start),
  });

  const done = await waitFor(conversation, (snapshot) => snapshot.matches("idle"));

  conversation.stop();

  // The session written for it, and the one Claude Code reported (the same on a resume).
  for (const sessionId of new Set([resume, done.context.ccSessionId])) {
    if (sessionId !== undefined) discardSession(sessionId, cwd);
  }
}

type SystemPrompt = NonNullable<Options["systemPrompt"]>;

interface QueryStart {
  /** Claude Code's system prompt; none leaves the SDK's empty default. */
  systemPrompt: SystemPrompt | undefined;
  cwd: string;
  /** The Claude Code session to resume, or none for a clean start. */
  resume: string | undefined;
  /** The messages the query sends as its prompt. */
  turn: readonly Message[];
  /** Why the session was rebuilt, when it was. */
  reason?: RebuildReason;
}

function startQuery(request: Request, conversation: Conversation, start: QueryStart): void {
  const { model, context, options, served, turn } = request;
  const cliModel = claudeCodeModelId(model.id);
  const effort = effortForReasoning(model, options?.reasoning);
  // Always streamed rather than passed as a string: a parked input generator is what
  // lets steers reach stdin mid-turn. The machine closes it on the result.
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
    // Pi owns context files, skills and settings. No filesystem settings means no
    // CLAUDE.md, rules, hooks or permissions of the user's own Claude Code setup; the
    // login lives outside them.
    settingSources: [],
    skills: [],
    // Claude Code would otherwise load MCP servers from ~/.claude.json and .mcp.json;
    // pi executes tools, so they are pure token overhead.
    strictMcpConfig: true,
    settings: {
      autoMemoryEnabled: false,
      // The git-status block is the trailing suffix of the cached system block, so any
      // git transition (new file, staging, commit) would bust the prompt cache for the
      // whole conversation. It costs nothing here: the provider path runs no native tools.
      includeGitInstructions: false,
    },
    ...(start.systemPrompt === undefined ? {} : { systemPrompt: start.systemPrompt }),
    // Some models default thinking display to "omitted" (empty thinking text in the
    // stream). A raw flag: the typed option exists only inside a thinking mode, which
    // would force one on every model.
    ...(effort === undefined ? {} : { effort, extraArgs: { "thinking-display": "summarized" } }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(start.resume === undefined ? {} : { resume: start.resume }),
    ...cliDebugOptions("provider"),
  };

  debug(
    "provider: query",
    `model=${cliModel} msgs=${context.messages.length} tools=${served.tools.length}`,
    `resume=${start.resume?.slice(0, 8) ?? "none"}`,
  );

  conversation.send({
    type: "pi.start",
    turn,
    params: { prompt: promptStream.stream, options: queryOptions },
    promptStream,
    key: request.key,
    model,
    signal: options?.signal,
    // Claude Code holds pi's whole history once it reads the prompt: the session has
    // everything before the turn, and the prompt is the turn.
    held: context.messages,
  });
}

/** The query's prompt: the user turn, or word of why the turn goes on without one. */
function firstMessage(context: BridgeContext, start: QueryStart): SDKUserMessage {
  const blocks = steerBlocks(start.turn);

  if (blocks !== undefined) return userMessage(blocks);

  return userMessage([{ type: "text", text: continuePrompt(context, start.reason) }]);
}

function continuePrompt(context: BridgeContext, reason: RebuildReason | undefined): string {
  if (context.messages.at(-1)?.role === "toolResult") {
    return reason === "diverged" ? CONTINUE_AFTER_REWRITE_PROMPT : CONTINUE_AFTER_RESUME_PROMPT;
  }

  diagDump("empty_prompt", {
    contextLength: context.messages.length,
    lastMsgRole: context.messages.at(-1)?.role ?? null,
    messageRoles: context.messages.map((message, index) => `[${index}]${message.role}`).join(" "),
  });

  // So the SDK does not send an empty text block.
  return "[continue]";
}

// pi's tools over MCP. A handler holds Claude Code's tools/call until the conversation
// answers it with pi's result for the call.
function toolServers(
  served: ServedTools,
  conversation: Conversation,
): Record<string, McpSdkServerConfigWithInstance> | undefined {
  if (served.tools.length === 0) return undefined;

  const server = createToolServer(
    MCP_SERVER_NAME,
    served.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: jsonSchema(tool.name, tool.parameters),
      handler: (toolCallId: string) =>
        new Promise((resolve) => {
          conversation.send({ type: "cc.toolCall", id: toolCallId, resolve });
        }),
    })),
  );

  return { [MCP_SERVER_NAME]: server };
}
