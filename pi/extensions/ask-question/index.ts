import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Coordinator } from "./coordinator.js";
import { RequestSchema, prepareAsyncArguments } from "./request.js";
import { createAnswerMarkdownTransformer, renderCall, renderResult } from "./transcript.js";

export default function askQuestion(pi: ExtensionAPI) {
  const coordinator = new Coordinator(pi);
  pi.registerMarkdownTransformer(createAnswerMarkdownTransformer(() => coordinator.list()));
  pi.registerTool({
    name: "request_user_input",
    label: "Questionnaire · blocking",
    description:
      "Ask 1–5 structured questions and wait for explicit reviewed answers. Supports Markdown context/previews, stable question/option IDs, recommendations, notes and revisions. To reopen unchanged questions use revise with interaction_id, latest base_revision and reason instead of questions. Requires a persistent interactive TUI session.",
    parameters: RequestSchema,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    executionMode: "sequential",
    promptSnippet: "Ask a questionnaire and wait for explicit user answers",
    promptGuidelines: [
      "Use request_user_input for concrete clarification instead of prose-only questionnaires. Supply unique IDs, concise labels/descriptions and recommendation metadata, never an Other option or preselected answer.",
      "request_user_input revisions reopen the same authored questions. For different questions author a new request with linked_interaction_id. Reconsider affected work after an answer revision; it does not undo prior actions.",
    ],
    execute: (id, params, signal, _update, ctx) =>
      coordinator.request(id, params, signal, ctx, "blocking"),
    renderCall: (args, theme, context) =>
      renderCall(args, theme, context, "blocking", (id) => coordinator.peek(id)?.request.title),
    renderResult,
  });
  pi.registerTool({
    name: "request_user_input_async",
    label: "Questionnaire · async",
    description:
      "Request a durable questionnaire without waiting for its answer, using the same questions or revise contract as request_user_input. Returns only pending acceptance; later submissions arrive as user messages. Acceptance is NOT an answer or permission. Continue only independent work. Requires a persistent interactive TUI session.",
    parameters: RequestSchema,
    prepareArguments: prepareAsyncArguments,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    executionMode: "sequential",
    promptSnippet: "Request a durable questionnaire while continuing independent work",
    promptGuidelines: [
      "Use request_user_input_async only when independent work can continue. Pending acceptance is not answered or approved; stop work dependent on the missing answers until a submission arrives.",
    ],
    execute: (id, params, signal, _update, ctx) =>
      coordinator.request(id, params, signal, ctx, "async"),
    renderCall: (args, theme, context) =>
      renderCall(args, theme, context, "async", (id) => coordinator.peek(id)?.request.title),
    renderResult,
  });
  pi.registerCommand("answers", {
    description: "Review, answer, resume or revise questionnaires on this branch",
    handler: (_args, ctx) => coordinator.answer(ctx),
  });
  pi.registerShortcut("alt+i", {
    description: "Open question inbox",
    handler: (ctx) => coordinator.answer(ctx),
  });
  pi.on("session_start", (_event, ctx) => coordinator.attach(ctx));
  pi.on("session_before_tree", (_event, ctx) => coordinator.beforeNavigation(ctx));
  pi.on("session_before_switch", (_event, ctx) => coordinator.beforeNavigation(ctx));
  pi.on("session_before_fork", (_event, ctx) => coordinator.beforeNavigation(ctx));
  pi.on("session_tree", (event, ctx) => coordinator.attach(ctx, event.newLeafId));
  pi.on("session_shutdown", () => coordinator.shutdown());
  pi.on("input", (_event, ctx) => coordinator.availability(ctx));
  pi.on("model_select", (_event, ctx) => coordinator.availability(ctx));
  pi.on("agent_start", (_event, ctx) => coordinator.observeRun(ctx));
  pi.on("turn_start", (_event, ctx) => coordinator.observeRun(ctx));
  pi.on("tool_call", (_event, ctx) => coordinator.observeRun(ctx));
  pi.on("agent_settled", (_event, ctx) => coordinator.settled(ctx));
}
