import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
const MAX_SPEECH_CHARS = 400;
const COORDINATOR_INSTRUCTIONS = `## Realtime voice coordination

You are coordinating an active realtime voice chat. The realtime model handles low-latency conversation; this pi session is the authoritative execution and state layer of the same assistant.

Treat realtime delegation input as speech transcript that may contain recognition errors. The <input> is the current request. <transcript_delta> is mechanical conversation context since the previous delegation and may include unrelated discussion.

Handle conversation, quick checks, and interactive decisions here. For slow or independent work, use existing agent-orchestration capabilities when they are already available and useful; do not assume a particular agent host exists. Running work remains steerable.

Never claim an action completed without checking the actual result.

Your terminal assistant response is automatically returned to the active voice handoff as its single [COMPLETE] message. Do not add protocol tags to your response and do not call speak_to_user for the final result.

speak_to_user sends a [STATUS] update for the active handoff. Use it only for a verified finding, concrete user-relevant progress, a newly identified blocker, or a decision that matters while work continues. Never use it for an acknowledgement, intent, reassurance, “checking,” “still working,” elapsed time, or repeated information. After one meaningful update, remain silent until there is another material change or the terminal response is ready.

Ending voice never ends this pi session or its ongoing work.`;

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
        deliverAs: "steer",
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
    setState("starting");

    try {
      await validateCoordinator(ctx);
      let initialVoiceAuth: VoiceAuth | undefined = await resolveVoiceAuth(ctx);
      const nextVoice = new VoiceSession({
        initialTranscript: persistedTranscript,
        onDelegation: handleDelegation,
        onError: (message) => {
          media?.sendError(message);
          context?.ui.notify(`Voice: ${message}`, "error");
        },
        onRenewDue: () => media?.requestRenewal(),
        onState: (state: VoiceState) => {
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
          context?.ui.notify(`Voice media: ${message}`, "warning");
        },
        onMediaReady: () => {
          nextVoice.mediaReady();
        },
        onMuted: (muted) => {
          setState(muted ? "paused" : "active");
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
      ctx.ui.notify("Voice window opened.", "info");
    } catch (error) {
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
      "End the current realtime voice chat. Only call this tool if the user explicitly asks to end the voice chat. This does not stop pi or ongoing work.",
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
