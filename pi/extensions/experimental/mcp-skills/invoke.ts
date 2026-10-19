import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { skillBlock } from "@clanker-stuff/pi-skill-providers";
import type { LoadedSkill, SkillProvider } from "@clanker-stuff/pi-skill-providers";
import { inlineText } from "@clanker-stuff/pi-tool-rendering/text";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

import type { CatalogSkill } from "./catalog.js";
import type { McpSkills } from "./runtime.js";
import { skillOrigin } from "./skill-reads.js";

const SKILL_COMMAND = /^\/skill:(?<name>\S+)(?:\s+(?<args>[\s\S]*))?$/u;

const COMMAND_PREFIX = /^\s*\/(?<query>\S*)$/u;

/** What completions say about a skill: its server, then its description on one line. */
const completionDescription = (skill: CatalogSkill): string =>
  `[MCP ${skill.server}] ${inlineText(skill.entry.description)}`;

/** Load skill content through the same approval and checks as a model load. */
const loadSkill = async (
  skills: McpSkills,
  skill: CatalogSkill,
  ctx: ExtensionContext,
): Promise<LoadedSkill | { error: string }> => {
  const loaded = await skills.load(ctx, skill, ctx.signal);

  if ("error" in loaded) return loaded;

  return {
    content: `${skillOrigin(skill)}\n\n${stripFrontmatter(loaded.bytes.toString("utf8")).trim()}`,
    location: skill.path,
    name: skill.name,
  };
};

/**
 * Expand `/skill:<server>:<name> [args]` before Pi's own `/skill:` expansion, which only knows
 * skills on disk. A skill that cannot be loaded stops the message instead of sending the raw command.
 */
export const expandSkillCommand = async (
  skills: McpSkills,
  event: InputEvent,
  ctx: ExtensionContext,
): Promise<InputEventResult | undefined> => {
  const match = SKILL_COMMAND.exec(event.text);
  const name = match?.groups?.name;

  const skill =
    name === undefined ? undefined : skills.catalog().find((candidate) => candidate.name === name);

  if (!skill) return undefined;

  const loaded = await loadSkill(skills, skill, ctx);

  if ("error" in loaded) {
    ctx.ui.notify(loaded.error, "error");

    return { action: "handled" };
  }

  const args = match?.groups?.args?.trim();
  const block = skillBlock([loaded]);

  return { action: "transform", text: args ? `${block}\n\n${args}` : block };
};

/** MCP skills for `$` mentions in dollah-skills, loaded the same way as `/skill:`. */
export const createMentionProvider = (skills: McpSkills): SkillProvider => ({
  id: "mcp-skills",
  async load(name, ctx) {
    const skill = skills.catalog().find((candidate) => candidate.name === name);

    return skill
      ? await loadSkill(skills, skill, ctx)
      : { error: `there is no MCP skill named ${name}` };
  },
  skills: () =>
    skills.catalog().map((skill) => ({
      description: completionDescription(skill),
      name: skill.name,
    })),
});

/**
 * Rank command completions like Pi does: matches on the name without `skill:` first, then matches
 * on the full name.
 */
const rankCommands = (items: readonly AutocompleteItem[], query: string): AutocompleteItem[] => {
  const bare = fuzzyFilter([...items], query, (item) => item.value.replace(/^skill:/u, ""));
  const matched = new Set(bare);

  return [
    ...bare,
    ...fuzzyFilter(
      items.filter((item) => !matched.has(item)),
      query,
      (item) => item.value,
    ),
  ];
};

/** Add `/skill:<server>:<name>` entries to slash-command completion, ranked with Pi's own commands. */
export const skillCommandCompletion =
  (skills: McpSkills) =>
  (current: AutocompleteProvider): AutocompleteProvider => ({
    applyCompletion: current.applyCompletion.bind(current),
    ...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
    ...(current.shouldTriggerFileCompletion
      ? { shouldTriggerFileCompletion: current.shouldTriggerFileCompletion.bind(current) }
      : {}),
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);

      const query = options.force
        ? undefined
        : COMMAND_PREFIX.exec((lines[cursorLine] ?? "").slice(0, cursorCol))?.groups?.query;

      if (query === undefined || cursorLine !== 0) return suggestions;

      const items = skills.catalog().map((skill) => ({
        description: completionDescription(skill),
        label: `skill:${skill.name}`,
        value: `skill:${skill.name}`,
      }));

      const ranked = rankCommands([...(suggestions?.items ?? []), ...items], query);

      return ranked.length > 0 ? { items: ranked, prefix: `/${query}` } : suggestions;
    },
  });
