import { readFile } from "node:fs/promises";

import type {
  BeforeAgentStartEventResult,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Text } from "@earendil-works/pi-tui";

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

interface CodexSkillsDetails {
  skills: { name: string; path: string }[];
}

const getSkills = (pi: ExtensionAPI) =>
  pi
    .getCommands()
    .filter((command) => command.source === "skill")
    .map((command) => ({
      description: command.description,
      name: command.name.slice(SKILL_COMMAND_PREFIX.length),
    }))
    .filter(
      (skill) => SKILL_NAME.test(skill.name) && !COMMON_ENV_VARS.has(skill.name)
    );

export default function codexSkillsExtension(pi: ExtensionAPI) {
  pi.registerMessageRenderer<CodexSkillsDetails>(
    "codex-skills",
    (message, options, theme) => {
      const { expanded } = options;
      const outputPad =
        "outputPad" in options && typeof options.outputPad === "number"
          ? options.outputPad
          : 1;
      const skills = message.details?.skills ?? [];
      let text = theme.fg(
        "accent",
        `◆ Skills injected: ${skills.map((skill) => `$${skill.name}`).join(", ")}`
      );
      if (expanded) {
        text += skills
          .map(
            (skill) =>
              `\n  ${theme.fg("accent", `$${skill.name}`)}\n    ${theme.fg("dim", skill.path)}`
          )
          .join("");
      }

      return new Text(text, outputPad, 1, (content) =>
        theme.bg("customMessageBg", content)
      );
    }
  );

  pi.on("session_start", (_event, ctx) => {
    const skillNames = getSkills(pi).map((skill) => skill.name);
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
        if (
          COMMON_ENV_VARS.has(query) ||
          DEFINITE_SHELL_PARAMETER.test(query)
        ) {
          return null;
        }

        const items = fuzzyFilter(
          getSkills(pi),
          query,
          (skill) => skill.name
        ).map((skill) => ({
          ...(skill.description !== undefined && skill.description.length > 0
            ? { description: skill.description }
            : undefined),
          label: `$${skill.name}`,
          value: `$${skill.name}`,
        }));

        return items.length > 0 ? { items, prefix: `$${query}` } : null;
      },
      shouldTriggerFileCompletion:
        current.shouldTriggerFileCompletion?.bind(current),
      triggerCharacters: ["$"],
    }));
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const mentionedNames = new Set<string>();
    for (const match of event.prompt.matchAll(SKILL_MENTION)) {
      const { name } = match.groups ?? {};
      if (name && !COMMON_ENV_VARS.has(name)) {
        mentionedNames.add(name);
      }
    }

    let result: BeforeAgentStartEventResult | undefined;
    if (mentionedNames.size > 0) {
      const loadedBlocks = await Promise.all(
        (event.systemPromptOptions.skills ?? [])
          .filter((skill) => mentionedNames.has(skill.name))
          .map(async (skill) => {
            try {
              const contents = await readFile(skill.filePath, "utf-8");
              return {
                content: `<skill>\n<name>${skill.name}</name>\n<path>${skill.filePath}</path>\n${contents}\n</skill>`,
                name: skill.name,
                path: skill.filePath,
              };
            } catch (error) {
              ctx.ui.notify(
                `Failed to load skill ${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
                "warning"
              );
            }
            return null;
          })
      );
      const blocks = loadedBlocks.filter((block) => block !== null);

      if (blocks.length > 0) {
        result = {
          message: {
            content: blocks.map((block) => block.content).join("\n\n"),
            customType: "codex-skills",
            details: {
              skills: blocks.map(({ name, path }) => ({ name, path })),
            } satisfies CodexSkillsDetails,
            display: true,
          },
        };
      }
    }

    return result;
  });
}
