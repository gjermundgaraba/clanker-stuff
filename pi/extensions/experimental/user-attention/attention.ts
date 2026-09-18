import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";
import { displayText, safeText } from "@clanker-stuff/pi-tool-rendering/text";
import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const AsyncMessageParameters = Type.Object(
  {
    message: Type.String({ description: "The concise question or update to send to the user." }),
  },
  { additionalProperties: false },
);

const AttentionEntrySchema = Type.Object({ message: AsyncMessageParameters.properties.message });

export async function sendAttention(
  pi: ExtensionAPI,
  params: Static<typeof AsyncMessageParameters>,
  ctx: ExtensionContext,
) {
  const message = safeText(params.message).trim();

  if (!message) throw new Error("message must not be empty");
  const session = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile();

  const append = () => {
    if (ctx.sessionManager.getSessionId() !== session)
      throw new Error("Attention message belongs to an inactive session");
    pi.appendEntry("async-attention", { message });
  };

  if (file) await withFileMutationQueue(resolve(file), async () => append());
  else append();

  if (ctx.hasUI) ctx.ui.notify(message, "info");

  return {
    content: [{ type: "text" as const, text: '{"accepted":true}' }],
    details: { accepted: true },
  };
}

export const renderAttention: Parameters<ExtensionAPI["registerEntryRenderer"]>[1] = (
  entry,
  _options,
  theme,
) =>
  Value.Check(AttentionEntrySchema, entry.data)
    ? new Markdown(displayText(entry.data.message), 0, 0, getMarkdownTheme())
    : new Text(theme.fg("accent", "Message for you"), 0, 0);

export const renderCall: NonNullable<
  ToolDefinition<typeof AsyncMessageParameters>["renderCall"]
> = (args, theme, context) =>
  preview(
    () =>
      new Text(
        theme.fg("toolTitle", "Message for you") + "\n" + displayText(args.message ?? ""),
        0,
        0,
      ),
    context.expanded,
  );

export const renderResult: NonNullable<
  ToolDefinition<typeof AsyncMessageParameters, { accepted?: boolean }>["renderResult"]
> = (result, options, theme, context) =>
  preview(
    () =>
      new Text(
        theme.fg(
          context.isError ? "error" : options.isPartial ? "warning" : "toolOutput",
          !context.isError && !options.isPartial && result.details?.accepted === true
            ? "✓ Message submitted"
            : displayText(
                result.content
                  .filter((c) => c.type === "text")
                  .map((c) => c.text)
                  .join("\n"),
              ),
        ),
        0,
        0,
      ),
    options.expanded,
  );
