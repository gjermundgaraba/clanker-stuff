import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

import { SKILL_MENTION, installSkillMentionEditor } from "./editor.js";

const SKILL_COMPLETION = /(?:^|[ \t])\$(?<query>[A-Za-z0-9_:-]*)$/u;

const SKILL_NAME = /^[A-Za-z0-9_:-]*[A-Za-z0-9_-]$/u;

const SKILL_COMMAND_PREFIX = "skill:";

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
  const getSkills = () =>
    pi
      .getCommands()
      .filter((command) => command.source === "skill")
      .map((command) => ({
        description: command.description,
        name: command.name.slice(SKILL_COMMAND_PREFIX.length),
        filePath: command.sourceInfo.path,
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

  const loadMentionedSkills = async (text: string, ctx: ExtensionContext) => {
    const names = mentionedNames(text);

    if (names.size === 0) {
      return [];
    }

    const loadSkill = async (
      skill: ReturnType<typeof getSkills>[number],
    ): Promise<LoadedSkill | null> => {
      try {
        const contents = await readFile(skill.filePath, "utf-8");

        return {
          baseDir: dirname(skill.filePath),
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
      getSkills()
        .values()
        .filter((skill) => names.has(skill.name))
        .map(loadSkill),
    );

    return loaded.filter((skill) => skill !== null);
  };

  /** Expand this input once, before native skill expansion and queueing; no run owns shared input. */
  const expand = async (
    event: InputEvent,
    ctx: ExtensionContext,
  ): Promise<InputEventResult | undefined> => {
    const loaded = await loadMentionedSkills(event.text, ctx);

    if (loaded.length === 0) return;
    ctx.ui.notify(`Loaded skills: ${loaded.map((skill) => `$${skill.name}`).join(", ")}`, "info");

    return { action: "transform", text: `${event.text}\n\n${skillBlocks(loaded)}` };
  };

  return { expand, install };
};
