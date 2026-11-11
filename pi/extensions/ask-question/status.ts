import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const showInboxCount = (
  ctx: ExtensionContext,
  count: number,
  pending: number
): void => {
  if (ctx.mode !== "tui") {
    return;
  }

  ctx.ui.setWidget(
    "questionnaires",
    count > 0
      ? [
          `${count} questionnaire${count === 1 ? "" : "s"}${pending > 0 ? ` · ${pending} unconfirmed` : " awaiting you"} · /answers`,
        ]
      : undefined
  );
  ctx.ui.setStatus(
    "ask-question",
    count > 0 ? ctx.ui.theme.fg("warning", `✉ ${count}`) : undefined
  );
};
