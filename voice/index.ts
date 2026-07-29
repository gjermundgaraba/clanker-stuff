import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { VoiceCoordinator } from "./coordinator.js";
import { MediaProcess } from "./media-process.js";
import type { VoiceAuth, VoiceDelegation, VoiceState } from "./realtime.js";
import { VoiceSession } from "./realtime.js";
import { createVoiceTrace } from "./trace.js";
import {
  formatDelegation,
  formatTranscriptTail,
  parsePersistedTranscript,
} from "./transcript.js";
import type { TranscriptEntry } from "./transcript.js";

const STATUS_KEY = "voice";
const CONTINUITY_ENTRY = "voice-continuity";
const MAX_PRESENTATION_CHARS = 50_000;
const MAX_SPEECH_CHARS = 400;
const COORDINATOR_INSTRUCTIONS = `## Realtime voice coordination

You are coordinating an active realtime voice chat. The realtime model handles low-latency conversation; this pi session is the authoritative execution and state layer of the same assistant.

Treat realtime delegation input as speech transcript that may contain recognition errors. The <input> is the current request. <transcript_delta> is mechanical conversation context since the previous delegation and may include unrelated discussion.

Handle conversation, quick checks, and interactive decisions here. For slow or independent work, use existing agent-orchestration capabilities when they are already available and useful; do not assume a particular agent host exists. Running work remains steerable.

Never claim an action completed without checking the actual result.

Your terminal assistant response is automatically returned to the active voice handoff as its single [COMPLETE] message unless present_voice_result completes the handoff first. Do not add protocol tags to your response and do not call speak_to_user for the final result.

Use present_voice_result when the user needs substantial Markdown, code, links, a comparison, a plan, or other content best inspected in the pi terminal. Put the exact visual content in markdown and a concise natural-language takeaway in spokenSummary. The tool displays the Markdown without sending it to the realtime model and completes the voice handoff.

speak_to_user sends a [STATUS] update for the active handoff. Use it only for a verified finding, concrete user-relevant progress, a newly identified blocker, or a decision that matters while work continues. Never use it for an acknowledgement, intent, reassurance, “checking,” “still working,” elapsed time, or repeated information. After one meaningful update, remain silent until there is another material change or the terminal response is ready.

Call end_realtime_voice_call for an explicit request to end voice or a clear conversational sign-off such as “goodbye,” “talk to you later,” or “that’s all for now.” Do not end voice for a bare “stop,” a request to pause or be quiet, a request to stop only the current task, or a merely polite acknowledgement.

Ending voice never ends this pi session or its ongoing work.`;

interface VoicePresentationDetails {
  delivered: boolean;
  markdown: string;
}

type RuntimeState =
  | "stopped"
  | "starting"
  | "connecting"
  | "active"
  | "paused"
  | "failed";

const messageText = (message: {
  content: string | readonly unknown[];
}): string =>
  (typeof message.content === "string" ? [message.content] : message.content)
    .flatMap((part) => {
      if (typeof part === "string") {
        return [part];
      }
      if (
        part !== null &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return [part.text];
      }
      return [];
    })
    .join("\n")
    .trim();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const accountIdFromAccessToken = (accessToken: string): string => {
  try {
    const parts = accessToken.split(".");
    const [, encodedPayload] = parts;
    if (parts.length !== 3 || !encodedPayload) {
      throw new Error("not a JWT");
    }
    const payload: unknown = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf-8")
    );
    if (!isRecord(payload)) {
      throw new Error("invalid JWT payload");
    }
    const auth = payload["https://api.openai.com/auth"];
    const accountId =
      auth !== null &&
      typeof auth === "object" &&
      "chatgpt_account_id" in auth &&
      typeof auth.chatgpt_account_id === "string"
        ? auth.chatgpt_account_id
        : undefined;
    if (accountId === undefined || accountId.length === 0) {
      throw new Error("account ID missing");
    }
    return accountId;
  } catch {
    throw new Error(
      "OpenAI Codex OAuth token does not contain a ChatGPT account ID."
    );
  }
};

const validateCoordinator = async (ctx: ExtensionContext): Promise<void> => {
  if (!ctx.model) {
    throw new Error("Select a Pi coordinator model before starting voice.");
  }
  const { id, provider } = ctx.model;
  const model = ctx.modelRegistry
    .getAll()
    .find(
      (candidate) => candidate.provider === provider && candidate.id === id
    );
  if (!model) {
    throw new Error("The selected Pi coordinator model is unavailable.");
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(auth.error);
  }
};

const voiceExtension = (pi: ExtensionAPI): void => {
  const trace = createVoiceTrace();
  let context: ExtensionContext | undefined;
  let media: MediaProcess | undefined;
  let persistedTranscript: TranscriptEntry[] = [];
  let persistedTranscriptSignature = "[]";
  let runtimeState: RuntimeState = "stopped";
  let startupGeneration = 0;
  let voice: VoiceSession | undefined;

  const updateStatus = (ctx: ExtensionContext): void => {
    const label = {
      active: ctx.ui.theme.fg("success", "🎙 voice"),
      connecting: ctx.ui.theme.fg("warning", "🎙 connecting"),
      failed: ctx.ui.theme.fg("error", "🎙 failed"),
      paused: ctx.ui.theme.fg("muted", "🎙 paused"),
      starting: ctx.ui.theme.fg("warning", "🎙 starting"),
      stopped: undefined,
    }[runtimeState];
    ctx.ui.setStatus(STATUS_KEY, label);
  };

  const setState = (state: RuntimeState): void => {
    runtimeState = state;
    if (context !== undefined) {
      updateStatus(context);
    }
    media?.sendState(state);
  };

  const resolveVoiceAuth = async (
    ctx: ExtensionContext
  ): Promise<VoiceAuth> => {
    const result = await ctx.modelRegistry.getProviderAuth("openai-codex");
    const accessToken = result?.auth.apiKey;
    if (accessToken === undefined || accessToken.length === 0) {
      throw new Error(
        "OpenAI Codex OAuth is not configured. Run /login and choose OpenAI Codex."
      );
    }
    return {
      accessToken,
      accountId: accountIdFromAccessToken(accessToken),
    };
  };

  const coordinator = new VoiceCoordinator({
    complete: (binding, text) => Boolean(voice?.sendComplete(binding, text)),
    status: (binding, text) => Boolean(voice?.sendStatus(binding, text)),
    submit: (prompt) => {
      pi.sendUserMessage(prompt, { deliverAs: "steer" });
    },
    validate: async () => {
      if (!context) {
        throw new Error("The Pi session is not ready.");
      }
      await validateCoordinator(context);
    },
  });

  const handleDelegation = (event: VoiceDelegation): void => {
    coordinator.enqueue({
      binding: event.binding,
      prompt: formatDelegation(event.input, event.transcriptDelta),
    });
  };

  const persistContinuity = (currentVoice = voice): void => {
    const entries = currentVoice?.recentTranscript() ?? persistedTranscript;
    const signature = JSON.stringify(entries);
    persistedTranscript = entries;
    if (signature === persistedTranscriptSignature) {
      return;
    }
    pi.appendEntry(CONTINUITY_ENTRY, { entries });
    persistedTranscriptSignature = signature;
  };

  const stop = (
    options: { flushTail?: boolean; persist?: boolean } = {}
  ): void => {
    startupGeneration += 1;
    const currentVoice = voice;
    if (options.persist !== false) {
      persistContinuity(currentVoice);
    }
    const transcriptTail =
      options.flushTail === false
        ? []
        : (currentVoice?.takeTranscriptTail() ?? []);
    coordinator.reset();
    media?.stop();
    voice?.dispose();
    media = undefined;
    voice = undefined;
    setState("stopped");
    if (transcriptTail.length > 0) {
      pi.sendUserMessage(formatTranscriptTail(transcriptTail), {
        deliverAs: "followUp",
      });
    }
  };

  const start = async (ctx: ExtensionContext): Promise<void> => {
    if (runtimeState !== "stopped" && runtimeState !== "failed") {
      ctx.ui.notify(`Voice is already ${runtimeState}.`, "info");
      return;
    }
    if (ctx.mode !== "tui") {
      throw new Error("Voice requires pi's interactive TUI mode.");
    }
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw new Error("Voice currently requires macOS arm64.");
    }

    context = ctx;
    stop();
    context = ctx;
    const generation = startupGeneration;
    setState("starting");

    try {
      await validateCoordinator(ctx);
      if (generation !== startupGeneration) {
        return;
      }
      let initialVoiceAuth: VoiceAuth | undefined = await resolveVoiceAuth(ctx);
      if (generation !== startupGeneration) {
        return;
      }
      const nextVoice = new VoiceSession({
        initialTranscript: persistedTranscript,
        onDelegation: handleDelegation,
        onError: (message) => {
          if (generation !== startupGeneration) {
            return;
          }
          media?.sendError(message);
          context?.ui.notify(`Voice: ${message}`, "error");
        },
        onRenewDue: () => {
          if (generation === startupGeneration) {
            media?.requestRenewal();
          }
        },
        onState: (state: VoiceState) => {
          if (generation !== startupGeneration) {
            return;
          }
          if (state === "active") {
            setState("active");
          } else if (state === "connecting") {
            setState("connecting");
          } else if (state === "failed") {
            setState("failed");
          }
        },
        resolveAuth: async () => {
          if (initialVoiceAuth) {
            const auth = initialVoiceAuth;
            initialVoiceAuth = undefined;
            return auth;
          }
          if (!context) {
            throw new Error("The Pi session is not ready.");
          }
          return await resolveVoiceAuth(context);
        },
        threadId: ctx.sessionManager.getSessionId(),
        trace,
      });
      voice = nextVoice;

      const nextMedia = new MediaProcess({
        onClosed: () => {
          if (media === nextMedia) {
            stop();
            context?.ui.notify("Voice window closed.", "info");
          } else {
            nextVoice.dispose();
          }
        },
        onEndCall: () => {
          nextVoice.endCall();
        },
        onError: (message) => {
          if (generation === startupGeneration) {
            context?.ui.notify(`Voice media: ${message}`, "warning");
          }
        },
        onMediaReady: () => {
          nextVoice.mediaReady();
        },
        onMuted: (muted) => {
          if (generation === startupGeneration) {
            setState(muted ? "paused" : "active");
          }
        },
        onOffer: (offer) => nextVoice.acceptOffer(offer),
        onRenewAbort: () => {
          nextVoice.abortRenew();
        },
        onRenewCommit: () => nextVoice.commitRenew(),
        onRenewOffer: (offer) => nextVoice.renewOffer(offer),
        trace,
      });
      media = nextMedia;

      await nextMedia.start();
      if (generation !== startupGeneration) {
        return;
      }
      ctx.ui.notify("Voice window opened.", "info");
    } catch (error) {
      if (generation !== startupGeneration) {
        return;
      }
      stop();
      throw error;
    }
  };

  const toggle = async (ctx: ExtensionContext): Promise<void> => {
    if (runtimeState === "stopped" || runtimeState === "failed") {
      await start(ctx);
    } else {
      stop();
      ctx.ui.notify("Voice stopped.", "info");
    }
  };

  pi.registerCommand("voice", {
    description: "Start, stop, or inspect realtime voice",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!action) {
        await toggle(ctx);
        return;
      }
      if (action === "start") {
        await start(ctx);
        return;
      }
      if (action === "stop") {
        stop();
        ctx.ui.notify("Voice stopped.", "info");
        return;
      }
      if (action === "status") {
        ctx.ui.notify(`Voice is ${runtimeState}.`, "info");
        return;
      }
      ctx.ui.notify("Usage: /voice [start|stop|status]", "warning");
    },
  });

  pi.registerShortcut("ctrl+shift+v", {
    description: "Toggle realtime voice",
    handler: toggle,
  });

  pi.registerTool({
    description:
      "Send one meaningful progress update to the active realtime voice handoff. Use only for a verified finding, material progress, a newly identified blocker, or a decision that matters while work continues. Never use for acknowledgements, generic checking or waiting updates, or the final result; the final assistant response is delivered automatically.",
    async execute(_toolCallId, params) {
      const message = params.message
        .replaceAll(/\s+/gu, " ")
        .trim()
        .slice(0, MAX_SPEECH_CHARS);
      const delivered = Boolean(message && coordinator.sendStatus(message));
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
      const delivered = coordinator.finish(spokenSummary);
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
      if (!details?.markdown) {
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
    description:
      "End the current realtime voice chat. Call when the user explicitly asks to end voice or clearly signs off with wording such as goodbye, talk to you later, or that is all for now. Do not call for a bare stop, a request to pause or be quiet, a request to stop only the current task, or a polite acknowledgement. This does not stop pi or ongoing work.",
    async execute() {
      const active = voice !== undefined;
      if (active) {
        stop();
      }
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

  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    const continuityEntry = ctx.sessionManager
      .getBranch()
      .toReversed()
      .find(
        (entry) =>
          entry.type === "custom" && entry.customType === CONTINUITY_ENTRY
      );
    const data =
      continuityEntry?.type === "custom" && isRecord(continuityEntry.data)
        ? continuityEntry.data
        : undefined;
    persistedTranscript = parsePersistedTranscript(data?.entries);
    persistedTranscriptSignature = JSON.stringify(persistedTranscript);
    updateStatus(ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (
      voice === undefined ||
      runtimeState === "stopped" ||
      runtimeState === "failed"
    ) {
      return {};
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${COORDINATOR_INSTRUCTIONS}`,
    };
  });

  pi.on("turn_end", (event) => {
    if (
      !voice ||
      event.message.role !== "assistant" ||
      event.message.stopReason === "toolUse"
    ) {
      return;
    }
    const finalText = messageText(event.message);
    const errorText =
      event.message.errorMessage === undefined
        ? ""
        : `Pi encountered an error: ${event.message.errorMessage}`;
    if (event.message.stopReason === "error") {
      coordinator.deferFailure(
        finalText || errorText || "The Pi coordinator encountered an error."
      );
      return;
    }
    coordinator.finish(
      finalText ||
        errorText ||
        (event.message.stopReason === "aborted"
          ? "That request was interrupted before it completed."
          : "The Pi coordinator returned no response.")
    );
  });

  pi.on("agent_settled", () => {
    coordinator.settled();
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "user") {
      coordinator.accept(messageText(event.message));
    }
  });

  pi.on("session_shutdown", () => {
    stop({ flushTail: false });
    context = undefined;
  });
};

export default voiceExtension;
