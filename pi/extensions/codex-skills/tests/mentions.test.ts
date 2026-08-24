import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSyntheticSourceInfo, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { createExtensionHost } from "../../../tests/harness/extension-host.js";
import type { ExtensionHostOptions } from "../../../tests/harness/extension-host.js";
import { createIdentityTheme, renderComponent } from "../../../tests/harness/tui.js";
import { createSkillMentions } from "../mentions.js";

const SOURCE_INFO = createSyntheticSourceInfo("<test>", {
  origin: "top-level",
  scope: "project",
  source: "test",
});
const renderOptions = (expanded: boolean) => ({
  expanded,
  outputPad: 0,
});
const InjectedSkillResultSchema = Type.Object({
  message: Type.Object({ content: Type.String() }),
});

const createMentionHost = (commands: ExtensionHostOptions["commands"] = []) =>
  createExtensionHost(
    (pi: ExtensionAPI) => {
      const mentions = createSkillMentions(pi);
      pi.registerMessageRenderer("codex-skills", mentions.render);
      pi.on("session_start", (_event, ctx) => mentions.install(ctx));
      pi.on("before_agent_start", (event, ctx) => mentions.inject(event, ctx));
      pi.on("input", (event, ctx) => mentions.injectStreaming(event, ctx));
    },
    { commands },
  );

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
    {
      description: "Must remain a shell variable",
      name: "skill:PATH",
      source: "skill",
      sourceInfo: SOURCE_INFO,
    },
  ]);

describe("skill mentions", () => {
  it("injects complete skill files once in catalog order", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-skills-"));
    onTestFinished(() => rm(directory, { force: true, recursive: true }));
    const alphaPath = path.join(directory, "alpha.md");
    const betaPath = path.join(directory, "beta.md");
    const pluginPath = path.join(directory, "plugin-deploy.md");
    const shellPath = path.join(directory, "PATH.md");
    const alpha = "---\nname: alpha\n---\nAlpha instructions.\n";
    const beta = "---\nname: beta\n---\nBeta instructions.\n";
    const plugin = "---\nname: plugin:deploy\n---\nPlugin deploy instructions.\n";
    const shell = "---\nname: PATH\n---\nMust remain a shell variable.\n";
    await Promise.all([
      writeFile(alphaPath, alpha),
      writeFile(betaPath, beta),
      writeFile(pluginPath, plugin),
      writeFile(shellPath, shell),
    ]);

    const host = createMentionHost();
    const content = `<skill name="alpha" location="${alphaPath}">\nReferences are relative to ${directory}.\n\nAlpha instructions.\n</skill>\n\n<skill name="beta" location="${betaPath}">\nReferences are relative to ${directory}.\n\nBeta instructions.\n</skill>\n\n<skill name="plugin:deploy" location="${pluginPath}">\nReferences are relative to ${directory}.\n\nPlugin deploy instructions.\n</skill>`;
    const details = {
      skills: [
        { body: "Alpha instructions.", name: "alpha", path: alphaPath },
        { body: "Beta instructions.", name: "beta", path: betaPath },
        {
          body: "Plugin deploy instructions.",
          name: "plugin:deploy",
          path: pluginPath,
        },
      ],
    };
    const [result] = await host.emit(
      "before_agent_start",
      {
        prompt: "Use $beta, then $alpha twice: $alpha, and $plugin:deploy. Ignore $PATH.",
        systemPrompt: "",
        systemPromptOptions: {
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
            {
              baseDir: directory,
              description: "shell variable",
              disableModelInvocation: false,
              filePath: shellPath,
              name: "PATH",
              sourceInfo: SOURCE_INFO,
            },
          ],
        },
        type: "before_agent_start",
      } satisfies BeforeAgentStartEvent,
      host.createContext(),
    );

    expect(result).toStrictEqual({
      message: {
        content,
        customType: "codex-skills",
        details,
        display: true,
      },
    });

    const renderer = host.getMessageRenderer("codex-skills");
    if (!renderer) {
      throw new Error("Expected a skill message renderer");
    }
    const message = {
      content,
      customType: "codex-skills",
      details,
      display: true,
      role: "custom" as const,
      timestamp: 0,
    };
    expect(
      renderComponent(renderer(message, renderOptions(false), createIdentityTheme())),
    ).toContain("◆ Skills injected: $alpha, $beta, $plugin:deploy");
    const expanded = renderComponent(
      renderer(message, renderOptions(true), createIdentityTheme()),
      200,
    );
    expect(expanded).toContain(alphaPath);
    expect(expanded).toContain("Alpha instructions.");
    expect(expanded).toContain("Plugin deploy instructions.");
  });

  it("completes loaded skill names after a dollar sign", async () => {
    const host = createSkillHost();
    await host.emitSessionStart();
    const provider = host.getAutocompleteProvider(
      new CombinedAutocompleteProvider([], process.cwd()),
    );
    const [suggestions, namespacedSuggestions, shellSuggestions] = await Promise.all([
      provider.getSuggestions(["Use $alp"], 0, 8, {
        signal: new AbortController().signal,
      }),
      provider.getSuggestions(["Use $plugin:d"], 0, 13, {
        signal: new AbortController().signal,
      }),
      provider.getSuggestions(["Use $PATH"], 0, 9, {
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
    expect(shellSuggestions).toBeNull();
  });

  it("injects skills into queued steering and follow-up input", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-skills-"));
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
        systemPromptOptions: { cwd: directory, skills: [skill] },
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
      expect(result).toMatchObject({
        action: "transform",
        text: expect.stringContaining(
          `References are relative to ${directory}.\n\nAlpha instructions.`,
        ),
      });
      expect(result).toMatchObject({
        text: expect.stringMatching(/<\/skill>\n\nUse \$alpha now$/u),
      });
    }
  });

  it("keeps quoted skill paths inside the skill block", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-skills-"quoted"-'));
    onTestFinished(() => rm(directory, { force: true, recursive: true }));
    const filePath = path.join(directory, 'alpha"&<.md');
    await writeFile(filePath, "Alpha instructions.\n");
    const host = createMentionHost();
    const [result] = await host.emit(
      "before_agent_start",
      {
        prompt: "Use $alpha",
        systemPrompt: "",
        systemPromptOptions: {
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
        },
        type: "before_agent_start",
      } satisfies BeforeAgentStartEvent,
      host.createContext(),
    );
    const content = Value.Parse(InjectedSkillResultSchema, result).message.content;

    expect(parseSkillBlock(content)).toMatchObject({
      content: expect.stringContaining("Alpha instructions."),
      userMessage: undefined,
    });
    expect(content).toContain("&quot;");
  });
});
