import type { ExtensionAPI, ExtensionContext, ToolExposure } from "@earendil-works/pi-coding-agent";
import type { Coordinator } from "./coordinator.js";
import { QuestionnaireParameters, RevisionParameters, validateRevision } from "./request.js";
import { renderCall, renderResult, renderReviseCall } from "./transcript.js";

const STRICT_PREFERRED = { type: "json_schema", strict: "prefer" } as const;

/** Questionnaires ask the user, so the tools are declared to the model but never script-callable. */
export function registerQuestionTools(
  pi: ExtensionAPI,
  coordinator: Coordinator,
  exposure: ToolExposure = "model-only",
): void {
  pi.registerTool({
    name: "request_user_input",
    exposure,
    label: "Questionnaire · blocking",
    description:
      "Ask 1–5 structured questions and wait for explicit reviewed answers. Supports Markdown context/previews, stable question/option IDs, recommendations and notes. Requires an interactive TUI session.",
    parameters: QuestionnaireParameters,
    constrainedSampling: STRICT_PREFERRED,
    executionMode: "sequential",
    promptSnippet: "Ask a questionnaire and wait for explicit user answers",
    promptGuidelines: [
      "Use request_user_input for concrete clarification instead of prose-only questionnaires. Supply unique IDs, concise labels/descriptions and recommendation metadata, never an Other option or preselected answer.",
    ],
    execute: async (id, params, signal, _update, ctx) =>
      coordinator.ask(id, params, signal, ctx, "blocking"),
    renderCall: (args, theme, context) => renderCall(args, theme, context, "blocking"),
    renderResult,
  });
  pi.registerTool({
    name: "request_user_input_async",
    exposure,
    label: "Questionnaire · async",
    description:
      "Request a durable questionnaire without waiting for its answer, using the same contract as request_user_input. Returns only pending acceptance; later submissions arrive as user messages. Acceptance is NOT an answer or permission. Continue only independent work. Requires an interactive TUI session.",
    parameters: QuestionnaireParameters,
    constrainedSampling: STRICT_PREFERRED,
    executionMode: "sequential",
    promptSnippet: "Request a durable questionnaire while continuing independent work",
    promptGuidelines: [
      "Use request_user_input_async only when independent work can continue. Pending acceptance is not answered or approved; stop work dependent on the missing answers until a submission arrives.",
    ],
    execute: async (id, params, signal, _update, ctx) =>
      coordinator.ask(id, params, signal, ctx, "async"),
    renderCall: (args, theme, context) => renderCall(args, theme, context, "async"),
    renderResult,
  });
  pi.registerTool({
    name: "revise_user_input",
    exposure,
    label: "Questionnaire · revision",
    description:
      "Reopen an answered questionnaire with its unchanged questions, giving its interaction_id, latest revision as base_revision and a reason. It waits or returns pending the same way the questionnaire was last asked.",
    parameters: RevisionParameters,
    constrainedSampling: STRICT_PREFERRED,
    executionMode: "sequential",
    promptSnippet: "Reopen an answered questionnaire for revised answers",
    promptGuidelines: [
      "revise_user_input reopens the same authored questions. For different questions author a new request with linked_interaction_id. Reconsider affected work after an answer revision; it does not undo prior actions.",
    ],
    execute: async (id, params, signal, _update, ctx) =>
      coordinator.revise(id, validateRevision(params), signal, ctx),
    renderCall: (args, theme, context) =>
      renderReviseCall(args, theme, context, (id) => coordinator.peek(id)?.request.title),
    renderResult,
  });
}

/** Without a terminal there is no one to ask: withdraw the tools so nothing can activate them. */
export function withdrawOutsideTui(
  pi: ExtensionAPI,
  coordinator: Coordinator,
  ctx: ExtensionContext,
): void {
  if (ctx.mode !== "tui" || !ctx.hasUI) registerQuestionTools(pi, coordinator, "hidden");
}
