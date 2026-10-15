// One-off summarizer calls (compaction, branch summaries, bug-report summaries,
// extension one-shots) run in their own Claude Code process with no session: they must
// not touch the live conversation, and their prompts bypass prompt capture.

import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";

import type { Bridge, BridgeQuery } from "./bridge.js";
import { childEnv, stopQuery } from "./child.js";
import { cliDebugOptions, debug, errorMessage } from "./log.js";
import { claudeCodeModelId, effortForReasoning } from "./models.js";
import { toBridgeContext } from "./prompt/transcript.js";
import { logServedContextWindow, resultErrorText } from "./query/consume.js";
import { newAssistantOutput } from "./query/context.js";
import { sessionCwdFor, summarySessionFor } from "./session/cwd.js";
import { extractUserPrompt } from "./turn.js";

export function isolatedSummaryStream(
  bridge: Bridge,
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void runIsolatedSummary(bridge, model, context, options, stream);

  return stream;
}

async function runIsolatedSummary(
  bridge: Bridge,
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
    const promptText = extractUserPrompt(context.messages);

    if (promptText === undefined || promptText === "") {
      throw new Error("isolated summary: no user prompt (last message is not user?)");
    }

    const cwd = sessionCwdFor(summarySessionFor(options?.signal) ?? options?.sessionId);
    const cliModel = claudeCodeModelId(model.id);
    // Honours the caller's reasoning level, as the provider path does.
    const effort = effortForReasoning(model, options?.reasoning);

    debug(
      `compact summary: spawn model=${cliModel} registeredModel=${model.id} effort=${effort ?? "default"} promptLen=${promptText.length}`,
    );

    sdkQuery = bridge.runQuery({
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
        ...(context.systemPrompt === undefined ? {} : { systemPrompt: context.systemPrompt }),
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

    for await (const message of sdkQuery) {
      if (wasAborted) break;

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "text") assistantText += block.text;
        }
      } else if (message.type === "result") {
        logServedContextWindow("compact summary", message, model);
        errorText = resultErrorText(message);

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

    debug(`compact summary: done textLen=${text.length}`);
    stream.push({ type: "done", reason: "stop", message: newAssistantOutput(model, "stop", text) });
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
