import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { isRecord, resolveVoiceAuth, validateCoordinator } from "./auth.js";
import { COORDINATOR_INSTRUCTIONS, VoiceCoordinator } from "./coordinator.js";
import { MediaProcess } from "./media-process.js";
import type { VoiceAuth, VoiceDelegation, VoiceState } from "./realtime.js";
import { VoiceSession } from "./realtime.js";
import { registerVoiceTools, VOICE_TOOL_NAMES } from "./tools.js";
import { createVoiceTrace } from "./trace.js";
import {
  formatDelegation,
  formatTranscriptTail,
  messageText,
  parsePersistedTranscript,
} from "./transcript.js";
import type { TranscriptEntry } from "./transcript.js";

const STATUS_KEY = "voice";
const CONTINUITY_ENTRY = "voice-continuity";
const VOICE_TOOL_NAME_SET = new Set<string>(VOICE_TOOL_NAMES);

type RuntimeState =
  | "stopped"
  | "starting"
  | "connecting"
  | "active"
  | "paused"
  | "failed";

const voiceExtension = (pi: ExtensionAPI): void => {
  const trace = createVoiceTrace();
  let context: ExtensionContext | undefined;
  let media: MediaProcess | undefined;
  let persistedTranscript: TranscriptEntry[] = [];
  let persistedTranscriptSignature = "[]";
  let runtimeState: RuntimeState = "stopped";
  let startupGeneration = 0;
  let voice: VoiceSession | undefined;

  const setVoiceToolsActive = (active: boolean): void => {
    const current = pi.getActiveTools();
    const next = current.filter((name) => !VOICE_TOOL_NAME_SET.has(name));
    if (active) {
      next.push(...VOICE_TOOL_NAMES);
    }
    if (
      next.length !== current.length ||
      next.some((name, index) => name !== current[index])
    ) {
      pi.setActiveTools(next);
    }
  };

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
    if (state === "failed" || state === "stopped") {
      setVoiceToolsActive(false);
    }
    if (context !== undefined) {
      updateStatus(context);
    }
    media?.sendState(state);
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
      setVoiceToolsActive(true);

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

  registerVoiceTools(pi, {
    endActiveCall: () => {
      const active = voice !== undefined;
      if (active) {
        stop();
      }
      return active;
    },
    finish: (spokenSummary) => coordinator.finish(spokenSummary),
    sendStatus: (message) => coordinator.sendStatus(message),
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
    setVoiceToolsActive(false);
    updateStatus(ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (
      voice === undefined ||
      runtimeState === "stopped" ||
      runtimeState === "failed"
    ) {
      setVoiceToolsActive(false);
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
