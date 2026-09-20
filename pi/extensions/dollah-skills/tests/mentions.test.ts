import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CustomEditor,
  createSyntheticSourceInfo,
  parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import {
  createExtensionHost,
  normalizedSystemPromptOptions,
} from "../../../tests/harness/extension-host.js";
import type { ExtensionHostOptions } from "../../../tests/harness/extension-host.js";
import extension from "../index.js";

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

describe("skill mentions", () => {
  it.each([false, true])(
    "loads complete skill files once in catalog order into the prompt section, foreign editor=%s",
    async (foreign) => {
      const directory = await mkdtemp(path.join(tmpdir(), "dollah-skills-"));
      onTestFinished(() => rm(directory, { force: true, recursive: true }));
      const alphaPath = path.join(directory, "alpha.md");
      const betaPath = path.join(directory, "beta.md");
      const pluginPath = path.join(directory, "plugin-deploy.md");
      const alpha = "---\nname: alpha\n---\nAlpha instructions.\n";
      const beta = "---\nname: beta\n---\nBeta instructions.\n";
      const plugin = "---\nname: plugin:deploy\n---\nPlugin deploy instructions.\n";
      await Promise.all([
        writeFile(alphaPath, alpha),
        writeFile(betaPath, beta),
        writeFile(pluginPath, plugin),
      ]);

      const host = createMentionHost();
      const ctx = host.createContext();

      if (foreign)
        ctx.ui.setEditorComponent((tui, theme, keys) => new CustomEditor(tui, theme, keys));
      await host.emitSessionStart(ctx);
      const section = `<skill name="alpha" location="${alphaPath}">\nReferences are relative to ${directory}.\n\nAlpha instructions.\n</skill>\n\n<skill name="beta" location="${betaPath}">\nReferences are relative to ${directory}.\n\nBeta instructions.\n</skill>\n\n<skill name="plugin:deploy" location="${pluginPath}">\nReferences are relative to ${directory}.\n\nPlugin deploy instructions.\n</skill>`;

      const systemPromptOptions = normalizedSystemPromptOptions({
        cwd: directory,
        skills: [
          {
            baseDir: directory,
            description: "alpha",
            disableModelInvocation: false,
            filePath: alphaPath,
            name: "alpha",
            sourceInfo: SOURCE_INFO,
          },
          {
            baseDir: directory,
            description: "beta",
            disableModelInvocation: false,
            filePath: betaPath,
            name: "beta",
            sourceInfo: SOURCE_INFO,
          },
          {
            baseDir: directory,
            description: "plugin deploy",
            disableModelInvocation: false,
            filePath: pluginPath,
            name: "plugin:deploy",
            sourceInfo: SOURCE_INFO,
          },
        ],
      });

      const [result] = await host.emit(
        "before_agent_start",
        {
          prompt: "Use $beta, then $alpha twice: $alpha, and $plugin:deploy. Ignore $missing.",
          systemPrompt: "",
          systemPromptOptions,
          type: "before_agent_start",
        } satisfies BeforeAgentStartEvent,
        ctx,
      );

      expect(result).toBeUndefined();
      expect(systemPromptOptions.sections).toStrictEqual({ loaded_skills: section });
      expect(host.getNotifications()).toStrictEqual([
        { message: "Loaded skills: $alpha, $beta, $plugin:deploy", type: "info" },
      ]);
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

  it("injects skills into queued steering and follow-up input", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "dollah-skills-"));
    onTestFinished(() => rm(directory, { force: true, recursive: true }));
    const filePath = path.join(directory, "alpha.md");
    await writeFile(filePath, "---\nname: alpha\n---\nAlpha instructions.\n");

    const skill = {
      baseDir: directory,
      description: "alpha",
      disableModelInvocation: false,
      filePath,
      name: "alpha",
      sourceInfo: SOURCE_INFO,
    };

    const host = createMentionHost();
    const ctx = host.createContext();
    await host.emit(
      "before_agent_start",
      {
        prompt: "initial prompt",
        systemPrompt: "",
        systemPromptOptions: normalizedSystemPromptOptions({ cwd: directory, skills: [skill] }),
        type: "before_agent_start",
      } satisfies BeforeAgentStartEvent,
      ctx,
    );

    const results = await Promise.all(
      (["steer", "followUp"] as const).map((streamingBehavior) =>
        host.emitInput(
          {
            source: "interactive",
            streamingBehavior,
            text: "Use $alpha now",
            type: "input",
          },
          ctx,
        ),
      ),
    );

    for (const result of results) {
      expect(result).toMatchObject({ action: "transform" });
      expect(result).toHaveProperty(
        "text",
        expect.stringContaining(`References are relative to ${directory}.\n\nAlpha instructions.`),
      );
      expect(result).toHaveProperty(
        "text",
        expect.stringMatching(/<\/skill>\n\nUse \$alpha now$/u),
      );
    }
  });

  it("keeps quoted skill paths inside the skill block", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'dollah-skills-"quoted"-'));
    onTestFinished(() => rm(directory, { force: true, recursive: true }));
    const filePath = path.join(directory, 'alpha"&<.md');
    await writeFile(filePath, "Alpha instructions.\n");
    const host = createMentionHost();

    const systemPromptOptions = normalizedSystemPromptOptions({
      cwd: directory,
      skills: [
        {
          baseDir: directory,
          description: "alpha",
          disableModelInvocation: false,
          filePath,
          name: "alpha",
          sourceInfo: SOURCE_INFO,
        },
      ],
    });

    await host.emit(
      "before_agent_start",
      {
        prompt: "Use $alpha",
        systemPrompt: "",
        systemPromptOptions,
        type: "before_agent_start",
      } satisfies BeforeAgentStartEvent,
      host.createContext(),
    );

    const content = systemPromptOptions.sections.loaded_skills ?? "";

    const parsed = parseSkillBlock(content);
    expect(parsed?.content).toContain("Alpha instructions.");
    expect(parsed?.userMessage).toBeUndefined();
    expect(content).toContain("&quot;");
  });
});
