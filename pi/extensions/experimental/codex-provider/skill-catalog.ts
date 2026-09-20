import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const READ_GUIDANCE =
  "Use the read tool to load a skill's file when the task matches its description.";

/** Pi renders its own catalog section whenever one of these is active. */
const PI_FILE_READERS = ["read", "bash"] as const;

const FILE_LOADERS = ["exec_command", "exec"] as const;

/** Pi's own catalog section name; supplying it restores the catalog Pi omits without `read`. */
const SKILLS_SECTION = "skills";

export const exposeSkillsWithoutRead = (
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  activeTools: readonly string[],
): void => {
  if (
    ctx.model?.provider !== "openai-codex" ||
    PI_FILE_READERS.some((name) => activeTools.includes(name))
  ) {
    return;
  }

  const loader = FILE_LOADERS.find((name) => activeTools.includes(name));

  if (loader === undefined) {
    return;
  }

  const catalog = formatSkillsForPrompt(event.systemPromptOptions.skills)
    .replace(
      READ_GUIDANCE,
      `Use the \`${loader}\` tool to load a skill's file when the task matches its description.`,
    )
    .trim();

  if (catalog.length > 0) {
    event.systemPromptOptions.sections[SKILLS_SECTION] = catalog;
  }
};
