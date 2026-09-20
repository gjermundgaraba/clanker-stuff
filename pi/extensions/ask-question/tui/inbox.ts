import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runQueuedPrompt } from "@clanker-stuff/pi-user-input/queue";
import type { Coordinator } from "../coordinator.js";
import type { Interaction } from "../interaction.js";
import { awaitingUser } from "../interaction.js";
import {
  deliveryLabel,
  inboxLabel,
  renderScrollablePage,
  reviewText,
  textLines,
} from "./render.js";
import { intent, keyLabel } from "./input.js";

type ReviewAction = { type: "reopen" | "send"; revision: number } | undefined;

async function inspectSubmission(
  ctx: ExtensionContext,
  item: Interaction,
  signal: AbortSignal,
  pi: ExtensionAPI,
): Promise<ReviewAction> {
  return runQueuedPrompt(ctx, signal, async (activeSignal) => {
    pi.events.emit("clanker:async-prompt", { active: true });

    try {
      return await ctx.ui.custom<ReviewAction>((tui, theme, keys, done) => {
        let index = item.submissions.length - 1;
        let scroll = 0;
        let pageSize = 1;
        let viewport = { top: 0, rows: 0 };
        let details = false;
        const close = () => done(undefined);
        activeSignal.addEventListener("abort", close, { once: true });

        if (activeSignal.aborted) queueMicrotask(close);

        return {
          render(availableWidth) {
            const padding = availableWidth >= 28 ? 2 : 0;
            const width = availableWidth - padding * 2;
            const submission = item.submissions[index];
            const status = item.deliveries.find((d) => d.revision === submission?.revision)?.status;

            const view = renderScrollablePage({
              title: item.request.title ?? "Questionnaire",
              header: theme.fg(
                "accent",
                theme.bold(
                  submission
                    ? `Read-only · revision ${submission.revision} · ${deliveryLabel(status)}`
                    : "Cancelled · no submitted answers",
                ),
              ),
              body: textLines(
                details
                  ? `ID: ${item.id}\nCreated: ${item.created_at}${submission ? `\nSubmitted: ${submission.timestamp}\nRequested by: ${submission.initiated_by}${submission.reason ? `\nReason: ${submission.reason}` : ""}` : ""}`
                  : submission
                    ? reviewText(item, submission)
                    : item.request.questions.map((q) => `${q.header}: ${q.question}`).join("\n\n"),
                width,
              ),
              footer: `${keyLabel(keys, "tui.select.cancel")} ${details ? "Back" : "Close"}${submission && index === item.submissions.length - 1 ? " · r Revise" : ""}${submission && status !== "delivered" ? " · s Send (starts/steers a turn)" : ""}${item.submissions.length > 1 ? " · ←/→ Revisions" : ""}\n${details ? "i Answers" : "i Details"} · ↑↓/j/k Scroll`,
              closeKey: keyLabel(keys, "tui.select.cancel"),
              hint: "",
              rows: tui.terminal.rows,
              width,
              scroll,
              theme,
            });

            scroll = view.scroll;
            pageSize = Math.max(1, view.viewport.rows - 1);
            viewport = view.viewport;

            return view.lines.map((line) => " ".repeat(padding) + line);
          },
          handleMouse(event) {
            if (event.type !== "wheel" || !event.wheelDelta) return;

            if (
              viewport.rows === 0 ||
              event.y < viewport.top ||
              event.y >= viewport.top + viewport.rows
            )
              return;
            scroll += event.wheelDelta;

            return { handled: true };
          },
          handleInput(data) {
            const key = intent(keys, data, true);
            const submission = item.submissions[index];

            if (key === "close" || key === "confirm") {
              if (details) {
                details = false;
                scroll = 0;
              } else close();
            } else if (key === "key:i") {
              details = !details;
              scroll = 0;
            } else if (key === "up" || key === "page_up")
              scroll = Math.max(0, scroll - (key === "up" ? 1 : pageSize));
            else if (key === "down" || key === "page_down") scroll += key === "down" ? 1 : pageSize;
            else if (key === "back" || key === "next") {
              index = Math.max(
                0,
                Math.min(item.submissions.length - 1, index + (key === "back" ? -1 : 1)),
              );
              scroll = 0;
            } else if (submission && key === "key:r" && index === item.submissions.length - 1)
              done({ type: "reopen", revision: submission.revision });
            else if (
              submission &&
              key === "key:s" &&
              item.deliveries.find((d) => d.revision === submission.revision)?.status !==
                "delivered"
            )
              done({ type: "send", revision: submission.revision });
            tui.requestRender();
          },
          invalidate() {},
          dispose() {
            activeSignal.removeEventListener("abort", close);
          },
        };
      });
    } finally {
      pi.events.emit("clanker:async-prompt", { active: false });
    }
  });
}

export async function showInbox(
  ctx: ExtensionContext,
  coordinator: Coordinator,
  signal: AbortSignal,
  pi: ExtensionAPI,
): Promise<void> {
  const select = (title: string, choices: string[]) =>
    runQueuedPrompt(ctx, signal, async (activeSignal) => {
      pi.events.emit("clanker:async-prompt", { active: true });

      try {
        return await ctx.ui.select(title, choices, { signal: activeSignal });
      } finally {
        pi.events.emit("clanker:async-prompt", { active: false });
      }
    });

  const all = coordinator.list();

  if (!all.length) {
    ctx.ui.notify("No questionnaires on this branch", "info");

    return;
  }

  // Awaiting you first; sent and cancelled ones follow under a separator row.
  const awaiting = all.filter(awaitingUser);
  const rest = all.filter((i) => !awaitingUser(i));
  const items = [...awaiting, ...rest];
  const labels = items.map(inboxLabel);
  const separator = "──── Sent or cancelled ────";
  const rows = [...labels];

  if (awaiting.length && rest.length) rows.splice(awaiting.length, 0, separator);
  let chosen: string | undefined;

  do chosen = await select("Questionnaires · awaiting you first", rows);
  while (chosen === separator && !signal.aborted);

  if (!chosen || signal.aborted) return;
  const selected = items[labels.indexOf(chosen)];

  if (!selected) throw new Error("Selected questionnaire is no longer in the inbox");
  const item = coordinator.get(selected.id);

  if (item.draft) {
    await coordinator.open(item.id, ctx);

    return;
  }

  const action = await inspectSubmission(ctx, item, signal, pi);

  if (!action || signal.aborted) return;

  if (action.type === "reopen") {
    await coordinator.mutate(
      item.id,
      item.version,
      {
        type: "reopen",
        base: action.revision,
        initiated_by: "user",
        mode: "async",
      },
      ctx,
    );
    await coordinator.open(item.id, ctx);
  } else {
    const delivery = coordinator
      .get(item.id)
      .deliveries.find((d) => d.revision === action.revision)!;

    const uncertain = delivery.status === "uncertain" || delivery.status === "handed_to_pi";

    if (uncertain) {
      const recovery = await select(
        "Pi may already own this answer. Check history and restored editor text; resending may duplicate it.",
        ["Keep paused", "Resend this revision anyway"],
      );

      if (recovery !== "Resend this revision anyway" || signal.aborted) return;
    }

    await coordinator.send(item.id, action.revision, ctx, uncertain);
  }
}
