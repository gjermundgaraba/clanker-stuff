import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import toolsExtension from "../../../tools/index.js";
import codexProviderExtension from "../index.js";
import { createRealCodexSession } from "./agent-session.js";
import { createToolsModel } from "./fixtures.js";

const DIRECT_NAMES = ["exec_command", "write_stdin", "apply_patch", "view_image"];
const CODE_NAMES = ["exec", "wait"];

describe("Codex tools with a real AgentSession", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["tools first", [toolsExtension, codexProviderExtension]],
    ["provider first", [codexProviderExtension, toolsExtension]],
  ] as const)(
    "normalizes startup and toggles Code Mode with both extensions loaded (%s)",
    async (_order, extensionFactories) => {
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

        await session.prompt("/code-mode");
        expect(session.getActiveToolNames()).toStrictEqual(CODE_NAMES);
      } finally {
        session.dispose();
        await rm(rootDir, { force: true, recursive: true });
      }
    },
  );

  it.each([
    ["standalone", [codexProviderExtension]],
    ["with the tools extension", [toolsExtension, codexProviderExtension]],
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
