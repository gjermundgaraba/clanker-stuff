import { readFile } from "node:fs/promises";

import { createEventBus, loadSkills } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vite-plus/test";

import { discoverOrchestrateSkill, ORCHESTRATE_SKILL_PATH } from "../orchestrate.js";

const SESSION_ID = "orchestrate-test";
const CONTRACT_REQUEST = "clanker-stuff:subagents:contract:request";
const CollaborationContractSchema = Type.Object({
  nestedTools: Type.Array(Type.Unknown()),
  protocol: Type.Union([Type.Literal("off"), Type.Literal("v1"), Type.Literal("v2")]),
  sessionId: Type.String(),
  version: Type.Literal(1),
});
const ContractRequestSchema = Type.Object({
  provide: Type.Function([CollaborationContractSchema], Type.Void()),
  sessionId: Type.String(),
});

const harness = (provider: string, protocol?: "off" | "v1" | "v2", sessionId = SESSION_ID) => {
  const events = createEventBus();
  events.on(CONTRACT_REQUEST, (payload) => {
    if (protocol !== undefined) {
      const request = Value.Parse(ContractRequestSchema, payload);
      request.provide({
        nestedTools: [],
        protocol,
        sessionId,
        version: 1,
      });
    }
  });
  const ctx = {
    model: { provider },
    sessionManager: { getSessionId: () => SESSION_ID },
  };
  const pi = { events };
  return { ctx, pi };
};

describe("orchestrate skill", () => {
  it("discovers for OpenAI Codex V1 and V2 sessions", () => {
    for (const protocol of ["v1", "v2"] as const) {
      const active = harness("openai-codex", protocol);
      expect(discoverOrchestrateSkill(active.pi, active.ctx)).toStrictEqual({
        skillPaths: [ORCHESTRATE_SKILL_PATH],
      });
    }

    for (const inactive of [
      harness("openai-codex", "off"),
      harness("openai-codex"),
      harness("openai-codex", "v2", "another-session"),
      harness("anthropic", "v2"),
    ]) {
      expect(discoverOrchestrateSkill(inactive.pi, inactive.ctx)).toBeUndefined();
    }
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
