import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SKILL_PROVIDER_CHANNEL, skillBlock } from "@clanker-stuff/pi-skill-providers";
import type { LoadedSkill, SkillProvider } from "@clanker-stuff/pi-skill-providers";
import { CustomEditor, createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

const command = (
  name: string,
  description: string,
  source: SlashCommandInfo["source"],
  filePath = "<test>",
): SlashCommandInfo => ({
  name,
  description,
  source,
  sourceInfo: createSyntheticSourceInfo(filePath, {
    origin: "top-level",
    scope: "project",
    source: "test",
  }),
});

const createSkillHost = () =>
  createExtensionHost(extension, {
    commands: [
      command("skill:alpha", "Alpha instructions", "skill"),
      command("skill:beta", "Beta instructions", "skill"),
      command("skill:plugin:deploy", "Plugin deploy instructions", "skill"),
    ],
  });

/** Skill files on disk, registered in catalog order, plus any other commands Pi would know. */
const writeSkills = async (
  entries: readonly (readonly [name: string, body: string])[],
  commands: readonly SlashCommandInfo[] = [],
) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dollah-skills-"));
  onTestFinished(() => rm(directory, { force: true, recursive: true }));

  const skills: LoadedSkill[] = await Promise.all(
    entries.map(async ([name, body]) => {
      const baseDir = path.join(directory, name.replace(":", "-"));
      const location = path.join(baseDir, "SKILL.md");
      await mkdir(baseDir);
      await writeFile(location, `---\nname: ${name}\n---\n${body}\n`);

      return { content: `References are relative to ${baseDir}.\n\n${body}`, location, name };
    }),
  );

  const host = createExtensionHost(extension, {
    commands: [
      ...skills.map((skill) =>
        command(`skill:${skill.name}`, `${skill.name} skill`, "skill", skill.location),
      ),
      ...commands,
    ],
  });

  const remove = async (name: string) => {
    const skill = skills.find((candidate) => candidate.name === name);

    if (!skill) throw new Error(`No fixture skill named ${name}`);
    await rm(skill.location);
  };

  return {
    host,
    loaded: (...names: string[]) => skills.filter((skill) => names.includes(skill.name)),
    remove,
  };
};

/** Loaded content from a provider, including its relative-path guidance. */
const provided = (name: string): LoadedSkill => ({
  content: `References are relative to mcp://${name}.\n\nProvided ${name}.`,
  location: `mcp://${name}`,
  name,
});

describe("skill mentions", () => {
  it.each([false, true])(
    "puts the mentioned skills first in catalog order and leaves text and images intact, foreign editor=%s",
    async (foreign) => {
      const { host, loaded } = await writeSkills([
        ["alpha", "Alpha instructions; see $beta."],
        ["beta", "Beta instructions."],
        ["plugin:deploy", "Deploy instructions."],
        ["review", "Review instructions."],
      ]);

      const ctx = host.createContext();

      if (foreign)
        ctx.ui.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
      await host.emitSessionStart(ctx);

      const text =
        "Use $review, then $alpha twice: $alpha, $plugin:deploy and $review: ignore $missing.";

      const image = { data: "aGk=", mimeType: "image/png", type: "image" as const };

      const result = await host.emitInput(
        { images: [image], source: "interactive", text, type: "input" },
        ctx,
      );

      // alpha's body mentions beta, but only typed text loads skills. Images pass through.
      expect(result).toStrictEqual({
        action: "transform",
        images: [image],
        text: `${skillBlock(loaded("alpha", "plugin:deploy", "review"))}\n\n${text}`,
      });
      expect(host.getSentMessages()).toStrictEqual([]);
      expect(host.getNotifications()).toStrictEqual([]);
    },
  );

  it("leaves input that invokes a command, template or skill to Pi, but not a leading path", async () => {
    const { host, loaded } = await writeSkills(
      [["alpha", "Alpha instructions."]],
      [command("review", "Review template", "prompt")],
    );

    for (const text of ["/skill:alpha use $alpha", "/review $alpha"]) {
      expect(await host.emitInput({ source: "interactive", text, type: "input" })).toStrictEqual({
        action: "continue",
      });
    }

    const text = "/tmp/app.ts crashes, $alpha";

    expect(await host.emitInput({ source: "interactive", text, type: "input" })).toStrictEqual({
      action: "transform",
      text: `${skillBlock(loaded("alpha"))}\n\n${text}`,
    });
  });

  it("reports an unreadable skill, keeps the others, and leaves input alone when none load", async () => {
    const { host, loaded, remove } = await writeSkills([
      ["alpha", "Alpha instructions."],
      ["beta", "Beta instructions."],
    ]);

    await remove("alpha");

    expect(
      await host.emitInput({ source: "interactive", text: "Use $alpha and $beta", type: "input" }),
    ).toStrictEqual({
      action: "transform",
      text: `${skillBlock(loaded("beta"))}\n\nUse $alpha and $beta`,
    });

    await remove("beta");

    expect(
      await host.emitInput({ source: "interactive", text: "Use $beta", type: "input" }),
    ).toStrictEqual({ action: "continue" });
    expect(host.getNotifications().map((notification) => notification.type)).toStrictEqual([
      "warning",
      "warning",
    ]);
    expect(host.getNotifications()[0]?.message).toContain("Failed to load skill alpha:");
  });

  it("loads skills other extensions provide one at a time, after local skills of the same name", async () => {
    const { host, loaded } = await writeSkills([["alpha", "Alpha instructions."]]);
    const loads: string[] = [];
    let loading = 0;

    const provider: SkillProvider = {
      id: "test",
      async load(name) {
        loading += 1;
        expect(loading).toBe(1);
        loads.push(name);
        await Promise.resolve();
        loading -= 1;

        if (name === "docs:broken") return { error: "not approved" };

        return provided(name);
      },
      skills: () => [
        { description: "Shadowed by the local skill", name: "alpha" },
        { description: "Refunds", name: "docs:refunds" },
        { description: "Broken", name: "docs:broken" },
        { description: "Billing refunds", name: "docs:refunds-1a2b3c4d" },
      ],
    };

    await host.emitSessionStart();
    host.events.emit(SKILL_PROVIDER_CHANNEL, provider);
    host.events.emit(SKILL_PROVIDER_CHANNEL, { id: "not-a-provider" });

    const text = "Use $alpha, $docs:refunds, $docs:broken and $docs:refunds-1a2b3c4d.";
    const result = await host.emitInput({ source: "interactive", text, type: "input" });

    expect(result).toStrictEqual({
      action: "transform",
      text: `${skillBlock([...loaded("alpha"), provided("docs:refunds"), provided("docs:refunds-1a2b3c4d")])}\n\n${text}`,
    });
    expect(loads).toStrictEqual(["docs:refunds", "docs:broken", "docs:refunds-1a2b3c4d"]);
    expect(host.getNotifications()).toStrictEqual([
      { message: "Failed to load skill docs:broken: not approved", type: "warning" },
    ]);

    const completion = await host
      .getAutocompleteProvider(new CombinedAutocompleteProvider([], process.cwd()))
      .getSuggestions(["Use $docs:ref"], 0, 13, { signal: new AbortController().signal });

    expect(completion?.items.map((item) => item.value)).toContain("$docs:refunds");
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
