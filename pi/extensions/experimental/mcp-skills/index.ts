import { getExtensionStoragePaths } from "@clanker-stuff/pi-extension-paths";
import { SKILL_PROVIDER_CHANNEL } from "@clanker-stuff/pi-skill-providers";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { completeSkillsCommand, runSkillsCommand } from "./command.js";
import {
  createMentionProvider,
  expandSkillCommand,
  skillCommandCompletion,
} from "./invoke.js";
import { addSkillsToPrompt } from "./prompt.js";
import { checkResourceRead } from "./resource-reads.js";
import { McpSkills } from "./runtime.js";
import { createSkillReads } from "./skill-reads.js";

export default function mcpSkills(pi: ExtensionAPI): void {
  const skills = new McpSkills(pi, {
    agentDir: getAgentDir(),
    dataDir: getExtensionStoragePaths("mcp-skills").dataDir,
  });

  const reads = createSkillReads(skills);

  pi.registerCommand("mcp-skills", {
    description:
      'Show MCP servers and their skills; "forget" drops every approval and stored skill',
    getArgumentCompletions: completeSkillsCommand,
    handler: async (args, ctx) => {
      await runSkillsCommand(skills, args, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.addAutocompleteProvider(skillCommandCompletion(skills));
    pi.events.emit(SKILL_PROVIDER_CHANNEL, createMentionProvider(skills));
    await skills.refresh(ctx);
  });
  pi.on("session_shutdown", async () => {
    await skills.servers.stop();
  });
  pi.on("before_agent_start", async (event, ctx) => {
    await addSkillsToPrompt(skills, event, ctx);
  });
  pi.on(
    "input",
    async (event, ctx) => await expandSkillCommand(skills, event, ctx)
  );
  pi.on("tool_call", async (event, ctx) => await reads.beforeRead(event, ctx));
  pi.on(
    "tool_call",
    async (event, ctx) => await checkResourceRead(skills, event, ctx)
  );
  pi.on("tool_result", (event) => reads.afterRead(event));
}
