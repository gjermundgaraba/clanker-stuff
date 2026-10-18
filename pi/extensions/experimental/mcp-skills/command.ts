import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";

import type { McpSkills } from "./runtime.js";
import type { ServerStatus } from "./servers.js";

const STATE_LABELS: Record<ServerStatus["state"], string> = {
  connecting: "connecting",
  failed: "failed",
  "needs-sign-in": "needs sign-in",
  "no-skills": "serves no skills",
  ready: "ready",
};

/** The servers, their skills with the names they go by, and the skills that are not loaded and why. */
const statusReport = (skills: McpSkills): string => {
  const catalog = skills.catalog();

  const lines = skills.servers
    .statuses()
    .flatMap((status) => [
      `${status.name}: ${STATE_LABELS[status.state]}${status.error ? ` (${inlineText(status.error)})` : ""}`,
      ...catalog
        .filter((skill) => skill.server === status.name)
        .map((skill) => `  /skill:${skill.name}  ${inlineText(skill.entry.uri)}`),
      ...status.declined.map(
        (skill) => `  not loaded: ${inlineText(skill.uri)} ${inlineText(skill.reason)}`,
      ),
    ]);

  return lines.length > 0 ? lines.join("\n") : "No MCP servers are configured.";
};

/** Completions for the command's one argument. */
export const completeSkillsCommand = (prefix: string): AutocompleteItem[] =>
  "forget".startsWith(prefix) ? [{ label: "forget", value: "forget" }] : [];

/**
 * `/mcp-skills` shows the servers and their skills; `/mcp-skills forget` drops every approval and
 * deletes the stored skills.
 */
export const runSkillsCommand = async (
  skills: McpSkills,
  args: string,
  ctx: ExtensionCommandContext,
): Promise<void> => {
  if (args.trim() === "forget") {
    await skills.forget();
    ctx.ui.notify("Forgot every MCP skill approval and deleted the stored skills.", "info");

    return;
  }

  await skills.refresh(ctx);
  ctx.ui.notify(statusReport(skills), "info");
};
