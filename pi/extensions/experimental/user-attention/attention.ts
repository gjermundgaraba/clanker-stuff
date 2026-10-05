import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { displayText, safeText } from "@clanker-stuff/pi-tool-rendering/text";
import { preview } from "@clanker-stuff/pi-tool-rendering/preview";

export const AsyncMessageParameters = Type.Object(
  {
    message: Type.String({ description: "The concise question or update to send to the user." }),
  },
  { additionalProperties: false },
);

/** The tool call is the record: the TUI renders it, and RPC clients also get a notification. */
export function sendAttention(
  params: Static<typeof AsyncMessageParameters>,
  ctx: ExtensionContext,
) {
  const message = safeText(params.message).trim();

  if (!message) throw new Error("message must not be empty");

  if (ctx.mode !== "tui" && ctx.hasUI) ctx.ui.notify(message, "info");

  return { content: [{ type: "text" as const, text: "Shown to the user." }], details: undefined };
}

export const renderCall: NonNullable<
  ToolDefinition<typeof AsyncMessageParameters>["renderCall"]
> = (args, theme, context) =>
  preview(
    () => {
      const view = new Container();
      view.addChild(new Text(theme.fg("toolTitle", "Message for you"), 0, 0));
      view.addChild(new Markdown(displayText(args.message ?? ""), 0, 0, getMarkdownTheme()));

      return view;
    },
    context.expanded,
    12,
  );
