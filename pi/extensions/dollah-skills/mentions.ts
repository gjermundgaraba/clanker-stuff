import { readFile } from "node:fs/promises";

import type {
  BeforeAgentStartEvent,
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

import { installSkillMentionEditor } from "./editor.js";

/** System prompt section holding this turn's loaded skill files; Pi wraps it in `<loaded_skills>`. */
export const LOADED_SKILLS_SECTION = "loaded_skills";

const SKILL_MENTION = /\$(?<name>[A-Za-z0-9_:-]+)/gu;

const SKILL_COMPLETION = /(?:^|[ \t])\$(?<query>[A-Za-z0-9_:-]*)$/u;

const SKILL_NAME = /^[A-Za-z0-9_:-]+$/u;

const SKILL_COMMAND_PREFIX = "skill:";

type Skill = NonNullable<BuildSystemPromptOptions["skills"]>[number];

interface LoadedSkill {
  baseDir: string;
  body: string;
  name: string;
  path: string;
}

const escapeSkillText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");

const escapeSkillAttribute = (value: string): string =>
  escapeSkillText(value).replaceAll('"', "&quot;");

const skillBlock = (skill: LoadedSkill): string =>
  `<skill name="${skill.name}" location="${escapeSkillAttribute(skill.path)}">\nReferences are relative to ${escapeSkillText(skill.baseDir)}.\n\n${skill.body}\n</skill>`;

const skillBlocks = (skills: readonly LoadedSkill[]): string => skills.map(skillBlock).join("\n\n");

export const createSkillMentions = (pi: ExtensionAPI) => {
  let activeSkills: Skill[] = [];

  const getSkills = () =>
    pi
      .getCommands()
      .filter((command) => command.source === "skill")
      .map((command) => ({
        description: command.description,
        name: command.name.slice(SKILL_COMMAND_PREFIX.length),
      }))
      .filter((skill) => SKILL_NAME.test(skill.name));

  const install = (ctx: ExtensionContext): void => {
    installSkillMentionEditor(ctx, () => getSkills().map((skill) => skill.name));

    ctx.ui.addAutocompleteProvider((current) => ({
      applyCompletion: current.applyCompletion.bind(current),
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const currentLine = lines[cursorLine] ?? "";
        const beforeCursor = currentLine.slice(0, cursorCol);
        const query = SKILL_COMPLETION.exec(beforeCursor)?.groups?.query;

        if (query === undefined) {
          return await current.getSuggestions(lines, cursorLine, cursorCol, options);
        }

        const items = fuzzyFilter(getSkills(), query, (skill) => skill.name).map((skill) => {
          const label = `$${skill.name}`;
          const value = `$${skill.name}`;

          return skill.description !== undefined && skill.description.length > 0
            ? { description: skill.description, label, value }
            : { label, value };
        });

        return items.length > 0 ? { items, prefix: `$${query}` } : null;
      },
      ...(current.shouldTriggerFileCompletion
        ? { shouldTriggerFileCompletion: current.shouldTriggerFileCompletion.bind(current) }
        : {}),
      triggerCharacters: ["$"],
    }));
  };

  const loadMentionedSkills = async (text: string, skills: Skill[], ctx: ExtensionContext) => {
    const mentionedNames = new Set<string>();

    for (const match of text.matchAll(SKILL_MENTION)) {
      const { name } = match.groups ?? {};

      if (name) {
        mentionedNames.add(name);
      }
    }

    if (mentionedNames.size === 0) {
      return [];
    }

    const loadSkill = async (skill: Skill): Promise<LoadedSkill | null> => {
      try {
        const contents = await readFile(skill.filePath, "utf-8");

        return {
          baseDir: skill.baseDir,
          body: stripFrontmatter(contents).trim(),
          name: skill.name,
          path: skill.filePath,
        };
      } catch (error) {
        ctx.ui.notify(
          `Failed to load skill ${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );

        return null;
      }
    };

    const loaded = await Promise.all(
      skills
        .values()
        .filter((skill) => mentionedNames.has(skill.name))
        .map(loadSkill),
    );

    return loaded.filter((skill) => skill !== null);
  };

  // A mention loads the skill for this turn's request. Pi records the section
  // patch in the transcript and replays it on models that accept mid-conversation
  // system messages; other models fold it into the prompt for this turn only.
  const inject = async (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> => {
    activeSkills = event.systemPromptOptions.skills;
    const loaded = await loadMentionedSkills(event.prompt, activeSkills, ctx);

    if (loaded.length > 0) {
      event.systemPromptOptions.sections[LOADED_SKILLS_SECTION] = skillBlocks(loaded);
      ctx.ui.notify(`Loaded skills: ${loaded.map((skill) => `$${skill.name}`).join(", ")}`, "info");
    }
  };

  const injectStreaming = async (
    event: InputEvent,
    ctx: ExtensionContext,
  ): Promise<InputEventResult | undefined> => {
    if (event.streamingBehavior === undefined) {
      return undefined;
    }

    // Prompt sections cannot change during a run, so queued input carries the files inline.
    const loaded = await loadMentionedSkills(event.text, activeSkills, ctx);

    return loaded.length === 0
      ? undefined
      : {
          action: "transform",
          ...(event.images !== undefined ? { images: event.images } : {}),
          text: `${skillBlocks(loaded)}\n\n${event.text}`,
        };
  };

  return { inject, injectStreaming, install };
};
