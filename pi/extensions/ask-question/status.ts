import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Shows how many questionnaires await the user: a widget above the editor and a footer status. */
export function showInboxCount(ctx: ExtensionContext, count: number): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setWidget(
    "questionnaires",
    count > 0
      ? [`${count} questionnaire${count === 1 ? "" : "s"} awaiting you · /answers`]
      : undefined,
  );
  ctx.ui.setStatus(
    "ask-question",
    count > 0 ? ctx.ui.theme.fg("warning", `✉ ${count}`) : undefined,
  );
}
