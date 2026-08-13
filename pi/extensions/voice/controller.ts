import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  MessageStartEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { isRecord, resolveVoiceAuth, validateCoordinator } from "./auth.js";
import { COORDINATOR_INSTRUCTIONS, VoiceCoordinator } from "./coordinator.js";
import { MediaProcess } from "./media-process.js";
import type { VoiceAuth, VoiceDelegation, VoiceState } from "./realtime.js";
import { VoiceSession } from "./realtime.js";
import { VOICE_TOOL_NAMES } from "./tools.js";
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

export const createVoiceController = (pi: ExtensionAPI) => {
  const trace = createVoiceTrace();
  let context: ExtensionContext | undefined;
  let media: MediaProcess | undefined;
  let pendingTreeBranch: { leafId: string | null } | undefined;
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
    } else if (state === "active" || state === "paused") {
      setVoiceToolsActive(true);
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

  const persistContinuity = (branchId?: string | null): void => {
    const entries = voice?.recentTranscript() ?? persistedTranscript;
    const signature = JSON.stringify(entries);
    persistedTranscript = entries;
    if (signature === persistedTranscriptSignature) {
      return;
    }
    pi.appendEntry(CONTINUITY_ENTRY, {
      ...(branchId === undefined ? {} : { branchId }),
      entries,
    });
    persistedTranscriptSignature = signature;
  };

  const stop = (
    options: { flushTail?: boolean; persist?: boolean } = {}
  ): void => {
    startupGeneration += 1;
    if (options.persist !== false) {
      persistContinuity();
    }
    const transcriptTail =
      options.flushTail === false ? [] : (voice?.takeTranscriptTail() ?? []);
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

  const restoreContinuity = (ctx: ExtensionContext): void => {
    const branch = ctx.sessionManager.getBranch();
    const branchDepth = new Map(
      branch.map(({ id }, index) => [id, index] as const)
    );
    let continuityData: Record<string, unknown> | undefined;
    let continuityDepth = Number.NEGATIVE_INFINITY;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== CONTINUITY_ENTRY) {
        continue;
      }
      const data = isRecord(entry.data) ? entry.data : undefined;
      let depth: number | undefined;
      if (!data || !("branchId" in data)) {
        depth = branchDepth.get(entry.id);
      } else if (data.branchId === null) {
        depth = branch.length === 0 ? -1 : undefined;
      } else if (typeof data.branchId === "string") {
        depth = branchDepth.get(data.branchId);
      }
      if (depth !== undefined && depth >= continuityDepth) {
        continuityData = data;
        continuityDepth = depth;
      }
    }
    persistedTranscript = parsePersistedTranscript(continuityData?.entries);
    persistedTranscriptSignature = JSON.stringify(persistedTranscript);
  };

  return {
    beforeAgentStart: (
      event: BeforeAgentStartEvent
    ): BeforeAgentStartEventResult => {
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
    },
    endActiveCall: (): boolean => {
      const active = voice !== undefined;
      if (active) {
        stop();
      }
      return active;
    },
    finish: (spokenSummary: string): boolean =>
      coordinator.finish(spokenSummary),
    messageStart: (event: MessageStartEvent): void => {
      if (event.message.role === "user") {
        coordinator.accept(messageText(event.message));
      }
    },
    runCommand: async (args: string, ctx: ExtensionContext): Promise<void> => {
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
    sendStatus: (message: string): boolean => coordinator.sendStatus(message),
    sessionBeforeTree: (oldLeafId: string | null): void => {
      persistContinuity(oldLeafId);
      pendingTreeBranch = { leafId: oldLeafId };
    },
    sessionStart: (ctx: ExtensionContext): void => {
      pendingTreeBranch = undefined;
      context = ctx;
      restoreContinuity(ctx);
      setVoiceToolsActive(false);
      updateStatus(ctx);
    },
    sessionTree: (ctx: ExtensionContext): void => {
      if (pendingTreeBranch) {
        persistContinuity(pendingTreeBranch.leafId);
        pendingTreeBranch = undefined;
      }
      stop({ flushTail: false, persist: false });
      context = ctx;
      restoreContinuity(ctx);
    },
    settled: (): void => {
      coordinator.settled();
    },
    shutdown: (): void => {
      pendingTreeBranch = undefined;
      stop({ flushTail: false });
      context = undefined;
    },
    toggle,
    turnEnd: (event: TurnEndEvent): void => {
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
    },
  };
};
