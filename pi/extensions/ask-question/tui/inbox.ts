import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Coordinator } from "../coordinator.js";
import { inboxLabel } from "./render.js";

/** Lists the open questionnaires and opens the chosen one. */
export const showInbox = async (
  ctx: ExtensionContext,
  coordinator: Coordinator,
  signal: AbortSignal
): Promise<void> => {
  const items = coordinator.list();

  if (!items.length) {
    ctx.ui.notify("No questionnaires await you on this branch", "info");

    return;
  }

  const labels = items.map(inboxLabel);

  const chosen = await coordinator.prompt(
    signal,
    async (active) =>
      await ctx.ui.select("Questionnaires awaiting you", labels, {
        signal: active,
      })
  );

  const item = chosen === undefined ? undefined : items[labels.indexOf(chosen)];

  if (item && !signal.aborted) {
    await coordinator.open(item.id, ctx);
  }
};
