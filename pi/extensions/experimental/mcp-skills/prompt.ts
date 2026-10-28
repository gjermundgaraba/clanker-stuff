import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import type {
  BeforeAgentStartEvent,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { McpSkills } from "./runtime.js";

const STARTUP_WAIT_MS = 3000;

const AGENT_SKILLS_MAX_DESCRIPTION = 1024;

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
      description: description.slice(0, AGENT_SKILLS_MAX_DESCRIPTION),
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
