import { createBorderStatusClient } from "@clanker-stuff/border-status-protocol";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Presentation only: the coordinator owns the durable awaiting-user state. */
export function createInboxStatus(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let count = 0;
  let paused = 0;

  const widget = () => {
    if (context?.mode !== "tui") return;
    context.ui.setWidget(
      "questionnaires",
      count > 0
        ? [
            `${count} questionnaire${count === 1 ? "" : "s"} awaiting you${paused ? ` · ${paused} paused` : ""} · /answers`,
          ]
        : undefined,
    );
  };

  const client = createBorderStatusClient(pi, {
    owner: "ask-question",
  });

  return {
    attach(ctx: ExtensionContext, navigationId: string | null = null) {
      count = 0;
      paused = 0;
      context = ctx;
      client.attach(ctx, navigationId);
      widget();
    },
    update(waiting: number, pausedCount: number) {
      count = waiting;
      paused = pausedCount;

      if (count > 0)
        client.set("inbox", {
          icon: { nerd: "\uF0E0", unicode: "✉", ascii: "mail" },
          text: String(count),
          tone: "warning",
          priority: 100,
        });
      else client.clear("inbox");
      widget();
    },
    dispose() {
      count = 0;
      client.dispose();
      widget();
      context = undefined;
    },
  };
}
