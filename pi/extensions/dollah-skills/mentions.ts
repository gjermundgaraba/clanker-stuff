import { readFile } from "node:fs/promises";

import type {
  BeforeAgentStartEvent,
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
} from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

import { SKILL_MENTION, installSkillMentionEditor } from "./editor.js";

/** System prompt section holding this turn's loaded skill files; Pi wraps it in `<loaded_skills>`. */
export const LOADED_SKILLS_SECTION = "loaded_skills";

const SKILL_COMPLETION = /(?:^|[ \t])\$(?<query>[A-Za-z0-9_:-]*)$/u;

const SKILL_NAME = /^[A-Za-z0-9_:-]*[A-Za-z0-9_-]$/u;

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

/** Names `$`-mentioned in typed text, except one the text already invokes as a leading `/skill:name`. */
const mentionedNames = (text: string): Set<string> => {
  const names = new Set(
    text
      .matchAll(SKILL_MENTION)
      .flatMap((match) => (match.groups?.name ? [match.groups.name] : [])),
  );

  // Pi takes the skill name up to the first space, as here.
  if (text.startsWith(`/${SKILL_COMMAND_PREFIX}`)) {
    const space = text.indexOf(" ");
    names.delete(text.slice(SKILL_COMMAND_PREFIX.length + 1, space === -1 ? undefined : space));
  }

  return names;
};

export const createSkillMentions = (pi: ExtensionAPI) => {
  /** The latest submission as typed. Pi runs input handlers before before_agent_start on every prompt. */
  let typed: string | undefined;

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
    const names = mentionedNames(text);

    if (names.size === 0) {
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
        .filter((skill) => names.has(skill.name))
        .map(loadSkill),
    );

    return loaded.filter((skill) => skill !== null);
  };

  /**
   * Never rewrites input, so Pi still expands a leading `/skill:name` and later handlers see what
   * was typed. Queued messages never reach before_agent_start, so their mentions load nothing and
   * the user is told; Pi expands a queued `/skill:name` before queueing it.
   */
  const record = (event: InputEvent, ctx: ExtensionContext): void => {
    // Kept even when queued: a run that ends while input handlers await makes this a new turn.
    typed = event.text;

    if (event.streamingBehavior === undefined) {
      return;
    }

    const known = new Set(getSkills().map((skill) => skill.name));
    const [first, ...rest] = [...mentionedNames(event.text)].filter((name) => known.has(name));

    if (first === undefined) {
      return;
    }

    const mentions = [first, ...rest].map((name) => `$${name}`).join(", ");
    const command = rest.length === 0 ? `/skill:${first}` : "/skill:<name>";

    ctx.ui.notify(
      `Queued message: ${mentions} not loaded. Queue ${command} instead, or send once Pi is idle.`,
      "warning",
    );
  };

  // A mention loads the skill for this turn's request, after Pi has validated the prompt. Only the
  // typed text counts: a skill file that Pi's `/skill:name` expanded loads nothing it mentions. Pi
  // records the section patch in the transcript and replays it on models that accept
  // mid-conversation system messages; other models fold it into the prompt for this turn only.
  const inject = async (event: BeforeAgentStartEvent, ctx: ExtensionContext): Promise<void> => {
    const text = typed;
    typed = undefined;

    if (text === undefined) {
      return;
    }

    const loaded = await loadMentionedSkills(text, event.systemPromptOptions.skills, ctx);

    if (loaded.length > 0) {
      event.systemPromptOptions.sections[LOADED_SKILLS_SECTION] = skillBlocks(loaded);
      ctx.ui.notify(`Loaded skills: ${loaded.map((skill) => `$${skill.name}`).join(", ")}`, "info");
    }
  };

  return { inject, install, record };
};
