import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { collectSkillProviders } from "@clanker-stuff/pi-skill-providers";
import { fuzzyFilter } from "@earendil-works/pi-tui";

import { SKILL_MENTION, installSkillMentionEditor } from "./editor.js";

const SKILL_COMPLETION = /(?:^|[ \t])\$(?<query>[A-Za-z0-9_:-]*)$/u;

const SKILL_NAME = /^[A-Za-z0-9_:-]*[A-Za-z0-9_-]$/u;

const SKILL_COMMAND_PREFIX = "skill:";

const escapeSkillText = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\n", "&#10;");

const escapeSkillAttribute = (value: string): string =>
  escapeSkillText(value).replaceAll('"', "&quot;");

/** Pi's skill block for a skill on disk, with its body read now. */
const readSkillBlock = async (name: string, filePath: string): Promise<string> => {
  const body = stripFrontmatter(await readFile(filePath, "utf-8")).trim();

  return `<skill name="${name}" location="${escapeSkillAttribute(filePath)}">\nReferences are relative to ${escapeSkillText(dirname(filePath))}.\n\n${body}\n</skill>`;
};

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

/** A skill `$` mentions can name: on disk, or from a provider extension. */
interface LoadableSkill {
  name: string;
  description: string | undefined;
  load(ctx: ExtensionContext): Promise<{ block: string } | { error: string }>;
}

export const createSkillMentions = (pi: ExtensionAPI) => {
  const providers = collectSkillProviders(pi.events);

  /** Skills on disk, then skills providers offer under names no skill on disk has. */
  const getSkills = (): LoadableSkill[] => {
    const local = pi.getCommands().flatMap((command): LoadableSkill[] => {
      const name = command.name.slice(SKILL_COMMAND_PREFIX.length);

      if (command.source !== "skill" || !SKILL_NAME.test(name)) return [];

      const filePath = command.sourceInfo.path;

      return [
        {
          description: command.description,
          load: async () => ({ block: await readSkillBlock(name, filePath) }),
          name,
        },
      ];
    });

    const localNames = new Set(local.map((skill) => skill.name));

    const provided = [...providers.values()].flatMap((provider) =>
      provider
        .skills()
        .filter((skill) => SKILL_NAME.test(skill.name) && !localNames.has(skill.name))
        .map((skill) => ({
          description: skill.description,
          load: async (ctx: ExtensionContext) => await provider.load(skill.name, ctx),
          name: skill.name,
        })),
    );

    return [...local, ...provided];
  };

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

  /**
   * Skill blocks for the mentioned skills, in skill-list order. Skills load one at a time, since a
   * provider may ask the user before loading; a skill that fails is reported and left out.
   */
  const loadMentionedSkills = async (text: string, ctx: ExtensionContext) => {
    const names = mentionedNames(text);
    const loaded: { block: string; name: string }[] = [];

    for (const skill of getSkills().filter((candidate) => names.has(candidate.name))) {
      const result = await skill.load(ctx).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }));

      if ("block" in result) {
        loaded.push({ block: result.block, name: skill.name });
      } else {
        ctx.ui.notify(`Failed to load skill ${skill.name}: ${result.error}`, "warning");
      }
    }

    return loaded;
  };

  /** Expand this input once, before native skill expansion and queueing; no run owns shared input. */
  const expand = async (
    event: InputEvent,
    ctx: ExtensionContext,
  ): Promise<InputEventResult | undefined> => {
    const loaded = await loadMentionedSkills(event.text, ctx);

    if (loaded.length === 0) return;
    ctx.ui.notify(`Loaded skills: ${loaded.map((skill) => `$${skill.name}`).join(", ")}`, "info");

    return {
      action: "transform",
      text: `${event.text}\n\n${loaded.map((skill) => skill.block).join("\n\n")}`,
    };
  };

  return { expand, install };
};
