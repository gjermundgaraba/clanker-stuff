import { readFile } from "node:fs/promises";

import { fauxProvider } from "@earendil-works/pi-ai";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";

import { createExtensionHost } from "../../../../tests/harness/extension-host.js";
import { DEFAULT_CONFIG } from "../config.js";
import { SubagentManager } from "../manager.js";
import { ORCHESTRATE_SKILL_PATH } from "../orchestrate.js";

type Version = "disabled" | "v1" | "v2";

const DISCOVER = {
  cwd: process.cwd(),
  reason: "startup",
  type: "resources_discover",
} as const;

const model = (provider: string, version: Version) =>
  Object.assign(fauxProvider({ models: [{ id: version }], provider }).getModel(), {
    multiAgentVersion: version,
  });

const startHost = async (provider: string, version: Version, start = true) => {
  const selected = model(provider, version);
  const host = createExtensionHost(
    (pi: ExtensionAPI) => {
      const manager = new SubagentManager(pi, {
        config: structuredClone(DEFAULT_CONFIG),
        dataDir: "/tmp/subagents-orchestrate-test",
      });
      pi.on("session_start", manager.start.bind(manager));
      pi.on("resources_discover", (_event, ctx) => manager.discoverResources(ctx));
    },
    { model: selected },
  );
  await host.ready;
  const ctx = host.createContext({ model: selected });
  if (start) {
    await host.emitSessionStart(ctx);
  }
  return { ctx, host };
};

describe("orchestrate skill", () => {
  it("discovers for OpenAI Codex V1 and V2 sessions", async () => {
    for (const version of ["v1", "v2"] as const) {
      const { ctx, host } = await startHost("openai-codex", version);
      await expect(host.emit("resources_discover", DISCOVER, ctx)).resolves.toStrictEqual([
        { skillPaths: [ORCHESTRATE_SKILL_PATH] },
      ]);
    }
  });

  it("stays hidden without Codex, without collaboration, or outside the started session", async () => {
    const otherProvider = await startHost("anthropic", "v2");
    const disabled = await startHost("openai-codex", "disabled");
    const notStarted = await startHost("openai-codex", "v2", false);
    const started = await startHost("openai-codex", "v2");
    const foreignSession = started.host.createContext({
      model: started.ctx.model,
      sessionManager: {
        ...started.ctx.sessionManager,
        getSessionId: () => "another-session",
      },
    });

    for (const { ctx, host } of [otherProvider, disabled, notStarted]) {
      await expect(host.emit("resources_discover", DISCOVER, ctx)).resolves.toStrictEqual([
        undefined,
      ]);
    }
    await expect(
      started.host.emit("resources_discover", DISCOVER, foreignSession),
    ).resolves.toStrictEqual([undefined]);
  });

  it("loads valid metadata and capability-safe V1/V2 guidance", async () => {
    const loaded = loadSkills({
      agentDir: import.meta.dirname,
      cwd: import.meta.dirname,
      includeDefaults: false,
      skillPaths: [ORCHESTRATE_SKILL_PATH],
    });

    expect(loaded.diagnostics).toStrictEqual([]);
    expect(loaded.skills).toMatchObject([
      {
        description:
          "Coordinate multiple agents on large-scope tasks. Use whenever the work is substantial; trivial tasks do not require this skill.",
        filePath: ORCHESTRATE_SKILL_PATH,
        name: "orchestrate",
      },
    ]);

    const contents = await readFile(ORCHESTRATE_SKILL_PATH, "utf-8");
    expect({
      conditionalOverride: contents.includes("When `spawn_agent` exposes `reasoning_effort`"),
      omissionFallback: contents.includes("otherwise omit that field"),
      v1Fork: contents.includes(
        "when it exposes `fork_context`, omit `fork_context` or set it to `false`",
      ),
      v2Fork: contents.includes('use `fork_turns: "none"` when `spawn_agent` exposes `fork_turns`'),
    }).toStrictEqual({
      conditionalOverride: true,
      omissionFallback: true,
      v1Fork: true,
      v2Fork: true,
    });
    await expect(
      readFile(new URL("../vendor/orchestrate/LICENSE", import.meta.url), "utf-8"),
    ).resolves.toContain("Copyright (c) 2026 Eric Provencher");
    await expect(
      readFile(new URL("../vendor/orchestrate/UPSTREAM", import.meta.url), "utf-8"),
    ).resolves.toContain("1fe93e920cbd99173eedd22e94d10d49e2c76da7");
  });
});
