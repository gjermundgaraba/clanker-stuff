import type {
  ExtensionAPI,
  ExtensionContext,
  ToolExposure,
} from "@earendil-works/pi-coding-agent";

import type { Coordinator } from "./coordinator.js";
import { QuestionnaireParameters } from "./request.js";
import { renderCall, renderResult } from "./transcript.js";

export const registerQuestionTool = (
  pi: ExtensionAPI,
  coordinator: Coordinator,
  exposure: ToolExposure = "model-only"
): void => {
  pi.registerTool({
    name: "request_user_input",
    exposure,
    label: "Questionnaire",
    description:
      "Ask the user 1–5 structured questions with stable question/option IDs, Markdown context/previews, recommendations and notes. The user reviews before submitting. wait: true waits for the answers. wait: false returns a pending receipt at once and the answers, or a dismissal, arrive later as a user message carrying the same interaction_id; a pending receipt is NOT an answer or permission. Requires an interactive TUI session.",
    parameters: QuestionnaireParameters,
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    executionMode: "sequential",
    promptSnippet:
      "Ask the user a questionnaire, waiting for answers or continuing independent work",
    promptGuidelines: [
      "Use request_user_input for concrete clarification instead of prose-only questionnaires. Supply unique IDs, concise labels/descriptions and recommendation metadata, never an Other option or preselected answer.",
      "With request_user_input wait: false, continue only work that does not depend on the answers until they arrive. A dismissed questionnaire was not answered.",
    ],
    execute: async (id, params, signal, _update, ctx) =>
      await coordinator.ask(id, params, signal, ctx),
    renderCall,
    renderResult,
  });
};

/** Questionnaires need the interactive TUI; elsewhere the tool is withdrawn so nothing can activate it. */
export const withdrawOutsideTui = (
  pi: ExtensionAPI,
  coordinator: Coordinator,
  ctx: ExtensionContext
): void => {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    registerQuestionTool(pi, coordinator, "hidden");
  }
};
