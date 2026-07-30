import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";
import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished } from "vitest";

import { createExtensionHost } from "../../tests/harness/extension-host.js";
import {
  createIdentityTheme,
  renderComponent,
} from "../../tests/harness/tui.js";
import extension from "../index.js";

const SOURCE_INFO = createSyntheticSourceInfo("<test>", {
  origin: "top-level",
  scope: "project",
  source: "test",
});
const renderOptions = (expanded: boolean) => ({
  expanded,
  outputPad: 0,
});

const createSkillHost = () =>
  createExtensionHost(extension, {
    commands: [
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
    ],
  });

describe("codex skill mentions", () => {
  it("injects complete skill files once in catalog order", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "codex-skills-"));
    onTestFinished(() => rm(directory, { force: true, recursive: true }));
    const alphaPath = path.join(directory, "alpha.md");
    const betaPath = path.join(directory, "beta.md");
    const pluginPath = path.join(directory, "plugin-deploy.md");
    const shellPath = path.join(directory, "PATH.md");
    const alpha = "---\nname: alpha\n---\nAlpha instructions.\n";
    const beta = "---\nname: beta\n---\nBeta instructions.\n";
    const plugin =
      "---\nname: plugin:deploy\n---\nPlugin deploy instructions.\n";
    const shell = "---\nname: PATH\n---\nMust remain a shell variable.\n";
    await Promise.all([
      writeFile(alphaPath, alpha),
      writeFile(betaPath, beta),
      writeFile(pluginPath, plugin),
      writeFile(shellPath, shell),
    ]);

    const host = createExtensionHost(extension);
    const content = `<skill>\n<name>alpha</name>\n<path>${alphaPath}</path>\n${alpha}\n</skill>\n\n<skill>\n<name>beta</name>\n<path>${betaPath}</path>\n${beta}\n</skill>\n\n<skill>\n<name>plugin:deploy</name>\n<path>${pluginPath}</path>\n${plugin}\n</skill>`;
    const details = {
      skills: [
        { name: "alpha", path: alphaPath },
        { name: "beta", path: betaPath },
        { name: "plugin:deploy", path: pluginPath },
      ],
    };
    const [result] = await host.emit(
      "before_agent_start",
      {
        prompt:
          "Use $beta, then $alpha twice: $alpha, and $plugin:deploy. Ignore $PATH.",
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
      host.createContext()
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
      renderComponent(
        renderer(message, renderOptions(false), createIdentityTheme())
      )
    ).toContain("◆ Skills injected: $alpha, $beta, $plugin:deploy");
    expect(
      renderComponent(
        renderer(message, renderOptions(true), createIdentityTheme()),
        200
      )
    ).toContain(alphaPath);
  });

  it("completes loaded skill names after a dollar sign", async () => {
    const host = createSkillHost();
    await host.emitSessionStart();
    const provider = host.getAutocompleteProvider(
      new CombinedAutocompleteProvider([], process.cwd())
    );
    const [suggestions, namespacedSuggestions, shellSuggestions] =
      await Promise.all([
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

  it("decorates exact loaded skill mentions", async () => {
    const host = createSkillHost();
    const decorations: {
      color: string;
      id: string;
      pattern: RegExp;
    }[] = [];
    host.events.on("decorated-editor:register", (data) => {
      decorations.push(data as { color: string; id: string; pattern: RegExp });
    });
    await host.emitSessionStart();

    expect(decorations).toHaveLength(1);
    expect(decorations[0]).toMatchObject({
      color: "accent",
      id: "codex-skills",
      pattern: expect.any(RegExp),
    });
    const [decoration] = decorations;
    expect([
      "Use $alpha".match(decoration.pattern),
      "Use $plugin:deploy".match(decoration.pattern),
      "Use $alphabet".match(decoration.pattern),
      "Use $PATH".match(decoration.pattern),
    ]).toStrictEqual([["$alpha"], ["$plugin:deploy"], null, null]);
  });
});
