import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const READ_GUIDANCE =
  "Use the read tool to load a skill's file when the task matches its description.";

const FILE_LOADERS = ["exec_command", "exec"] as const;

export const exposeSkillsWithoutRead = (
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  activeTools: readonly string[],
): BeforeAgentStartEventResult | undefined => {
  if (
    ctx.model?.provider !== "openai-codex" ||
    activeTools.includes("read") ||
    event.systemPrompt.includes("<available_skills>")
  ) {
    return undefined;
  }

  const loader = FILE_LOADERS.find((name) => activeTools.includes(name));

  if (loader === undefined) {
    return undefined;
  }

  const catalog = formatSkillsForPrompt(event.systemPromptOptions.skills ?? []).replace(
    READ_GUIDANCE,
    `Use the \`${loader}\` tool to load a skill's file when the task matches its description.`,
  );

  return catalog.length > 0 ? { systemPrompt: `${event.systemPrompt}${catalog}` } : undefined;
};
