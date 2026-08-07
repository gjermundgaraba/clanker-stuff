import { readFile } from "node:fs/promises";

import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import {
  getMarkdownTheme,
  stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Box, fuzzyFilter, Markdown, Text } from "@earendil-works/pi-tui";

const SKILL_MENTION = /\$(?<name>[A-Za-z0-9_:-]+)/gu;
const SKILL_COMPLETION = /(?:^|[ \t])\$(?<query>[A-Za-z0-9_:-]*)$/u;
const SKILL_NAME = /^[A-Za-z0-9_:-]+$/u;
const DEFINITE_SHELL_PARAMETER = /^(?:\d+|[-_])$/u;
const SKILL_COMMAND_PREFIX = "skill:";
const REGISTER_DECORATION_EVENT = "decorated-editor:register";
const COMMON_ENV_VARS = new Set([
  "HOME",
  "LANG",
  "PATH",
  "PWD",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CONFIG_HOME",
]);

export interface InjectedSkillsDetails {
  skills: { body: string; name: string; path: string }[];
}

const renderInjectedSkills: MessageRenderer<InjectedSkillsDetails> = (
  message,
  { expanded, outputPad },
  theme
) => {
  const skills = message.details?.skills ?? [];
  const header = theme.fg(
    "accent",
    `◆ Skills injected: ${skills.map((skill) => `$${skill.name}`).join(", ")}`
  );
  const bg = (content: string) => theme.bg("customMessageBg", content);

  if (!expanded) {
    return new Text(header, outputPad, 1, bg);
  }

  const box = new Box(outputPad, 1, bg);
  box.addChild(new Text(header, 0, 0));
  for (const skill of skills) {
    box.addChild(
      new Text(
        `${theme.fg("accent", `$${skill.name}`)}\n${theme.fg("dim", skill.path)}`,
        0,
        0
      )
    );
    box.addChild(new Markdown(skill.body, 0, 0, getMarkdownTheme()));
  }
  return box;
};

export const createSkillMentions = (pi: ExtensionAPI) => {
  const getSkills = () =>
    pi
      .getCommands()
      .filter((command) => command.source === "skill")
      .map((command) => ({
        description: command.description,
        name: command.name.slice(SKILL_COMMAND_PREFIX.length),
      }))
      .filter(
        (skill) =>
          SKILL_NAME.test(skill.name) && !COMMON_ENV_VARS.has(skill.name)
      );

  const install = (ctx: ExtensionContext): void => {
    const skillNames = getSkills().map((skill) => skill.name);
    if (skillNames.length > 0) {
      pi.events.emit(REGISTER_DECORATION_EVENT, {
        color: "accent",
        id: "codex-skills",
        pattern: new RegExp(
          `\\$(?:${skillNames.join("|")})(?![A-Za-z0-9_:-])`,
          "gu"
        ),
      });
    }

    ctx.ui.addAutocompleteProvider((current) => ({
      applyCompletion: current.applyCompletion.bind(current),
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const currentLine = lines[cursorLine] ?? "";
        const beforeCursor = currentLine.slice(0, cursorCol);
        const query = SKILL_COMPLETION.exec(beforeCursor)?.groups?.query;
        if (query === undefined) {
          return await current.getSuggestions(
            lines,
            cursorLine,
            cursorCol,
            options
          );
        }
        if (DEFINITE_SHELL_PARAMETER.test(query)) {
          return null;
        }

        const items = fuzzyFilter(
          getSkills(),
          query,
          (skill) => skill.name
        ).map((skill) => ({
          ...(typeof skill.description === "string" &&
          skill.description.length > 0
            ? { description: skill.description }
            : {}),
          label: `$${skill.name}`,
          value: `$${skill.name}`,
        }));

        return items.length > 0 ? { items, prefix: `$${query}` } : null;
      },
      shouldTriggerFileCompletion:
        current.shouldTriggerFileCompletion?.bind(current),
      triggerCharacters: ["$"],
    }));
  };

  const inject = async (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext
  ): Promise<BeforeAgentStartEventResult | undefined> => {
    const mentionedNames = new Set<string>();
    for (const match of event.prompt.matchAll(SKILL_MENTION)) {
      const { name } = match.groups ?? {};
      if (name && !COMMON_ENV_VARS.has(name)) {
        mentionedNames.add(name);
      }
    }
    if (mentionedNames.size === 0) {
      return undefined;
    }

    const loadedBlocks = await Promise.all(
      (event.systemPromptOptions.skills ?? [])
        .filter((skill) => mentionedNames.has(skill.name))
        .map(async (skill) => {
          try {
            const contents = await readFile(skill.filePath, "utf-8");
            const body = stripFrontmatter(contents).trim();
            return {
              body,
              content: `<skill>\n<name>${skill.name}</name>\n<path>${skill.filePath}</path>\n${body}\n</skill>`,
              name: skill.name,
              path: skill.filePath,
            };
          } catch (error) {
            ctx.ui.notify(
              `Failed to load skill ${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
              "warning"
            );
            return null;
          }
        })
    );
    const blocks = loadedBlocks.filter((block) => block !== null);
    if (blocks.length === 0) {
      return undefined;
    }

    return {
      message: {
        content: blocks.map((block) => block.content).join("\n\n"),
        customType: "codex-skills",
        details: {
          skills: blocks.map(({ body, name, path }) => ({
            body,
            name,
            path,
          })),
        } satisfies InjectedSkillsDetails,
        display: true,
      },
    };
  };

  return { inject, install, render: renderInjectedSkills };
};
