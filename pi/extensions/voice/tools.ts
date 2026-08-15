import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const MAX_PRESENTATION_CHARS = 50_000;
const MAX_SPEECH_CHARS = 400;
const STRICT_SAMPLING = { strict: "prefer", type: "json_schema" } as const;

export const VOICE_TOOL_NAMES = [
  "speak_to_user",
  "present_voice_result",
  "end_realtime_voice_call",
] as const;

interface VoicePresentationDetails {
  delivered: boolean;
  markdown: string;
}

export interface VoiceToolDeps {
  endActiveCall: () => boolean;
  finish: (spokenSummary: string) => boolean;
  sendStatus: (message: string) => boolean;
}

export const registerVoiceTools = (
  pi: ExtensionAPI,
  deps: VoiceToolDeps
): void => {
  pi.registerTool({
    constrainedSampling: STRICT_SAMPLING,
    description:
      "Send one meaningful progress update to the active realtime voice handoff. Use only for a verified finding, material progress, a newly identified blocker, or a decision that matters while work continues. Never use for acknowledgements, generic checking or waiting updates, or the final result; the final assistant response is delivered automatically.",
    async execute(_toolCallId, params) {
      const message = params.message
        .replaceAll(/\s+/gu, " ")
        .trim()
        .slice(0, MAX_SPEECH_CHARS);
      const delivered = Boolean(message && deps.sendStatus(message));
      return {
        content: [
          {
            text: delivered
              ? "The update was sent to the active voice conversation."
              : "No active voice conversation was available.",
            type: "text" as const,
          },
        ],
        details: { delivered },
      };
    },
    label: "Speak to user",
    name: "speak_to_user",
    parameters: Type.Object(
      {
        message: Type.String({
          description:
            "One or two short spoken sentences without markdown or implementation detail.",
          maxLength: MAX_SPEECH_CHARS,
          minLength: 1,
        }),
      },
      { additionalProperties: false }
    ),
    promptGuidelines: [
      "During active voice chat, use speak_to_user only for meaningful non-final status; the final assistant response is delivered automatically.",
    ],
  });

  pi.registerTool({
    constrainedSampling: STRICT_SAMPLING,
    description:
      "Display substantial Markdown in the pi terminal and send only a concise spoken summary as the final response to the active realtime voice handoff. Use for reports, code, links, comparisons, plans, or other output that is better inspected than heard.",
    async execute(_toolCallId, params) {
      const markdown = params.markdown.trim();
      const spokenSummary = params.spokenSummary
        .replaceAll(/\s+/gu, " ")
        .trim();
      if (!markdown || !spokenSummary) {
        throw new Error(
          "Both terminal Markdown and a spoken summary are required."
        );
      }
      const delivered = deps.finish(spokenSummary);
      return {
        content: [
          {
            text: delivered
              ? "The terminal result was displayed and its spoken summary was sent."
              : "No active voice conversation was available.",
            type: "text" as const,
          },
        ],
        details: { delivered, markdown },
        terminate: delivered,
      };
    },
    label: "Present voice result",
    name: "present_voice_result",
    parameters: Type.Object(
      {
        markdown: Type.String({
          description:
            "Exact Markdown to display in the pi terminal without sending it to the realtime voice model.",
          maxLength: MAX_PRESENTATION_CHARS,
          minLength: 1,
        }),
        spokenSummary: Type.String({
          description:
            "One or two concise natural-language sentences summarizing the result for speech.",
          maxLength: MAX_SPEECH_CHARS,
          minLength: 1,
        }),
      },
      { additionalProperties: false }
    ),
    promptGuidelines: [
      "During active voice chat, call present_voice_result by itself after work is complete when substantial visual output is needed; it completes the handoff, so do not add a second final response.",
    ],
    renderResult(result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("muted", "Preparing terminal result…"), 0, 0);
      }
      const details = result.details as VoicePresentationDetails | undefined;
      if (details?.markdown === undefined || details.markdown === "") {
        return new Text(
          theme.fg("warning", "No terminal result was available."),
          0,
          0
        );
      }
      return new Markdown(details.markdown, 0, 0, getMarkdownTheme());
    },
  });

  pi.registerTool({
    constrainedSampling: STRICT_SAMPLING,
    description:
      "End the current realtime voice chat. Call when the user explicitly asks to end voice or clearly signs off with wording such as goodbye, talk to you later, or that is all for now. Do not call for a bare stop, a request to pause or be quiet, a request to stop only the current task, or a polite acknowledgement. This does not stop pi or ongoing work.",
    async execute() {
      const active = deps.endActiveCall();
      return {
        content: [
          {
            text: active
              ? "The realtime voice chat ended. Pi and ongoing work continue."
              : "No active realtime voice chat was available.",
            type: "text" as const,
          },
        ],
        details: { ended: active },
      };
    },
    label: "End realtime voice call",
    name: "end_realtime_voice_call",
    parameters: Type.Object({}, { additionalProperties: false }),
    promptGuidelines: [
      "Use end_realtime_voice_call for explicit voice-ending requests and clear conversational sign-offs, but not for pause, silence, task-stop, or acknowledgement requests.",
    ],
  });
};
