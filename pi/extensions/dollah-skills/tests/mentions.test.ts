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

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import type { ExtensionHostOptions } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

const sourceInfo = (filePath: string) =>
  createSyntheticSourceInfo(filePath, {
    origin: "top-level",
    scope: "project",
    source: "test",
  });

const createMentionHost = (commands: ExtensionHostOptions["commands"] = []) =>
  createExtensionHost(extension, { commands });

const createSkillHost = () =>
  createMentionHost(
    (
      [
        ["alpha", "Alpha instructions"],
        ["beta", "Beta instructions"],
        ["plugin:deploy", "Plugin deploy instructions"],
      ] as const
    ).map(([name, description]) => ({
      name: `skill:${name}`,
      description,
      source: "skill" as const,
      sourceInfo: sourceInfo("<test>"),
    })),
  );

const writeSkills = async (entries: readonly (readonly [name: string, body: string])[]) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dollah-skills-"));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));

  const skills = await Promise.all(
    entries.map(async ([name, body]) => {
      const filePath = path.join(directory, `${name.replace(":", "-")}"&<.md`);
      await writeFile(filePath, `---\nname: ${name}\n---\n${body}\n`);

      return {
        name,
        filePath,
        block: `<skill name="${name}" location="${filePath.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}">\nReferences are relative to ${directory}.\n\n${body}\n</skill>`,
      };
    }),
  );

  const blocks = new Map(skills.map(({ name, block }) => [name, block]));

  const host = createMentionHost(
    skills.map(({ name, filePath }) => ({
      name: `skill:${name}`,
      description: `${name} skill`,
      source: "skill" as const,
      sourceInfo: sourceInfo(filePath),
    })),
  );

  return { host, block: (name: string) => blocks.get(name) ?? "", skills };
};

describe("skill mentions", () => {
  it.each([false, true])(
    "expands each input once in catalog order, foreign editor=%s",
    async (foreign) => {
      const { block, host } = await writeSkills([
        ["alpha", "Alpha instructions."],
        ["beta", "Beta instructions."],
        ["plugin:deploy", "Deploy instructions."],
        ["review", "Review instructions."],
      ]);

      const ctx = host.createContext();

      if (foreign)
        ctx.ui.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
      await host.emitSessionStart(ctx);

      const text =
        "Use $beta, then $alpha twice: $alpha, $plugin:deploy and $review: ignore $missing.";

      const result = await host.emitInput({ source: "interactive", text, type: "input" }, ctx);

      expect(result).toStrictEqual({
        action: "transform",
        text: `${text}\n\n${[block("alpha"), block("beta"), block("plugin:deploy"), block("review")].join("\n\n")}`,
      });
      expect(host.getSentMessages()).toStrictEqual([]);
      expect(host.getNotifications()).toStrictEqual([
        { message: "Loaded skills: $alpha, $beta, $plugin:deploy, $review", type: "info" },
      ]);
      const parsed = parseSkillBlock(block("alpha"));

      expect(parsed?.name).toBe("alpha");
      expect(parsed?.location).toContain("&quot;&amp;&lt;");
      expect(parsed?.content).toContain("Alpha instructions.");
    },
  );

  it("loads no mentions found inside a skill body and leaves a leading native command intact", async () => {
    const { block, host } = await writeSkills([
      ["alpha", "Alpha instructions; see $beta."],
      ["beta", "Beta instructions."],
    ]);

    expect(
      await host.emitInput({ source: "interactive", text: "Use $alpha", type: "input" }),
    ).toStrictEqual({
      action: "transform",
      text: `Use $alpha\n\n${block("alpha")}`,
    });
    expect(
      await host.emitInput({
        source: "interactive",
        text: "/skill:alpha use $alpha",
        type: "input",
      }),
    ).toStrictEqual({ action: "continue" });
    expect(
      await host.emitInput({
        source: "interactive",
        text: "/skill:alpha use $beta",
        type: "input",
      }),
    ).toStrictEqual({
      action: "transform",
      text: `/skill:alpha use $beta\n\n${block("beta")}`,
    });
  });

  it.each(["steer", "followUp"] as const)(
    "expands %s input just like idle input",
    async (streamingBehavior) => {
      const { block, host } = await writeSkills([["alpha", "Alpha instructions."]]);
      expect(
        await host.emitInput({
          source: "interactive",
          streamingBehavior,
          text: "Use $alpha",
          type: "input",
        }),
      ).toStrictEqual({ action: "transform", text: `Use $alpha\n\n${block("alpha")}` });
      expect(host.getNotifications()).toStrictEqual([
        { message: "Loaded skills: $alpha", type: "info" },
      ]);
    },
  );

  it("reports an unreadable skill and still includes the other requested skills", async () => {
    const { block, host, skills } = await writeSkills([
      ["alpha", "Alpha instructions."],
      ["beta", "Beta instructions."],
    ]);

    // writeSkills preserves the two explicit fixture entries, with alpha first.
    await rm(skills[0]!.filePath);

    const result = await host.emitInput({
      source: "interactive",
      text: "Use $alpha and $beta",
      type: "input",
    });

    expect(result).toStrictEqual({
      action: "transform",
      text: `Use $alpha and $beta\n\n${block("beta")}`,
    });
    expect(host.getNotifications()[0]).toMatchObject({ type: "warning" });
    expect(host.getNotifications()[0]?.message).toContain("Failed to load skill alpha:");
    expect(host.getNotifications()[1]).toStrictEqual({
      type: "info",
      message: "Loaded skills: $beta",
    });
  });

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
