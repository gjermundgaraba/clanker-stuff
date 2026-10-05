import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Coordinator } from "../coordinator.js";
import type { Interaction } from "../interaction.js";
import { awaitingUser } from "../interaction.js";
import {
  Viewport,
  deliveryLabel,
  inboxLabel,
  padded,
  renderScrollablePage,
  reviewText,
  textLines,
} from "./render.js";
import { intent, keyLabel } from "./input.js";

type ReviewAction = { type: "reopen" | "send"; revision: number } | undefined;

/** Read-only submitted answers, with explicit Revise and Send actions. */
async function inspectSubmission(
  ctx: ExtensionContext,
  coordinator: Coordinator,
  item: Interaction,
  signal: AbortSignal,
): Promise<ReviewAction> {
  return coordinator.prompt(signal, (active) =>
    ctx.ui.custom<ReviewAction>((tui, theme, keys, done) => {
      let index = item.submissions.length - 1;
      let details = false;
      const viewport = new Viewport();
      const close = () => done(undefined);
      active.addEventListener("abort", close, { once: true });

      if (active.aborted) queueMicrotask(close);

      const frame = (width: number) => {
        const submission = item.submissions[index];
        const latest = submission && index === item.submissions.length - 1;
        const cancel = keyLabel(keys, "tui.select.cancel");

        return renderScrollablePage({
          title: item.request.title ?? "Questionnaire",
          header: theme.fg(
            "accent",
            theme.bold(
              submission
                ? `Read-only · revision ${submission.revision} · ${deliveryLabel(submission)}`
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
          footer: `${cancel} ${details ? "Back" : "Close"}${latest ? " · r Revise" : ""}${submission ? ` · s ${submission.sent_at ? "Send again" : "Send"} (starts/steers a turn)` : ""}${item.submissions.length > 1 ? " · ←/→ Revisions" : ""}\n${details ? "i Answers" : "i Details"} · ↑↓/j/k Scroll`,
          closeKey: cancel,
          hint: "",
          rows: tui.terminal.rows,
          width,
          scroll: viewport.scroll,
          theme,
        });
      };

      return {
        render: (availableWidth) => padded(availableWidth, (width) => viewport.show(frame(width))),
        handleMouse: (event) => viewport.wheel(event),
        handleInput(data) {
          const key = intent(keys, data, true);
          const submission = item.submissions[index];

          if (key === "close" || key === "confirm") {
            if (details) {
              details = false;
              viewport.scroll = 0;
            } else close();
          } else if (key === "key:i") {
            details = !details;
            viewport.scroll = 0;
          } else if (key === "up" || key === "down") viewport.by(key === "up" ? -1 : 1);
          else if (key === "page_up" || key === "page_down")
            viewport.pages(key === "page_up" ? -1 : 1);
          else if (key === "back" || key === "next") {
            index = Math.max(
              0,
              Math.min(item.submissions.length - 1, index + (key === "back" ? -1 : 1)),
            );
            viewport.scroll = 0;
          } else if (submission && key === "key:r" && index === item.submissions.length - 1)
            done({ type: "reopen", revision: submission.revision });
          else if (submission && key === "key:s")
            done({ type: "send", revision: submission.revision });
          tui.requestRender();
        },
        invalidate() {},
        dispose() {
          active.removeEventListener("abort", close);
        },
      };
    }),
  );
}

export async function showInbox(
  ctx: ExtensionContext,
  coordinator: Coordinator,
  signal: AbortSignal,
): Promise<void> {
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

  do
    chosen = await coordinator.prompt(signal, (active) =>
      ctx.ui.select("Questionnaires · awaiting you first", rows, { signal: active }),
    );
  while (chosen === separator && !signal.aborted);

  if (!chosen || signal.aborted) return;
  const selected = items[labels.indexOf(chosen)];

  if (!selected) throw new Error("Selected questionnaire is no longer in the inbox");
  const item = coordinator.get(selected.id);

  if (item.draft) {
    await coordinator.open(item.id, ctx);

    return;
  }

  const action = await inspectSubmission(ctx, coordinator, item, signal);

  if (!action || signal.aborted) return;

  if (action.type === "send") {
    coordinator.send(item.id, action.revision, ctx);

    return;
  }

  coordinator.mutate(item.id, {
    type: "reopen",
    base: action.revision,
    initiated_by: "user",
    mode: "async",
  });
  await coordinator.open(item.id, ctx);
}
