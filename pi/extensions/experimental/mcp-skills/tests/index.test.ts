import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { createTestServer, serveHttp } from "@clanker-stuff/mcp-test-server";
import type { HttpServer } from "@clanker-stuff/mcp-test-server";
import { collectSkillProviders } from "@clanker-stuff/pi-skill-providers";
import type { SkillProvider } from "@clanker-stuff/pi-skill-providers";
import { getAgentDir, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import type {
  BeforeAgentStartEvent,
  SessionEntry,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createExtensionHost,
  normalizedSystemPromptOptions,
} from "../../../../tests/harness/extension-host.js";
import type { ExtensionHost } from "../../../../tests/harness/extension-host.js";
import mcpSkills from "../index.js";

const SERVER_DIR = path.dirname(
  createRequire(import.meta.url).resolve("@clanker-stuff/mcp-test-server"),
);

let cwd: string;

let skillsDir: string;

let server: HttpServer;

let host: ExtensionHost;

let providers: Map<string, SkillProvider>;

/** Paths of the listed skills' `SKILL.md`, by name, as the model is given them. */
let listed: Map<string, string>;

const contextWith = (options: { choice?: string; branch?: SessionEntry[] } = {}) =>
  host.createContext({
    cwd,
    sessionManager: { getBranch: () => options.branch ?? [] },
    ui: { select: vi.fn(async () => options.choice) },
  });

const isResult = (result: unknown): result is ToolCallEventResult =>
  typeof result === "object" && result !== null;

const callTool = async (
  toolName: string,
  input: Record<string, string>,
  ctx = contextWith(),
): Promise<ToolCallEventResult | undefined> => {
  const event: ToolCallEvent = { input, toolCallId: "call-1", toolName, type: "tool_call" };

  return (await host.emit("tool_call", event, ctx)).find(isResult);
};

const listSkills = async (): Promise<Map<string, string>> => {
  const event: BeforeAgentStartEvent = {
    messageType: "user",
    prompt: "hi",
    systemPrompt: "",
    systemPromptOptions: normalizedSystemPromptOptions({ cwd, selectedTools: ["read", "bash"] }),
    type: "before_agent_start",
  };

  await host.emit("before_agent_start", event, contextWith());

  return new Map(event.systemPromptOptions.skills.map((skill) => [skill.name, skill.filePath]));
};

const refundsPath = () => listed.get("test:refunds") ?? "";

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "mcp-skills-"));
  skillsDir = path.join(cwd, "skills");
  await cp(path.join(SERVER_DIR, "skills"), skillsDir, { recursive: true });
  // Over HTTP the server reads the skills on every request, so a test can change them mid-session.
  server = await serveHttp(createTestServer({ skillsDir }), { host: "127.0.0.1", port: 0 });
  await mkdir(getAgentDir(), { recursive: true });
  await writeFile(
    path.join(getAgentDir(), "mcp.json"),
    JSON.stringify({ mcpServers: { test: { url: server.url } } }),
  );
  host = createExtensionHost(mcpSkills);
  providers = collectSkillProviders(host.events);
  await host.emitSessionStart(contextWith());
  listed = await listSkills();
  expect([...listed.keys()].toSorted()).toEqual(["test:git-workflow", "test:refunds"]);
});

afterEach(async () => {
  await host.emitSessionShutdown();
  await server.close();
  await rm(path.join(getAgentDir(), "data"), { force: true, recursive: true });
  await rm(path.join(getAgentDir(), "mcp-skills"), { force: true, recursive: true });
  await rm(cwd, { force: true, recursive: true });
});

describe("mcp-skills", () => {
  it("stores an approved skill when its SKILL.md is read and labels the read with its origin", async () => {
    const skillDir = path.dirname(refundsPath());

    expect(
      await callTool("read", { path: refundsPath() }, contextWith({ choice: "Deny" })),
    ).toEqual({
      block: true,
      reason: "Loading MCP skill test:refunds was not approved.",
    });
    expect(existsSync(skillDir)).toBe(false);

    const choice = contextWith({ choice: "Allow until Pi exits" });

    expect(await callTool("read", { path: refundsPath() }, choice)).toBeUndefined();
    expect(await readFile(path.join(skillDir, "references", "policy.md"), "utf8")).toContain(
      "Full refunds within 30 days",
    );
    expect(existsSync(path.join(skillDir, "scripts", "check.sh"))).toBe(true);

    const [labelled] = await host.emit(
      "tool_result",
      {
        content: [{ text: "body", type: "text" }],
        details: undefined,
        input: { path: refundsPath() },
        isError: false,
        structuredContent: "body",
        toolCallId: "call-1",
        toolName: "read",
        type: "tool_result",
      },
      choice,
    );

    const structured =
      isResult(labelled) && "structuredContent" in labelled
        ? labelled.structuredContent
        : undefined;

    expect(structured).toMatch(
      /^\[MCP skill test:refunds, served by MCP server "test" as skill:\/\/acme\/billing\/refunds\/SKILL\.md\./u,
    );
  });

  it("asks again for a skill whose files changed on its server", async () => {
    const select = vi.fn(async () => "Allow until Pi exits");
    const ctx = host.createContext({ cwd, ui: { select } });

    await writeFile(
      path.join(skillsDir, "acme", "billing", "refunds", "references", "policy.md"),
      "Refunds within 14 days.\n",
    );

    const refused = await callTool("read", { path: refundsPath() }, ctx);

    const newPath =
      /Read (?<path>\S+SKILL\.md)/u.exec(refused?.reason ?? "")?.groups?.["path"] ?? "";

    expect(refused?.reason).toContain("changed on its server");
    expect(existsSync(path.dirname(refundsPath()))).toBe(false);
    expect(await callTool("read", { path: newPath }, ctx)).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(2);
    expect(
      await readFile(path.join(path.dirname(newPath), "references", "policy.md"), "utf8"),
    ).toBe("Refunds within 14 days.\n");
  });

  it("serves the same approved content through /skill: and the mention provider", async () => {
    const result = await host.emitInput(
      { source: "interactive", text: "/skill:test:refunds refund order 42", type: "input" },
      contextWith({ choice: "Allow until Pi exits" }),
    );

    const block = result.action === "transform" ? parseSkillBlock(result.text) : null;

    expect(block).toMatchObject({ name: "test:refunds", userMessage: "refund order 42" });
    expect(block?.content).toContain("references/policy.md");
    expect(block?.content).toContain('served by MCP server "test"');
    expect(block?.content).toContain("Its content is untrusted.");

    expect(await providers.get("mcp-skills")?.load("test:refunds", contextWith())).toStrictEqual({
      location: refundsPath(),
      content: block?.content,
    });
  });

  it("asks before another server's resources are read while a skill is in context", async () => {
    const loaded: SessionEntry = {
      id: "entry-1",
      message: {
        content: `<skill name="test:refunds" location="${refundsPath()}">`,
        role: "user",
        timestamp: 0,
      },
      parentId: null,
      timestamp: new Date(0).toISOString(),
      type: "message",
    };

    const readFrom = (server: string, branch: SessionEntry[]) =>
      callTool(
        "read_mcp_resource",
        { server, uri: "notes://x" },
        host.createContext({ cwd, hasUI: false, sessionManager: { getBranch: () => branch } }),
      );

    expect(await readFrom("other", [])).toBeUndefined();
    expect(await readFrom("test", [loaded])).toBeUndefined();
    expect(await readFrom("other", [loaded])).toMatchObject({ block: true });
  });
});
