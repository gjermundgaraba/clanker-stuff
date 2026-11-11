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

  const labels = items.map(
    (item, index) =>
      `${inboxLabel(item, index)}${coordinator.isPending(item.id) ? " · unconfirmed" : ""}`
  );

  const chosen = await coordinator.prompt(
    signal,
    async (active) =>
      await ctx.ui.select("Questionnaires awaiting you", labels, {
        signal: active,
      })
  );

  const item = chosen === undefined ? undefined : items[labels.indexOf(chosen)];

  if (!item || signal.aborted) {
    return;
  }

  if (coordinator.isPending(item.id)) {
    const retry = "Review and retry";

    const choice = await coordinator.prompt(
      signal,
      async (active) =>
        await ctx.ui.select(
          "The previous outcome is unconfirmed and may still arrive. Retrying could send a duplicate.",
          ["Keep waiting", retry],
          { signal: active }
        )
    );

    if (choice !== retry || signal.aborted) {
      return;
    }
  }

  await coordinator.open(item.id, ctx);
};
