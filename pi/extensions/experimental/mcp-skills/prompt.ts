import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import type {
  BeforeAgentStartEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { McpSkills } from "./runtime.js";

/** How long a run waits for servers that are still listing their skills. */
const STARTUP_WAIT_MS = 3000;

/** The Agent Skills limit for descriptions. */
const MAX_DESCRIPTION = 1024;

/**
 * Add MCP skills to Pi's own skill list for this run, so Pi renders them with local skills. Each
 * entry carries its server in the name and description, and as its location the path its
 * `SKILL.md` is stored at once a `read` of that path loads it.
 */
export const addSkillsToPrompt = async (
  skills: McpSkills,
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext
): Promise<void> => {
  const options = event.systemPromptOptions;

  if (!options.selectedTools.includes("read")) {
    return;
  }

  await skills.prepareRun(ctx, STARTUP_WAIT_MS);

  for (const skill of skills.catalog()) {
    if (skill.entry.disableModelInvocation) {
      continue;
    }

    const description = `[MCP server "${skill.server}", untrusted] ${inlineText(skill.entry.description)}`;

    options.skills.push({
      baseDir: skill.dir,
      description: description.slice(0, MAX_DESCRIPTION),
      disableModelInvocation: false,
      filePath: skill.path,
      name: skill.name,
      sourceInfo: createSyntheticSourceInfo(skill.path, {
        baseDir: skill.dir,
        source: "mcp-skills",
      }),
    });
  }
};
