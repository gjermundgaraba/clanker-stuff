import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  AsyncMessageParameters,
  AsyncQuestionParameters,
  createAsyncInput,
  renderAttention,
} from "./async.js";
import { AskQuestionParametersSchema, MAX_QUESTIONS, executeAskQuestion } from "./tool.js";

export default function askQuestion(pi: ExtensionAPI) {
  const asyncInput = createAsyncInput(pi);
  pi.registerTool({
    constrainedSampling: { strict: "prefer", type: "json_schema" },
    description:
      "Ask one or more structured clarification questions and return machine-readable answers.",
    execute: (_toolCallId, params, signal, _onUpdate, ctx) =>
      executeAskQuestion(pi, params, signal, ctx),
    executionMode: "sequential",
    label: "Ask Question",
    name: "ask_question",
    parameters: AskQuestionParametersSchema,
    promptGuidelines: [
      "When using ask_question, mark likely defaults with '(Suggested)' and explain why in option.details.",
      "For ask_question, do not include an 'Other' option; the UI always provides a free-text Other field.",
      "For ask_question, set multiSelect only when several answers are valid at once.",
      `For ask_question, ask at most ${MAX_QUESTIONS} questions per call; use multiple ask_question calls if needed.`,
    ],
    promptSnippet: "Ask structured clarification questions and return machine-readable answers",
  });
  pi.registerTool({
    name: "request_user_input_async",
    label: "Ask asynchronously",
    description:
      "Ask the user one or more questions during ongoing work. Use this tool only to request missing information, preferences, constraints, clarification, or approval. The tool returns immediately without ending the turn or waiting for a reply; any reply arrives asynchronously as a new user message. Keep questions concise, self-contained, and easy to understand. A preselected option is not submitted automatically.",
    parameters: AsyncQuestionParameters,
    executionMode: "sequential",
    execute: async (id, params, signal, _onUpdate, ctx) =>
      asyncInput.request(id, params, signal, ctx),
  });
  pi.registerTool({
    name: "send_message_to_user_async",
    label: "Message for you",
    description:
      "Send a concise message that needs the user's attention during ongoing work. The tool returns immediately without ending the turn or waiting for a reply; any reply arrives asynchronously as a new user message. Use this tool to report a critical blocker or a finding that may change the task's direction, or to answer a user question or status request received while work is still in progress. Use commentary for routine progress and intermediate context.",
    parameters: AsyncMessageParameters,
    executionMode: "sequential",
    execute: async (_id, params, _signal, _onUpdate, ctx) => asyncInput.message(params, ctx),
  });
  pi.registerCommand("answers", {
    description: "Answer or dismiss pending asynchronous questions",
    handler: (_args, ctx) => asyncInput.answer(ctx),
  });
  pi.registerEntryRenderer("async-attention", renderAttention);
  pi.on("session_start", () => asyncInput.dispose());
  pi.on("session_tree", () => asyncInput.dispose());
  pi.on("session_shutdown", () => asyncInput.dispose());
}
