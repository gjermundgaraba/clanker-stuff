import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { collectSkillProviders } from "@clanker-stuff/pi-skill-providers";
import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  ParsedSkillBlock,
} from "@earendil-works/pi-coding-agent";
import { parseSkillBlock, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

import { SKILL_MENTION, installSkillMentionEditor } from "./editor.js";

const SKILL_COMPLETION = /(?:^|[ \t])\$(?<query>[A-Za-z0-9_:-]*)$/u;

const SKILL_NAME = /^[A-Za-z0-9_:-]*[A-Za-z0-9_-]$/u;

const SKILL_COMMAND_PREFIX = "skill:";

/** The parts of a Pi skill block: its tag attributes and what `/skill:name` writes between the tags. */
export type LoadedSkill = Pick<ParsedSkillBlock, "content" | "location" | "name">;

/**
 * The block Pi writes for `/skill:name`, which its chat view collapses when it leads a user message.
 * One skill reproduces its block exactly. Several share one block, each under its own heading,
 * because Pi collapses only a single leading block.
 */
export const skillBlock = (skills: readonly LoadedSkill[]): string => {
  const name = skills.map((skill) => skill.name).join(", ");
  const location = skills.map((skill) => skill.location).join(", ");

  const sections =
    skills.length === 1
      ? skills.map((skill) => skill.content)
      : skills.map((skill) => `## ${skill.name}\n\n${skill.content}`);

  return `<skill name="${name}" location="${location}">\n${sections.join("\n\n")}\n</skill>`;
};

/** Names `$`-mentioned in typed text. */
const mentionedNames = (text: string): Set<string> =>
  new Set(
    text
      .matchAll(SKILL_MENTION)
      .flatMap((match) => (match.groups?.name ? [match.groups.name] : [])),
  );

/** A skill `$` mentions can name: on disk, or from a provider extension. */
interface LoadableSkill {
  name: string;
  description: string | undefined;
  load(ctx: ExtensionContext): Promise<LoadedSkill | { error: string }>;
}

/** Pi's block parts for a skill on disk, with its body read now. */
const readSkill = async (name: string, filePath: string): Promise<LoadedSkill> => {
  const body = stripFrontmatter(await readFile(filePath, "utf-8")).trim();

  return {
    content: `References are relative to ${dirname(filePath)}.\n\n${body}`,
    location: filePath,
    name,
  };
};

export const createSkillMentions = (pi: ExtensionAPI) => {
  const providers = collectSkillProviders(pi.events);

  /** Skills on disk, then skills providers offer under names no skill on disk has. */
  const getSkills = (): LoadableSkill[] => {
    const local = pi.getCommands().flatMap((command): LoadableSkill[] => {
      const name = command.name.slice(SKILL_COMMAND_PREFIX.length);

      if (command.source !== "skill" || !SKILL_NAME.test(name)) return [];

      const filePath = command.sourceInfo.path;

      return [{ description: command.description, load: () => readSkill(name, filePath), name }];
    });

    const localNames = new Set(local.map((skill) => skill.name));

    const provided = [...providers.values()].flatMap((provider) =>
      provider
        .skills()
        .filter((skill) => SKILL_NAME.test(skill.name) && !localNames.has(skill.name))
        .map((skill) => ({
          description: skill.description,
          // A provider hands over a whole block; the merged block needs its parts.
          load: async (ctx: ExtensionContext) => {
            const result = await provider.load(skill.name, ctx);

            if ("error" in result) return result;

            return (
              parseSkillBlock(result.block) ?? { error: "the provider returned no skill block" }
            );
          },
          name: skill.name,
        })),
    );

    return [...local, ...provided];
  };

  /**
   * Pi runs extension commands before input handlers and expands `/skill:name` and prompt templates
   * after them, so input that names a registered command, template or skill stays with Pi.
   */
  const invokesCommand = (text: string): boolean => {
    if (!text.startsWith("/")) return false;
    const [name] = text.slice(1).split(/\s/u, 1);

    return pi.getCommands().some((command) => command.name === name);
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
   * Parts of the mentioned skills, in skill-list order. Skills load one at a time, since a
   * provider may ask the user before loading; a skill that fails is reported and left out.
   */
  const loadMentionedSkills = async (
    text: string,
    ctx: ExtensionContext,
  ): Promise<LoadedSkill[]> => {
    const names = mentionedNames(text);
    const loaded: LoadedSkill[] = [];

    for (const skill of getSkills().filter((candidate) => names.has(candidate.name))) {
      const result = await skill.load(ctx).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }));

      if ("error" in result) {
        ctx.ui.notify(`Failed to load skill ${skill.name}: ${result.error}`, "warning");
      } else {
        loaded.push(result);
      }
    }

    return loaded;
  };

  /**
   * Put the mentioned skills ahead of the typed text in Pi's native `/skill:name` shape. Pi records
   * it as the user message, collapses the block in the chat view and keeps the typed text visible.
   */
  const expand = async (
    event: InputEvent,
    ctx: ExtensionContext,
  ): Promise<InputEventResult | undefined> => {
    if (invokesCommand(event.text)) return;
    const loaded = await loadMentionedSkills(event.text, ctx);

    if (loaded.length === 0) return;

    return { action: "transform", text: `${skillBlock(loaded)}\n\n${event.text}` };
  };

  return { expand, install };
};
