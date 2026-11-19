import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";

import { safeText } from "@clanker-stuff/pi-tool-rendering/text";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

export const FEEDBACK_COMMAND = "plannotator-feedback";

interface Origin {
  matchesBranch: () => boolean;
  treeVersion: number;
}

// Pi switches the leaf before session_tree handlers run: https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/agent-session.ts#L4292-L4313
const captureBranch = (
  sessionManager: ExtensionCommandContext["sessionManager"]
): (() => boolean) => {
  const leafId = sessionManager.getLeafId();

  if (leafId !== null) {
    return () => sessionManager.getBranch().some(({ id }) => id === leafId);
  }

  const existingRootIds = new Set(
    sessionManager
      .getEntries()
      .filter(({ parentId }) => parentId === null)
      .map(({ id }) => id)
  );

  return () => {
    const [root] = sessionManager.getBranch();

    return root === undefined || !existingRootIds.has(root.id);
  };
};

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

  const isCurrent = (origin: Origin) =>
    origin.treeVersion === treeVersion && origin.matchesBranch();

  const capture = (ctx: ExtensionCommandContext, signal: AbortSignal) => {
    const origin: Origin = {
      matchesBranch: captureBranch(ctx.sessionManager),
      treeVersion,
    };

    return async (text: string): Promise<void> => {
      if (isCurrent(origin) && !isIdleOrRunningTurn(ctx)) {
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

      if (!isCurrent(origin) || !isIdleOrRunningTurn(ctx)) {
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

      if (!isCurrent(result.origin) || !isIdleOrRunningTurn(ctx)) {
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
