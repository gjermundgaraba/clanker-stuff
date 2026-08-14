import { createLazySingleton } from "@clanker-stuff/lazy-singleton";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageStartEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import type { createVoiceController } from "./controller.js";

type VoiceController = ReturnType<typeof createVoiceController>;

export const createVoiceRuntime = (pi: ExtensionAPI) => {
  let context: ExtensionContext | undefined;
  let sessionStarted = false;
  const voice = createLazySingleton<VoiceController>(
    async (signal) => {
      const [{ createVoiceController }, { registerVoiceTools }] =
        await Promise.all([import("./controller.js"), import("./tools.js")]);
      signal.throwIfAborted();
      const controller = createVoiceController(pi);
      registerVoiceTools(pi, controller);
      return controller;
    },
    (controller) => {
      if (sessionStarted && context !== undefined) {
        controller.sessionStart(context);
      }
    }
  );

  return {
    beforeAgentStart: (
      event: BeforeAgentStartEvent
    ): BeforeAgentStartEventResult =>
      voice.get()?.beforeAgentStart(event) ?? {},
    messageStart: (event: MessageStartEvent): void => {
      voice.get()?.messageStart(event);
    },
    runCommand: async (
      args: string,
      ctx: ExtensionCommandContext
    ): Promise<void> => {
      context = ctx;
      const controller = await voice.load();
      await controller?.runCommand(args, ctx);
    },
    sessionBeforeTree: (oldLeafId: string | null): void => {
      voice.get()?.sessionBeforeTree(oldLeafId);
    },
    sessionStart: (ctx: ExtensionContext): void => {
      context = ctx;
      sessionStarted = true;
      voice.get()?.sessionStart(ctx);
    },
    sessionTree: (ctx: ExtensionContext): void => {
      context = ctx;
      voice.get()?.sessionTree(ctx);
    },
    settled: (): void => {
      voice.get()?.settled();
    },
    shutdown: async (): Promise<void> => {
      sessionStarted = false;
      context = undefined;
      await voice.stop((controller) => {
        controller.shutdown();
      });
    },
    toggle: async (ctx: ExtensionContext): Promise<void> => {
      context = ctx;
      const controller = await voice.load();
      await controller?.toggle(ctx);
    },
    turnEnd: (event: TurnEndEvent): void => {
      voice.get()?.turnEnd(event);
    },
  };
};
