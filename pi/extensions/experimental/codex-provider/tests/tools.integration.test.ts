import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { createAssistantMessageEventStream, fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  createSyntheticSourceInfo,
  initTheme,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import toolPickerExtension from "../../../tool-picker/index.js";
import { createCustomUiDriver } from "../../../../tests/harness/tui.js";
import codexProviderExtension from "../index.js";
import { createRealCodexSession } from "./agent-session.js";
import { createToolsModel, mockUiContext, wireArray, wireRecord, wireString } from "./fixtures.js";
import type { WireRecord } from "./fixtures.js";

const DIRECT_NAMES = ["exec_command", "write_stdin", "apply_patch", "view_image"];

const CODE_NAMES = ["exec", "wait"];

describe("Codex tools with a real AgentSession", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refreshes tools and skill guidance on the next request while the selected model stays stale", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-tools-refresh-"));
    const cwd = path.join(rootDir, "project");
    await mkdir(cwd, { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(rootDir, "agent-config"));
    let mode: string | undefined;
    const requests: WireRecord[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);

      if (new URL(url).pathname.endsWith("/models")) {
        return Response.json({
          models: [
            {
              slug: "gpt-5.6-sol",
              display_name: "Sol",
              priority: 1,
              visibility: "list",
              supported_in_api: true,
              support_verbosity: true,
              supports_parallel_tool_calls: true,
              tool_mode: mode,
              use_responses_lite: false,
            },
          ],
        });
      }

      const body = init?.body;

      const bytes =
        body instanceof Uint8Array && new Headers(init?.headers).get("content-encoding") === "zstd"
          ? zstdDecompressSync(body)
          : body;

      requests.push(
        wireRecord(
          JSON.parse(
            bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : wireString(bytes),
          ),
        ),
      );
      const id = `resp_${requests.length}`;

      return new Response(
        [
          { type: "response.created", response: { id, status: "in_progress" } },
          {
            type: "response.completed",
            response: {
              id,
              status: "completed",
              output: [],
              usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 },
            },
          },
        ]
          .map((event) => `data: ${JSON.stringify(event)}\n\n`)
          .join(""),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });

    const session = await createRealCodexSession({
      extensionFactories: [toolPickerExtension, codexProviderExtension],
      model: createToolsModel("gpt-5.6-sol", true),
      rootDir,
      sessionManager: SessionManager.inMemory(cwd),
      skills: [
        {
          name: "example",
          description: "Example skill",
          baseDir: cwd,
          filePath: path.join(cwd, "SKILL.md"),
          disableModelInvocation: false,
          sourceInfo: createSyntheticSourceInfo("<test>", { source: "test" }),
        },
      ],
    });

    try {
      const selected = session.model;
      expect(session.getActiveToolNames()).toStrictEqual(DIRECT_NAMES);

      for (const [policy, names, loader] of [
        ["code_mode_only", CODE_NAMES, "exec"],
        ["direct", DIRECT_NAMES, "exec_command"],
        ["code_mode", [...DIRECT_NAMES, ...CODE_NAMES], "exec_command"],
        [undefined, DIRECT_NAMES, "exec_command"],
      ] as const) {
        mode = policy;

        const refreshed = await session.modelRuntime.refresh({
          allowNetwork: true,
          force: true,
          providers: ["openai-codex"],
        });

        expect([...refreshed.errors]).toStrictEqual([]);
        expect(session.model).toBe(selected);
        await session.prompt("Reply briefly without tools.");
        expect(session.messages.at(-1)).toMatchObject({
          role: "assistant",
          stopReason: "stop",
        });
        expect(session.getActiveToolNames()).toStrictEqual(names);
        expect(
          wireArray(requests.at(-1)?.tools).map((tool) => wireRecord(tool).name),
        ).toStrictEqual(names);
        const request = JSON.stringify(requests.at(-1));
        expect(request.match(/Use the `[^`]+` tool to load a skill's file/g)).toStrictEqual([
          `Use the \`${loader}\` tool to load a skill's file`,
        ]);
        expect(request.match(/<available_skills>/g)).toHaveLength(1);
        expect(request).toContain("<name>example</name>");
      }
    } finally {
      session.dispose();
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it("normalizes startup and toggles Code Mode", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-tools-"));
    const cwd = path.join(rootDir, "project");
    await mkdir(cwd, { recursive: true });
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(rootDir, "agent-config"));

    const session = await createRealCodexSession({
      extensionFactories: [codexProviderExtension],
      model: createToolsModel("gpt-5.6-sol", true),
      rootDir,
      sessionManager: SessionManager.inMemory(cwd),
    });

    try {
      expect(session.getActiveToolNames()).toStrictEqual(DIRECT_NAMES);

      await session.prompt("/code-mode");
      expect(session.getActiveToolNames()).toStrictEqual(CODE_NAMES);
    } finally {
      session.dispose();
      await rm(rootDir, { force: true, recursive: true });
    }
  });

  it.each([
    ["Direct Mode", "exec_command"],
    ["Code Mode", "exec"],
    ["enabled Pi read", "read"],
  ])(
    "keeps skill visibility and tool metadata consistent after toggling %s tools",
    async (mode, toolName) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-tools-"));
      const cwd = path.join(rootDir, "project");
      await mkdir(cwd, { recursive: true });
      vi.stubEnv("PI_CODING_AGENT_DIR", path.join(rootDir, "agent-config"));
      initTheme("dark");
      const notify = vi.fn<ExtensionUIContext["notify"]>();
      const onExtensionError = vi.fn();
      const captureTools = vi.fn<(tools: string[] | undefined) => void>();
      // SAFETY: These extensions use only custom, notify, and setStatus from the UI context.
      const uiContext = await mockUiContext({ notify, setStatus: () => {} });

      const session = await createRealCodexSession({
        extensionFactories: [
          toolPickerExtension,
          (pi) =>
            pi.on("before_agent_start", (event) => ({
              systemPrompt: `${event.systemPrompt}\nEarlier extension guidance.`,
            })),
          codexProviderExtension,
          (pi) =>
            pi.on("before_agent_start", (event) =>
              captureTools(event.systemPromptOptions.selectedTools),
            ),
        ],
        model: createToolsModel("gpt-5.6-sol", true),
        mode: "tui",
        onExtensionError,
        rootDir,
        sessionManager: SessionManager.inMemory(cwd),
        uiContext,
        skills: [
          {
            name: "example",
            description: "A loaded skill",
            baseDir: "/virtual/example",
            filePath: "/virtual/example/SKILL.md",
            disableModelInvocation: false,
            sourceInfo: createSyntheticSourceInfo("<test-skill>", { source: "test" }),
          },
        ],
      });

      const stream = vi.fn<typeof session.agent.streamFunction>((model) => {
        const result = createAssistantMessageEventStream();
        result.push({
          type: "done",
          reason: "stop",
          message: {
            ...fauxAssistantMessage("ok"),
            api: model.api,
            model: model.id,
            provider: model.provider,
          },
        });

        return result;
      });

      session.agent.streamFunction = stream;

      try {
        if (mode === "Code Mode") await session.prompt("/code-mode");
        const index = session.getAllTools().findIndex(({ name }) => name === toolName);
        expect(index).toBeGreaterThanOrEqual(0);

        const ui = createCustomUiDriver({
          keys: [...Array<string>(index).fill("\u001B[B"), " ", "\u001B"],
        });

        uiContext.custom = ui.custom;
        await session.prompt("/tools");
        expect(session.getActiveToolNames().includes(toolName)).toBe(toolName === "read");

        await session.prompt("Use the loaded skill");

        const expected = mode === "Code Mode" ? CODE_NAMES : DIRECT_NAMES;
        expect(captureTools).toHaveBeenLastCalledWith(expected);
        const context = stream.mock.calls.at(-1)?.[1];
        expect(context?.tools?.map(({ name }) => name)).toStrictEqual(expected);
        expect(context?.systemPrompt).toContain("<available_skills>");
        expect(context?.systemPrompt).toContain("<name>example</name>");
        expect(context?.systemPrompt).toContain("Earlier extension guidance.");
        expect(context?.systemPrompt).toContain(
          `Use the \`${mode === "Code Mode" ? "exec" : "exec_command"}\` tool to load a skill`,
        );
        expect(onExtensionError).not.toHaveBeenCalled();
      } finally {
        session.dispose();
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it.each([
    ["standalone", [codexProviderExtension]],
    ["with tool-picker", [toolPickerExtension, codexProviderExtension]],
    ["with tool-picker last", [codexProviderExtension, toolPickerExtension]],
  ] as const)(
    "restores Pi tools after reload and model switch when %s",
    async (_configuration, extensionFactories) => {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-tools-"));
      const cwd = path.join(rootDir, "project");
      await mkdir(cwd, { recursive: true });
      vi.stubEnv("PI_CODING_AGENT_DIR", path.join(rootDir, "agent-config"));

      const session = await createRealCodexSession({
        extensionFactories: [...extensionFactories],
        model: createToolsModel("gpt-5.6-sol", true),
        rootDir,
        sessionManager: SessionManager.inMemory(cwd),
      });

      try {
        expect(session.getActiveToolNames()).toStrictEqual(DIRECT_NAMES);

        await session.reload();
        await session.setModel(createToolsModel("deepseek-v4-pro"));

        expect(session.getActiveToolNames()).toStrictEqual(["read", "bash", "edit", "write"]);
      } finally {
        session.dispose();
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );
});
