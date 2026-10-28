import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  collectSkillProviders,
  skillBlock,
} from "@clanker-stuff/pi-skill-providers";
import type {
  LoadedSkill,
  ProvidedSkill,
} from "@clanker-stuff/pi-skill-providers";
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

interface LoadableSkill {
  name: string;
  description: string | undefined;
  load: (ctx: ExtensionContext) => Promise<ProvidedSkill | { error: string }>;
}

const readSkill = async (filePath: string): Promise<ProvidedSkill> => {
  const body = stripFrontmatter(await readFile(filePath, "utf-8")).trim();

  return {
    content: `References are relative to ${path.dirname(filePath)}.\n\n${body}`,
    location: filePath,
  };
};

export const createSkillMentions = (pi: ExtensionAPI) => {
  const providers = collectSkillProviders(pi.events);

  const getSkills = (): LoadableSkill[] => {
    const local = pi.getCommands().flatMap((command): LoadableSkill[] => {
      const name = command.name.slice(SKILL_COMMAND_PREFIX.length);

      if (command.source !== "skill" || !SKILL_NAME.test(name)) {
        return [];
      }

      const filePath = command.sourceInfo.path;

      return [
        {
          description: command.description,
          load: async () => await readSkill(filePath),
          name,
        },
      ];
    });

    const localNames = new Set(local.map((skill) => skill.name));

    const provided = [...providers.values()].flatMap((provider) =>
      provider
        .skills()
        .filter(
          (skill) => SKILL_NAME.test(skill.name) && !localNames.has(skill.name)
        )
        .map((skill) => ({
          description: skill.description,
          load: async (ctx: ExtensionContext) =>
            await provider.load(skill.name, ctx),
          name: skill.name,
        }))
    );

    return [...local, ...provided];
  };

  const invokesCommand = (text: string): boolean => {
    if (!text.startsWith("/")) {
      return false;
    }

    const [name] = text.slice(1).split(/\s/u, 1);

    return pi.getCommands().some((command) => command.name === name);
  };

  const install = (ctx: ExtensionContext): void => {
    installSkillMentionEditor(ctx, () =>
      getSkills().map((skill) => skill.name)
    );

    ctx.ui.addAutocompleteProvider((current) => ({
      applyCompletion: current.applyCompletion.bind(current),
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const currentLine = lines[cursorLine] ?? "";
        const beforeCursor = currentLine.slice(0, cursorCol);
        const query = SKILL_COMPLETION.exec(beforeCursor)?.groups?.["query"];

        if (query === undefined) {
          return await current.getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            options
          );
        }

        const items = fuzzyFilter(
          getSkills(),
          query,
          (skill) => skill.name
        ).map((skill) => {
          const value = `$${skill.name}`;

          return {
            label: value,
            value,
            ...(skill.description !== undefined && skill.description !== ""
              ? { description: skill.description }
              : {}),
          };
        });

        return items.length > 0 ? { items, prefix: `$${query}` } : null;
      },
      ...(current.shouldTriggerFileCompletion
        ? {
            shouldTriggerFileCompletion:
              current.shouldTriggerFileCompletion.bind(current),
          }
        : {}),
      triggerCharacters: ["$"],
    }));
  };

  const loadMentionedSkills = async (
    text: string,
    ctx: ExtensionContext
  ): Promise<LoadedSkill[]> => {
    const names = new Set(
      text.matchAll(SKILL_MENTION).map((match) => match[0].slice(1))
    );

    const loaded: LoadedSkill[] = [];

    for (const skill of getSkills().filter((candidate) =>
      names.has(candidate.name)
    )) {
      const result = await skill.load(ctx).catch((error: unknown) => ({
        error: error instanceof Error ? error.message : String(error),
      }));

      if ("error" in result) {
        ctx.ui.notify(
          `Failed to load skill ${skill.name}: ${result.error}`,
          "warning"
        );
      } else {
        loaded.push({ ...result, name: skill.name });
      }
    }

    return loaded;
  };

  const expand = async (
    event: InputEvent,
    ctx: ExtensionContext
  ): Promise<InputEventResult | undefined> => {
    if (invokesCommand(event.text)) {
      return;
    }

    const loaded = await loadMentionedSkills(event.text, ctx);

    if (loaded.length === 0) {
      return;
    }

    return {
      action: "transform",
      text: `${skillBlock(loaded)}\n\n${event.text}`,
    };
  };

  return { expand, install };
};
