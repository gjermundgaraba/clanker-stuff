/** Generic MCP presentation without interpreting remote tool semantics or changing their content. */
import { preview } from "@clanker-stuff/pi-tool-rendering/preview";
import { displayText as clean, inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";

const OverflowNoticeSchema = Type.Object({ overflowNoticeIndex: Type.Integer() });

// Remote tool arguments are open JSON; the display boundary inspects or serializes each value separately.
type Data = { [key: string]: JsonValue };

type Renderers = Required<Pick<ToolDefinition, "renderCall" | "renderResult">>;

const isData = (value: unknown): value is Data =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const record = (value: JsonValue | undefined): Data => (isData(value) ? value : {});

const inline = (value: JsonValue | undefined) =>
  typeof value === "string" ? inlineText(value) : "";

const json = (value: JsonValue) => {
  try {
    return clean(JSON.stringify(value, null, 2) ?? "");
  } catch {
    return "[unavailable]";
  }
};

/** A stable server/tool identity replaces generated hash-suffixed names in the transcript. */
export const mcpRenderers = (server: string, tool: string, manager = false): Renderers => ({
  renderCall(args, theme, context) {
    const data = isData(args) ? args : {};

    return preview(
      () => {
        const title = theme.fg(
          "toolTitle",
          theme.bold(manager ? tool : `${inline(server)}: ${inline(tool)}`),
        );

        const lines = [title];

        if (manager) {
          // Configuration can contain literal credentials, command arguments, or credential-bearing URLs.
          // Only explicitly allowlisted operational settings may appear in expanded calls.
          const config = record(data.config);
          lines[0] += data.name ? ` ${theme.fg("accent", inline(data.name))}` : "";

          const metadata = [
            inline(data.scope),
            inline(config.type),
            data.reconnect === true ? "reconnect" : "",
          ].filter(Boolean);

          if (metadata.length) lines.push(theme.fg("muted", metadata.join(" · ")));

          if (context.expanded) {
            const visible = new Set(["type"]);

            for (const key of ["heartbeatIntervalMs", "heartbeatTimeoutMs"]) {
              const value = config[key];

              // Show attempted numbers, including values execution validation rejects.
              if (typeof value === "number") {
                lines.push(theme.fg("muted", `${key}: ${value}`));
                visible.add(key);
              }
            }

            const oauth = record(config.oauth);

            if (typeof oauth.callbackPort === "number")
              lines.push(theme.fg("muted", `oauth.callbackPort: ${oauth.callbackPort}`));

            if (
              config.oauth !== null &&
              typeof config.oauth === "object" &&
              !Array.isArray(config.oauth) &&
              Object.keys(oauth).every(
                (key) => key === "callbackPort" && typeof oauth[key] === "number",
              )
            )
              visible.add("oauth");

            if (Object.keys(config).some((key) => !visible.has(key)))
              lines.push(theme.fg("muted", "Additional configuration hidden"));
          }
        } else {
          for (const [key, value] of Object.entries(data)) {
            const content =
              typeof value === "string"
                ? clean(value)
                : context.expanded
                  ? json(value)
                  : Array.isArray(value)
                    ? `[${value.length} items]`
                    : value !== null && typeof value === "object"
                      ? "{…}"
                      : String(value);

            lines.push(
              `${theme.fg("muted", `${inline(key)}:`)} ${theme.fg("toolOutput", content)}`,
            );
          }
        }

        if (context.isPartial)
          lines.push(theme.fg("accent", context.executionStarted ? "● working" : "…"));

        return new Text(lines.join("\n"), 0, 0);
      },
      context.expanded,
      3,
    );
  },
  renderResult(result, options, theme, context) {
    const output = new Container();

    const details = result.details;

    const noticeIndex =
      !context.isError && !options.isPartial && Value.Check(OverflowNoticeSchema, details)
        ? details.overflowNoticeIndex
        : -1;

    const notice = result.content[noticeIndex];

    const text = result.content
      .filter((_item, index) => index !== noticeIndex)
      .filter((item) => item.type === "text")
      .map((item) => clean(item.text))
      .join("\n");

    const addText = (draw: () => string) =>
      output.addChild(preview(() => new Text(draw(), 0, 0), options.expanded));

    if (context.isError || options.isPartial) {
      addText(() => theme.fg(context.isError ? "error" : "accent", text || "● working"));

      return output;
    }

    if (notice?.type === "text")
      output.addChild(preview(() => new Text(theme.fg("warning", clean(notice.text)), 0, 0), true));

    if (text)
      output.addChild(
        preview(() => {
          if (manager)
            return new Text(theme.fg(tool === "mcp_list" ? "toolOutput" : "success", text), 0, 0);

          return new Text(theme.fg("toolOutput", text), 0, 0);
        }, options.expanded),
      );
    const images = result.content.filter((item) => item.type === "image").length;

    if (images)
      addText(() =>
        theme.fg(
          "muted",
          `${images} image${images === 1 ? "" : "s"}${context.showImages ? "" : " (previews hidden)"}`,
        ),
      );

    if (!text && !images && notice?.type !== "text")
      addText(() => theme.fg("muted", "(no output)"));

    // Pi owns image rendering; returning another Image component would duplicate the previews.
    return output;
  },
});
