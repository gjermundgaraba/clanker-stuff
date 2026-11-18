import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";

import { safeText } from "@clanker-stuff/pi-tool-rendering/text";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export const FEEDBACK_COMMAND = "plannotator-feedback";

interface Origin {
  leafId: string | null;
  treeVersion: number;
}

const notifyRetained = (ctx: ExtensionCommandContext) => {
  ctx.ui.notify(
    `Plannotator feedback was not sent. Use /${FEEDBACK_COMMAND} to recover it into the editor.`,
    "warning"
  );
};

const isIdleOrRunningTurn = (ctx: ExtensionCommandContext) =>
  ctx.isIdle() || ctx.signal !== undefined;

export const createFeedbackDelivery = (pi: ExtensionAPI) => {
  let treeVersion = 0;
  const pending = new Map<string, { origin: Origin; text: string }>();

  const isCurrent = (origin: Origin, ctx: ExtensionCommandContext) =>
    origin.treeVersion === treeVersion &&
    (origin.leafId === null ||
      ctx.sessionManager.getBranch().some(({ id }) => id === origin.leafId));

  const capture = (ctx: ExtensionCommandContext, signal: AbortSignal) => {
    const origin: Origin = {
      leafId: ctx.sessionManager.getLeafId(),
      treeVersion,
    };

    return async (text: string): Promise<void> => {
      if (isCurrent(origin, ctx) && !isIdleOrRunningTurn(ctx)) {
        const { promise, resolve } = Promise.withResolvers<undefined>();

        using _abort = addAbortListener(signal, () => {
          resolve(undefined);
        });

        await Promise.race([ctx.waitForIdle(), promise]);
      }

      if (signal.aborted) {
        return;
      }

      const id = randomUUID();
      pending.set(id, { origin, text });

      if (!isCurrent(origin, ctx) || !isIdleOrRunningTurn(ctx)) {
        notifyRetained(ctx);

        return;
      }

      // Validate again after Pi's deferral: https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/examples/extensions/reload-runtime.ts
      pi.sendUserMessage(`/${FEEDBACK_COMMAND} ${id}`, {
        expandPromptTemplates: true,
      });
    };
  };

  const recover = (ctx: ExtensionCommandContext): void => {
    const next = pending.entries().next();

    if (next.done === true) {
      ctx.ui.notify("No retained Plannotator feedback.", "info");

      return;
    }

    if (!ctx.hasUI || ctx.ui.getEditorText().length > 0) {
      ctx.ui.notify(
        "Recover Plannotator feedback from an empty editor.",
        "warning"
      );

      return;
    }

    const [id, { text }] = next.value;
    ctx.ui.setEditorText(safeText(text));
    pending.delete(id);
  };

  return {
    capture,
    command: async (
      args: string,
      ctx: ExtensionCommandContext
    ): Promise<void> => {
      const id = args.trim();

      if (id.length === 0) {
        recover(ctx);

        return;
      }

      const result = pending.get(id);

      if (!result) {
        return;
      }

      if (!isCurrent(result.origin, ctx) || !isIdleOrRunningTurn(ctx)) {
        notifyRetained(ctx);

        return;
      }

      pending.delete(id);
      pi.sendUserMessage(result.text, { deliverAs: "followUp" });
    },
    invalidateTreeVersion: () => {
      treeVersion += 1;
    },
    clear: () => {
      pending.clear();
    },
  };
};

export type CaptureFeedbackOrigin = ReturnType<
  typeof createFeedbackDelivery
>["capture"];
