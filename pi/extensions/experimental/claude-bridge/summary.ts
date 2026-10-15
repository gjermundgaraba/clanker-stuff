// One-off summarizer calls (compaction, branch summaries, bug-report summaries,
// extension one-shots) run in their own Claude Code process with no session: they must
// not touch the live conversation, and they send the caller's prompt as Claude Code's own.

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";

import type { BridgeQuery, QueryFunction } from "./child.js";
import { childEnv, stopQuery } from "./child.js";
import { cliDebugOptions, debug, errorMessage } from "./log.js";
import { claudeCodeModelId, effortForReasoning } from "./models.js";
import { systemPromptText, toBridgeContext } from "./prompt.js";
import { logServedContextWindow, resultErrorText } from "./query/result.js";
import { sessionCwdFor, summarySessionFor } from "./session/cwd.js";
import { mapStopReason, newAssistantOutput } from "./translate.js";
import { extractUserPrompt } from "./turn.js";

export function isolatedSummaryStream(
  runQuery: QueryFunction,
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void runIsolatedSummary(runQuery, model, context, options, stream);

  return stream;
}

async function runIsolatedSummary(
  runQuery: QueryFunction,
  model: Model<Api>,
  transcript: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
): Promise<void> {
  // Pi delivers the summarization prompt as a leading system message; it reaches Claude
  // Code as the system prompt.
  const context = toBridgeContext(transcript);
  let sdkQuery: BridgeQuery | undefined;
  let wasAborted = false;

  const onAbort = (): void => {
    wasAborted = true;
    stopQuery(sdkQuery);
  };

  try {
    // Isolated calls carry no history or tools, so anything else would silently lose them.
    if (
      context.messages.length !== 1 ||
      context.messages[0]?.role !== "user" ||
      (context.tools?.length ?? 0) > 0
    ) {
      throw new Error(
        'claude-bridge runs cacheRetention "none" requests as isolated one-off calls, which take a single user message and no tools',
      );
    }

    const promptText = extractUserPrompt(context.messages);

    if (promptText === undefined || promptText === "") {
      throw new Error("isolated summary: no user prompt (last message is not user?)");
    }

    const cwd = sessionCwdFor(summarySessionFor(options?.signal) ?? options?.sessionId);
    const cliModel = claudeCodeModelId(model.id);
    const systemPrompt = systemPromptText(context.system);
    // Honours the caller's reasoning level, as the provider path does.
    const effort = effortForReasoning(model, options?.reasoning);

    debug(
      `compact summary: spawn model=${cliModel} registeredModel=${model.id} effort=${effort ?? "default"} promptLen=${promptText.length}`,
    );

    sdkQuery = runQuery({
      prompt: promptText,
      options: {
        cwd,
        env: childEnv(),
        settings: { autoMemoryEnabled: false },
        tools: [],
        strictMcpConfig: true,
        settingSources: [],
        skills: [],
        persistSession: false,
        ...(systemPrompt === undefined ? {} : { systemPrompt }),
        model: cliModel,
        maxTurns: 1,
        ...(effort === undefined ? {} : { effort }),
        ...cliDebugOptions("compact-summary"),
      },
    });

    if (options?.signal?.aborted === true) onAbort();
    else options?.signal?.addEventListener("abort", onAbort, { once: true });

    let assistantText = "";
    let finalText = "";
    let errorText: string | undefined;
    let stopReason: string | null = null;

    for await (const message of sdkQuery) {
      if (wasAborted) break;

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") assistantText += block.text;
        }
      } else if (message.type === "result") {
        logServedContextWindow("compact summary", message, model);
        errorText = resultErrorText(message);
        stopReason = message.stop_reason;

        if (errorText === undefined && message.subtype === "success") {
          finalText = message.result || assistantText;
        }
      }
    }

    if (wasAborted) {
      debug("compact summary: aborted");
      stream.push({
        type: "error",
        reason: "aborted",
        error: newAssistantOutput(model, "aborted", "", "Operation aborted"),
      });
      stream.end();

      return;
    }

    const text = finalText || assistantText;

    if (errorText !== undefined || text.trim() === "") {
      const failure = errorText ?? "Claude Code summary returned empty text";

      debug(`compact summary: error ${failure}`);
      stream.push({
        type: "error",
        reason: "error",
        error: newAssistantOutput(model, "error", "", failure),
      });
      stream.end();

      return;
    }

    // A truncated summary must say so: pi refuses to persist a "length" summary.
    const reason = mapStopReason(stopReason) === "length" ? "length" : "stop";

    debug(`compact summary: done reason=${reason} textLen=${text.length}`);
    stream.push({ type: "done", reason, message: newAssistantOutput(model, reason, text) });
    stream.end();
  } catch (error) {
    debug("isolated summary threw; pushing terminal error", error);
    stream.push({
      type: "error",
      reason: "error",
      error: newAssistantOutput(model, "error", "", errorMessage(error)),
    });
    stream.end();
  } finally {
    options?.signal?.removeEventListener("abort", onAbort);

    try {
      sdkQuery?.close();
    } catch {
      // Already gone.
    }
  }
}
