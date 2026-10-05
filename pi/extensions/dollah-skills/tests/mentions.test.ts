import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CustomEditor,
  createSyntheticSourceInfo,
  parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import {
  createExtensionHost,
  normalizedSystemPromptOptions,
} from "../../../tests/harness/extension-host.js";
import type { ExtensionHostOptions } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";
import { LOADED_SKILLS_SECTION } from "../mentions.js";

const SOURCE_INFO = createSyntheticSourceInfo("<test>", {
  origin: "top-level",
  scope: "project",
  source: "test",
});

const createMentionHost = (commands: ExtensionHostOptions["commands"] = []) =>
  createExtensionHost(extension, { commands });

const createSkillHost = () =>
  createMentionHost([
    {
      description: "Alpha instructions",
      name: "skill:alpha",
      source: "skill",
      sourceInfo: SOURCE_INFO,
    },
    {
      description: "Beta instructions",
      name: "skill:beta",
      source: "skill",
      sourceInfo: SOURCE_INFO,
    },
    {
      description: "Plugin deploy instructions",
      name: "skill:plugin:deploy",
      source: "skill",
      sourceInfo: SOURCE_INFO,
    },
  ]);

/** Writes skill files, with quotes in their paths, as both Pi's skill list and its skill commands. */
const writeSkills = async (entries: readonly (readonly [name: string, body: string])[]) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dollah-skills-"));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));

  const skills = await Promise.all(
    entries.map(async ([name, body]) => {
      const filePath = path.join(directory, `${name.replace(":", "-")}"&<.md`);
      await writeFile(filePath, `---\nname: ${name}\n---\n${body}\n`);

      return {
        block: `<skill name="${name}" location="${filePath.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}">\nReferences are relative to ${directory}.\n\n${body}\n</skill>`,
        skill: {
          baseDir: directory,
          description: `${name} skill`,
          disableModelInvocation: false,
          filePath,
          name,
          sourceInfo: SOURCE_INFO,
        },
      };
    }),
  );

  const blocks = new Map(skills.map(({ block, skill }) => [skill.name, block]));

  const host = createMentionHost(
    skills.map(({ skill }) => ({
      description: skill.description,
      name: `skill:${skill.name}`,
      source: "skill" as const,
      sourceInfo: SOURCE_INFO,
    })),
  );

  /** Starts a turn as Pi does, returning the loaded-skills section it got. */
  const start = async (prompt: string, ctx = host.createContext()) => {
    const systemPromptOptions = normalizedSystemPromptOptions({
      cwd: directory,
      skills: skills.map(({ skill }) => skill),
    });

    await host.emit(
      "before_agent_start",
      { prompt, systemPrompt: "", systemPromptOptions, type: "before_agent_start" },
      ctx,
    );

    return systemPromptOptions.sections[LOADED_SKILLS_SECTION];
  };

  /** Submits `typed` as Pi does: input handlers, then before_agent_start with the expanded prompt. */
  const submit = async (typed: string, prompt = typed, ctx = host.createContext()) => {
    const result = await host.emitInput({ source: "interactive", text: typed, type: "input" }, ctx);

    return { result, section: await start(prompt, ctx) };
  };

  return { block: (name: string) => blocks.get(name) ?? "", host, start, submit };
};

describe("skill mentions", () => {
  it.each([false, true])(
    "loads typed mentions once in catalog order into the prompt section, foreign editor=%s",
    async (foreign) => {
      const { block, host, submit } = await writeSkills([
        ["alpha", "Alpha instructions."],
        ["beta", "Beta instructions."],
        ["plugin:deploy", "Deploy instructions."],
        ["review", "Review instructions."],
      ]);

      const ctx = host.createContext();

      if (foreign)
        ctx.ui.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
      await host.emitSessionStart(ctx);

      const { result, section } = await submit(
        "Use $beta, then $alpha twice: $alpha, $plugin:deploy and $review: ignore $missing.",
        undefined,
        ctx,
      );

      // The typed text stays as typed, so later input handlers and Pi see it unchanged.
      expect(result).toStrictEqual({ action: "continue" });
      expect(section).toBe(
        [block("alpha"), block("beta"), block("plugin:deploy"), block("review")].join("\n\n"),
      );
      expect(host.getSentMessages()).toStrictEqual([]);
      expect(host.getNotifications()).toStrictEqual([
        { message: "Loaded skills: $alpha, $beta, $plugin:deploy, $review", type: "info" },
      ]);

      // Quotes in a skill path stay escaped inside the attribute, so Pi's parser still reads the block.
      const parsed = parseSkillBlock(section ?? "");
      expect(parsed?.name).toBe("alpha");
      expect(parsed?.location).toContain("&quot;&amp;&lt;");
      expect(parsed?.content).toContain("Alpha instructions.");
    },
  );

  it("loads only what was typed, never what Pi expanded", async () => {
    const { block, submit } = await writeSkills([
      ["alpha", "Alpha instructions; see $beta."],
      ["beta", "Beta instructions."],
    ]);

    const expanded = (args: string) => `${block("alpha")}\n\n${args}`;

    // Pi expands the leading command itself; the file's own `$beta` and a repeat of `$alpha` load nothing.
    expect(
      (await submit("/skill:alpha use $alpha", expanded("use $alpha"))).section,
    ).toBeUndefined();
    expect((await submit("/skill:alpha use $beta", expanded("use $beta"))).section).toBe(
      block("beta"),
    );
  });

  it("forgets a submission once its turn starts", async () => {
    const { start, submit } = await writeSkills([["alpha", "Alpha instructions."]]);

    expect((await submit("Use $alpha")).section).toBeDefined();
    // A turn no input started, such as one another extension triggers, loads nothing stale.
    expect(await start("Use $alpha")).toBeUndefined();
  });

  it.each(["steer", "followUp"] as const)(
    "warns about mentions in %s input without rewriting it, yet loads them if a turn starts",
    async (streamingBehavior) => {
      const { block, host, start } = await writeSkills([
        ["alpha", "Alpha instructions."],
        ["beta", "Beta instructions."],
      ]);

      const result = await host.emitInput({
        source: "interactive",
        streamingBehavior,
        text: "Use $beta, $alpha and $missing now",
        type: "input",
      });

      expect(result).toStrictEqual({ action: "continue" });
      expect(host.getSentMessages()).toStrictEqual([]);
      expect(host.getNotifications()).toStrictEqual([
        {
          message:
            "Queued message: $beta, $alpha not loaded. Queue /skill:<name> instead, or send once Pi is idle.",
          type: "warning",
        },
      ]);
      // A run that ends while input handlers await makes Pi start a turn for it after all.
      expect(await start("Use $beta, $alpha and $missing now")).toBe(
        [block("alpha"), block("beta")].join("\n\n"),
      );
    },
  );

  it.each([false, true])("completes loaded skill names, foreign editor=%s", async (foreign) => {
    const host = createSkillHost();
    const ctx = host.createContext();

    if (foreign)
      ctx.ui.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
    await host.emitSessionStart(ctx);

    const provider = host.getAutocompleteProvider(
      new CombinedAutocompleteProvider([], process.cwd()),
    );

    const [suggestions, namespacedSuggestions, unknownSuggestions] = await Promise.all([
      provider.getSuggestions(["Use $alp"], 0, 8, {
        signal: new AbortController().signal,
      }),
      provider.getSuggestions(["Use $plugin:d"], 0, 13, {
        signal: new AbortController().signal,
      }),
      provider.getSuggestions(["Use $zzz"], 0, 8, {
        signal: new AbortController().signal,
      }),
    ]);

    expect(suggestions).toStrictEqual({
      items: [
        {
          description: "Alpha instructions",
          label: "$alpha",
          value: "$alpha",
        },
      ],
      prefix: "$alp",
    });
    expect(namespacedSuggestions).toStrictEqual({
      items: [
        {
          description: "Plugin deploy instructions",
          label: "$plugin:deploy",
          value: "$plugin:deploy",
        },
      ],
      prefix: "$plugin:d",
    });
    expect(unknownSuggestions).toBeNull();
  });
});
