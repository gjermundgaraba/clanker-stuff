import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createAgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import type { AgentSessionHarness } from "../../../../tests/harness/agent-session.js";
import type { Mail } from "../protocol.js";
import { createChildRuntime } from "../runtime.js";
import type { ChildRuntime, ChildRuntimeRequest } from "../runtime.js";

const usage = (totalTokens: number) => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: totalTokens,
  output: 0,
  totalTokens,
});

const runtimeRequest = (harness: AgentSessionHarness): ChildRuntimeRequest => ({
  bridge: () => Promise.resolve(),
  cwd: path.dirname(harness.agentDir),
  dataDir: path.join(harness.agentDir, "data", "subagents"),
  history: [],
  model: harness.faux.getModel(),
  modelRegistry: harness.session.extensionRunner.getModelRegistry(),
  onDelivered: () => {},
  onError: (cause) => {
    throw cause;
  },
  prompt: "You are a child.",
  promptOptions: undefined,
  sessionFile: undefined,
  thinkingLevel: undefined,
  tools: [],
  trusted: false,
});

const branchOf = (sessionFile: string, harness: AgentSessionHarness) =>
  SessionManager.open(
    sessionFile,
    path.dirname(sessionFile),
    path.dirname(harness.agentDir),
  ).getBranch();

const hasUserTask = (sessionFile: string, harness: AgentSessionHarness, text: string) =>
  branchOf(sessionFile, harness).some(
    (entry) =>
      entry.type === "message" &&
      entry.message.role === "user" &&
      JSON.stringify(entry.message.content).includes(text),
  );

describe("child runtime", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  it.each([false, true])(
    "inherits native code-only execution and read permissions (blocked=%s)",
    async (blocked) => {
      const harness = await createAgentSessionHarness();
      process.env.PI_CODING_AGENT_DIR = harness.agentDir;
      const probe = path.join(harness.agentDir, "code-mode-probe.txt");
      await writeFile(probe, "child-code-mode-marker");
      await writeFile(
        path.join(harness.agentDir, "settings.json"),
        JSON.stringify({
          codemode: { mode: "only" },
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      );
      const declared: string[][] = [];
      harness.setResponses([
        (context) => {
          declared.push(getCurrentTools(context.messages).map((tool) => tool.name));

          return fauxAssistantMessage(
            fauxToolCall("codemode", {
              code: `text(await tools.read({ path: ${JSON.stringify(probe)} }));`,
            }),
            { stopReason: "toolUse" },
          );
        },
        fauxAssistantMessage("done"),
      ]);

      const runtime = await createChildRuntime({
        ...runtimeRequest(harness),
        tools: ["bash", "edit", "read", "write", "codemode"],
        bridge: (pi) => {
          pi.on("tool_call", (event) => {
            if (blocked && event.toolName === "read")
              return { block: true, reason: "child read denied" };
          });
        },
      });

      try {
        await expect(runtime.startTurn("Read the probe using Code Mode")).resolves.toMatchObject({
          status: "completed",
        });
        expect(declared.length).toBeGreaterThan(0);
        expect(declared.every((names) => names.length === 1 && names[0] === "codemode")).toBe(true);
        const branch = SessionManager.open(runtime.sessionFile).getBranch();

        const result = branch.findLast(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === "codemode",
        );

        expect(result).toBeDefined();
        const text = JSON.stringify(result);
        expect(text).toContain(blocked ? "child read denied" : "child-code-mode-marker");

        if (blocked) expect(text).not.toContain("child-code-mode-marker");
      } finally {
        await runtime.dispose();
        harness.cleanup();
      }
    },
  );

  it.each(["direct", "deferred", "codemode"] as const)(
    "inherits native discovery, permissions, and MCP cleanup (%s)",
    async (exposure) => {
      const { createCodemodeExtension, createToolSearchExtension } =
        await import("@earendil-works/pi-coding-agent");

      const harness = await createAgentSessionHarness({
        settings: { defaultTools: ["+codemode", "+tool_search"] },
        extensionFactories: [createCodemodeExtension(), createToolSearchExtension()],
      });

      process.env.PI_CODING_AGENT_DIR = harness.agentDir;
      const pidFile = path.join(harness.agentDir, "mcp.pid");

      const server = `
        const fs = require("node:fs");
        fs.writeFileSync(process.argv[1], String(process.pid));
        require("node:readline").createInterface({input:process.stdin}).on("line", line => {
          const request = JSON.parse(line);
          if (request.id === undefined) return;
          let result = {};
          if (request.method === "initialize") result = {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"offline-probe",version:"1"}};
          if (request.method === "tools/list") result = {tools:[{name:"ping",description:"offline probe ping",inputSchema:{type:"object",properties:{},additionalProperties:false}}]};
          if (request.method === "tools/call") result = {content:[{type:"text",text:"native-mcp-marker"}]};
          console.log(JSON.stringify({jsonrpc:"2.0",id:request.id,result}));
        });
      `;

      await writeFile(
        path.join(harness.agentDir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            probe: { command: process.execPath, args: ["-e", server, pidFile], exposure },
          },
        }),
      );
      const results: string[] = [];
      const searches: string[] = [];
      harness.setResponses([
        ...(exposure === "deferred"
          ? [
              fauxAssistantMessage(fauxToolCall("tool_search", { query: "offline probe ping" }), {
                stopReason: "toolUse",
              }),
            ]
          : []),
        fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: 'const found = await searchTools("offline probe ping"); if (!found.some(t => t.name === "mcp__probe__ping")) throw Error("discovery lost"); text(await tools.mcp__probe__ping({}));',
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("first complete"),
        fauxAssistantMessage(
          fauxToolCall("codemode", { code: "text(await tools.mcp__probe__ping({}));" }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("blocked complete"),
      ]);
      let blocked = false;
      let active: string[] = [];

      const runtime = await createChildRuntime({
        ...runtimeRequest(harness),
        tools: harness.session.getActiveToolNames(),
        bridge: (pi) => {
          pi.on("session_start", () => {
            active = pi.getActiveTools();
          });
          pi.on("tool_call", (event) => {
            if (blocked && event.toolName === "mcp__probe__ping")
              return { block: true, reason: "MCP child denied" };
          });
          pi.on("tool_execution_end", (event) => {
            if (event.toolName === "codemode") results.push(JSON.stringify(event.result));

            if (event.toolName === "tool_search") searches.push(JSON.stringify(event.result));
          });
        },
      });

      let pid: number | undefined;

      try {
        expect(active).toContain("tool_search");
        await runtime.startTurn("Discover and call MCP");
        expect(results[0]).toContain("native-mcp-marker");

        if (exposure === "deferred") expect(searches[0]).toContain("mcp__probe__ping");
        pid = Number(await readFile(pidFile, "utf8"));
        blocked = true;
        await runtime.startTurn("Check permission denial");
        expect(results[1]).toContain("MCP child denied");
        expect(results[1]).not.toContain("native-mcp-marker");
      } finally {
        await runtime.dispose();
        harness.cleanup();
      }

      expect(pid).toBeDefined();
      await vi.waitFor(() => {
        expect(() => process.kill(pid!, 0)).toThrow();
      });
    },
  );

  it.each([false, true])(
    "loads discovered personal policies while applying native project trust (trusted=%s)",
    async (trusted) => {
      const harness = await createAgentSessionHarness();
      process.env.PI_CODING_AGENT_DIR = harness.agentDir;
      const cwd = path.dirname(harness.agentDir);
      const projectMarker = path.join(cwd, "project-extension-loaded");
      const protectedPath = path.join(cwd, "protected.txt");
      await writeFile(protectedPath, "protected-content-marker");
      await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi", "extensions", "project.ts"),
        `import {writeFileSync} from "node:fs"; export default () => writeFileSync(${JSON.stringify(projectMarker)}, "loaded");`,
      );
      await writeFile(
        path.join(harness.agentDir, "personal-policy.ts"),
        `export default pi => {
          pi.on("tool_call", event => {
            if (event.toolName === "read") return {block:true,reason:"personal-read-denied"};
            if (event.toolName === "mcp__policy__ping") return {block:true,reason:"personal-mcp-denied"};
          });
        };`,
      );
      await writeFile(
        path.join(harness.agentDir, "settings.json"),
        JSON.stringify({
          extensions: ["./personal-policy.ts"],
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
      );

      const server = `
        require("node:readline").createInterface({input:process.stdin}).on("line", line => {
          const r = JSON.parse(line);
          if (r.id === undefined) return;
          let result = {};
          if (r.method === "initialize") result = {protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:"policy",version:"1"}};
          if (r.method === "tools/list") result = {tools:[{name:"ping",description:"policy ping",inputSchema:{type:"object",properties:{},additionalProperties:false}}]};
          if (r.method === "tools/call") result = {content:[{type:"text",text:"MCP-executed-marker"}]};
          console.log(JSON.stringify({jsonrpc:"2.0",id:r.id,result}));
        });
      `;

      await writeFile(
        path.join(harness.agentDir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            policy: { command: process.execPath, args: ["-e", server], exposure: "codemode" },
          },
        }),
      );
      harness.setResponses([
        fauxAssistantMessage(
          fauxToolCall("codemode", {
            code: `await searchTools("policy ping");
            try {text(await tools.read({path:${JSON.stringify(protectedPath)}}));} catch(e) {text(String(e));}
            try {text(await tools.mcp__policy__ping({}));} catch(e) {text(String(e));}`,
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);

      const runtime = await createChildRuntime({
        ...runtimeRequest(harness),
        trusted,
        tools: ["read", "codemode"],
      });

      try {
        await runtime.startTurn("Check configured policy");

        const results = SessionManager.open(runtime.sessionFile)
          .getBranch()
          .filter((entry) => entry.type === "message" && entry.message.role === "toolResult");

        const text = JSON.stringify(results);
        expect(text).toContain("personal-read-denied");
        expect(text).toContain("personal-mcp-denied");
        expect(text).not.toContain("protected-content-marker");
        expect(text).not.toContain("MCP-executed-marker");
        expect(existsSync(projectMarker)).toBe(trusted);
      } finally {
        await runtime.dispose();
        harness.cleanup();
      }
    },
  );

  it("runs a fresh child on another registered provider with native credentials", async () => {
    const parent = await createAgentSessionHarness({ provider: "parent-provider" });
    const other = await createAgentSessionHarness({ provider: "worker-provider" });
    process.env.PI_CODING_AGENT_DIR = parent.agentDir;
    const model = other.faux.getModel();

    const provider = other.session.extensionRunner
      .getModelRegistry()
      .getRegisteredNativeProvider(model.provider);

    if (provider === undefined) throw new Error("missing faux provider");
    parent.session.modelRuntime.registerNativeProvider(provider);
    await parent.session.modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
    other.setResponses([fauxAssistantMessage("foreign child answer")]);
    const runtime = await createChildRuntime({ ...runtimeRequest(parent), model });

    try {
      expect(runtime.model).toBe(`${model.provider}/${model.id}`);
      await expect(runtime.startTurn("Fresh work")).resolves.toMatchObject({
        status: "completed",
        text: "foreign child answer",
      });
    } finally {
      await runtime.dispose();
      parent.cleanup();
      other.cleanup();
    }
  });

  it("keeps asynchronous user interaction tools root-only while retaining blocking questions", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    harness.setResponses([fauxAssistantMessage("done")]);
    let active: string[] = [];

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      tools: ["request_user_input", "request_user_input_async", "send_message_to_user_async"],
      bridge: (pi) => {
        for (const name of [
          "request_user_input",
          "request_user_input_async",
          "send_message_to_user_async",
        ]) {
          pi.registerTool({
            name,
            label: name,
            description: name,
            parameters: Type.Object({}),
            execute: async () => ({ content: [], details: {} }),
          });
        }

        pi.on("before_agent_start", () => {
          active = pi.getActiveTools();
        });
      },
    });

    try {
      await runtime.startTurn("work");
      expect(active).toContain("request_user_input");
      expect(active).not.toContain("request_user_input_async");
      expect(active).not.toContain("send_message_to_user_async");
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("exposes effective model and thinking after child initialization", async () => {
    const harness = await createAgentSessionHarness({
      models: [
        { id: "child", reasoning: true },
        { id: "selected", reasoning: true },
      ],
    });

    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const selected = harness.faux.getModel("selected");

    if (selected === undefined) {
      throw new Error("The harness did not register the selected model");
    }

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("session_start", async () => {
          await pi.setModel(selected);
          pi.setThinkingLevel("off");
        });
      },
      thinkingLevel: "high",
    });

    try {
      expect(runtime.model).toBe(`${selected.provider}/selected`);
      expect(runtime.thinkingLevel).toBe("off");
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("returns the final answer of a persisted user turn", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    harness.setResponses([fauxAssistantMessage("child answer")]);
    const runtime = await createChildRuntime(runtimeRequest(harness));

    try {
      await expect(runtime.startTurn("task")).resolves.toStrictEqual({
        status: "completed",
        text: "child answer",
      });
      expect(hasUserTask(runtime.sessionFile, harness, "task")).toBeTruthy();
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("resumes a child from its session file", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    harness.setResponses([
      fauxAssistantMessage("first answer"),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain("first answer");

        return fauxAssistantMessage("second answer");
      },
    ]);
    const first = await createChildRuntime(runtimeRequest(harness));
    await first.startTurn("first task");
    await first.dispose();

    const resumed = await createChildRuntime({
      ...runtimeRequest(harness),
      sessionFile: first.sessionFile,
    });

    try {
      await expect(resumed.startTurn("second task")).resolves.toMatchObject({
        text: "second answer",
      });
    } finally {
      await resumed.dispose();
      harness.cleanup();
    }
  });

  it("fails before starting when the child model is not in the cloned runtime", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const model = { ...harness.faux.getModel(), id: "unregistered" };

    try {
      await expect(createChildRuntime({ ...runtimeRequest(harness), model })).rejects.toThrow(
        `Model ${model.provider}/unregistered is not available to child sessions`,
      );
      expect(existsSync(path.join(harness.agentDir, "data", "subagents", "sessions"))).toBeFalsy();
    } finally {
      harness.cleanup();
    }
  });

  it.each([
    [[], true],
    [["-builtin:mcp"], false],
  ] as const)("follows the user's built-in extension settings %j", async (extensions, loaded) => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    await writeFile(path.join(harness.agentDir, "settings.json"), JSON.stringify({ extensions }));
    let commands: string[] = [];

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("session_start", () => {
          commands = pi.getCommands().map((command) => command.name);
        });
      },
    });

    try {
      expect(commands.includes("mcp")).toBe(loaded);
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("lets a user extension replace a built-in tool", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    await mkdir(path.join(harness.agentDir, "extensions"));
    await writeFile(
      path.join(harness.agentDir, "extensions", "my-codemode.ts"),
      `export default (pi) => pi.registerTool({ name: "codemode", label: "mine", description: "third-party codemode", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: undefined }) });`,
    );
    let descriptions: string[] = [];

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("session_start", () => {
          descriptions = pi
            .getAllTools()
            .filter((tool) => tool.name === "codemode")
            .map((tool) => tool.description);
        });
      },
    });

    try {
      expect(descriptions).toStrictEqual(["third-party codemode"]);
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });
});

describe("child mail", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  const mail: Mail = {
    content: "parent context",
    from: "/root",
    id: "mail-1",
    kind: "MESSAGE",
    to: "/root/child",
  };

  /** A child tool that blocks until released, so the turn is streaming while mail arrives. */
  const blockingTool = () => {
    const started = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();

    const bridge: ChildRuntimeRequest["bridge"] = (pi) => {
      pi.registerTool({
        description: "Blocks",
        execute: async () => {
          started.resolve(undefined);
          await release.promise;

          return { content: [{ text: "unblocked", type: "text" }], details: {} };
        },
        label: "Block",
        name: "block",
        parameters: Type.Object({}),
      });
    };

    return { bridge, release, started };
  };

  it("acknowledges mail an idle child transcribes at once", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const delivered: string[] = [];
    harness.setResponses([fauxAssistantMessage("answer")]);

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      onDelivered: (id) => delivered.push(id),
    });

    try {
      await runtime.startTurn("first");
      runtime.deliver(mail);

      expect(delivered).toStrictEqual(["mail-1"]);
      expect(
        branchOf(runtime.sessionFile, harness).some(
          (entry) =>
            entry.type === "custom_message" &&
            JSON.stringify(entry.content).includes("parent context"),
        ),
      ).toBeTruthy();
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("holds mail for a running turn until its boundary and includes it in the next request", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const delivered: string[] = [];
    const block = blockingTool();
    let nextRequest = "";

    harness.setResponses([
      fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
      (context) => {
        nextRequest = JSON.stringify(context.messages);

        return fauxAssistantMessage("done");
      },
    ]);

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: block.bridge,
      onDelivered: (id) => delivered.push(id),
      tools: ["block"],
    });

    try {
      const turn = runtime.startTurn("work");
      await block.started.promise;
      runtime.deliver(mail);
      expect(delivered).toStrictEqual([]);

      block.release.resolve(undefined);
      await expect(turn).resolves.toMatchObject({ text: "done" });
      expect(delivered).toStrictEqual(["mail-1"]);
      expect(nextRequest).toContain(
        "Message Type: MESSAGE\\nTask name: /root/child\\nSender: /root",
      );
    } finally {
      block.release.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("steers a follow-up task into the running turn", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const block = blockingTool();
    let nextRequest = "";

    harness.setResponses([
      fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
      (context) => {
        nextRequest = JSON.stringify(context.messages);

        return fauxAssistantMessage("both done");
      },
    ]);

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: block.bridge,
      tools: ["block"],
    });

    try {
      const turn = runtime.startTurn("work");
      await block.started.promise;

      const read = runtime.steer({
        content: "also this",
        from: "/root",
        kind: "NEW_TASK",
        to: "/root/child",
      });

      block.release.resolve(undefined);

      await expect(turn).resolves.toMatchObject({ text: "both done" });
      await expect(read).resolves.toBe(true);
      expect(nextRequest).toContain("Message Type: NEW_TASK");
      expect(nextRequest).toContain("also this");
    } finally {
      block.release.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("steers a follow-up task into a turn still starting, after its prompt", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const preflightStarted = Promise.withResolvers<undefined>();
    const releasePreflight = Promise.withResolvers<undefined>();
    const requests: string[] = [];

    const task = {
      content: "also this",
      from: "/root",
      kind: "NEW_TASK" as const,
      to: "/root/child",
    };

    harness.setResponses([
      (context) => {
        requests.push(JSON.stringify(context.messages));

        return fauxAssistantMessage("both done");
      },
    ]);

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("before_agent_start", async () => {
          preflightStarted.resolve(undefined);
          await releasePreflight.promise;
        });
      },
      trusted: true,
    });

    try {
      const turn = runtime.startTurn("initial task");
      await preflightStarted.promise;
      const read = runtime.steer(task);
      releasePreflight.resolve(undefined);

      await expect(turn).resolves.toMatchObject({ text: "both done" });
      await expect(read).resolves.toBe(true);
      const [request = ""] = requests;
      expect(requests).toHaveLength(1);
      expect(request.indexOf("also this")).toBeGreaterThan(request.indexOf("initial task"));
      expect(request.indexOf("initial task")).toBeGreaterThan(-1);

      // Once the turn has settled, there is nothing to queue a task for.
      await new Promise((resolve) => setImmediate(resolve));
      expect(runtime.steer(task)).toBeUndefined();
    } finally {
      releasePreflight.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("reports a turn a child extension aborts as failed", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    harness.setResponses([fauxAssistantMessage("unreached")]);

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("before_provider_request", (_event, ctx) => {
          ctx.abort();
        });
      },
      trusted: true,
    });

    try {
      await expect(runtime.startTurn("work")).resolves.toMatchObject({ status: "errored" });
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("reports a turn a child tool aborts as failed, not as its preliminary text", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;

    harness.setResponses([
      fauxAssistantMessage([fauxText("About to do the work"), fauxToolCall("stop", {})], {
        stopReason: "toolUse",
      }),
    ]);

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.registerTool({
          description: "Stops the run",
          execute: async (_id, _params, _signal, _update, ctx) => {
            ctx.abort();

            // Ending the run here leaves the tool-use response as the last assistant message.
            return { content: [{ text: "stopped", type: "text" }], details: {}, terminate: true };
          },
          label: "Stop",
          name: "stop",
          parameters: Type.Object({}),
        });
      },
      tools: ["stop"],
    });

    try {
      await expect(runtime.startTurn("work")).resolves.toStrictEqual({
        error: "Turn was aborted",
        status: "errored",
      });
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("reports a task steered after an aborted run's last read as unread", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    let steer: ChildRuntime["steer"] | undefined;
    let read: Promise<boolean> | undefined;

    harness.setResponses([
      fauxAssistantMessage(fauxToolCall("stop", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("unreached"),
    ]);

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.registerTool({
          description: "Stops the run",
          execute: async (_id, _params, _signal, _update, ctx) => {
            ctx.abort();

            return { content: [{ text: "stopped", type: "text" }], details: {}, terminate: true };
          },
          label: "Stop",
          name: "stop",
          parameters: Type.Object({}),
        });

        // An aborted run skips the settle hook; its settled handlers still run inside the turn.
        pi.on("agent_settled", () => {
          read = steer?.({ content: "late", from: "/root", kind: "NEW_TASK", to: "/root/child" });
        });
      },
      tools: ["stop"],
    });

    steer = runtime.steer;

    try {
      await expect(runtime.startTurn("work")).resolves.toMatchObject({ status: "errored" });
      expect(read).toBeDefined();
      await expect(read).resolves.toBe(false);
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("steers a task into a run that a settle hook continues", async () => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const requests: string[] = [];
    let continued = false;
    let steer: ChildRuntime["steer"] | undefined;
    let read: Promise<boolean> | undefined;

    harness.setResponses([
      fauxAssistantMessage("first"),
      (context) => {
        requests.push(JSON.stringify(context.messages));
        read = steer?.({
          content: "also this",
          from: "/root",
          kind: "NEW_TASK",
          to: "/root/child",
        });

        return fauxAssistantMessage("continued");
      },
      (context) => {
        requests.push(JSON.stringify(context.messages));

        return fauxAssistantMessage("both done");
      },
    ]);

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("agent_before_settle", (event) => {
          if (continued) {
            return undefined;
          }

          continued = true;

          return {
            continue: true,
            entries: [
              ...event.entries,
              {
                content: "Check once more",
                customType: "test-continuation",
                display: false,
                type: "custom_message",
              },
            ],
          };
        });
      },
      trusted: true,
    });

    steer = runtime.steer;

    try {
      await expect(runtime.startTurn("work")).resolves.toMatchObject({ text: "both done" });
      await expect(read).resolves.toBe(true);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toContain("also this");
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });
});

describe("child cancellation", () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  afterEach(() => {
    if (previousAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });

  const tick = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

  const compactingHarness = async (
    compaction: Record<string, number | boolean>,
    contextWindow = 100,
  ) => {
    const harness = await createAgentSessionHarness({
      models: [{ contextWindow, id: "faux-1", maxTokens: 100 }],
    });

    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    await writeFile(path.join(harness.agentDir, "settings.json"), JSON.stringify({ compaction }));

    return harness;
  };

  /** History whose last response overflowed, so the next prompt compacts first. */
  const overflowedHistory = (harness: AgentSessionHarness): ChildRuntimeRequest["history"] => {
    const model = harness.faux.getModel();
    const now = Date.now();

    const previousAssistant: AssistantMessage = {
      ...fauxAssistantMessage("previous response", { stopReason: "length", timestamp: now - 500 }),
      api: model.api,
      model: model.id,
      provider: model.provider,
      usage: usage(100),
    };

    return [
      { content: [{ text: "previous prompt", type: "text" }], role: "user", timestamp: now - 1000 },
      previousAssistant,
    ];
  };

  const compactionResult =
    (summary: string) =>
    (event: { preparation: { firstKeptEntryId: string; tokensBefore: number } }) => ({
      compaction: {
        details: {},
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        summary,
        tokensBefore: event.preparation.tokensBefore,
      },
    });

  it.each([
    ["abort", "input"],
    ["abort", "before_agent_start"],
    ["dispose", "input"],
    ["dispose", "before_agent_start"],
  ] as const)("%s cancels a turn suspended in %s preflight", async (operation, preflightEvent) => {
    const harness = await createAgentSessionHarness();
    process.env.PI_CODING_AGENT_DIR = harness.agentDir;
    const preflightStarted = Promise.withResolvers<undefined>();
    const releasePreflight = Promise.withResolvers<undefined>();
    harness.setResponses([fauxAssistantMessage("detached answer")]);

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        const suspend = async () => {
          preflightStarted.resolve(undefined);
          await releasePreflight.promise;
        };

        if (preflightEvent === "input") {
          pi.on("input", suspend);
        } else {
          pi.on("before_agent_start", suspend);
        }
      },
      trusted: true,
    });

    try {
      const turn = runtime.startTurn("initial task");
      await preflightStarted.promise;

      if (operation === "abort") {
        runtime.abort();
        // The turn settles without waiting for the suspended handler.
        await expect(turn).resolves.toStrictEqual({ status: "interrupted" });
        releasePreflight.resolve(undefined);
      } else {
        let disposed = false;

        const disposal = runtime.dispose().then(() => {
          disposed = true;
        });

        await expect(turn).resolves.toStrictEqual({ status: "interrupted" });
        await tick();
        expect(disposed).toBeFalsy();
        releasePreflight.resolve(undefined);
        await disposal;
      }

      await runtime.dispose();
      expect(harness.getPendingResponseCount()).toBe(1);
      expect(hasUserTask(runtime.sessionFile, harness, "initial task")).toBeFalsy();
    } finally {
      releasePreflight.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it.each(["input", "before_agent_start"] as const)(
    "dispose emits shutdown once while fencing a turn suspended in %s",
    async (preflightEvent) => {
      const harness = await createAgentSessionHarness();
      process.env.PI_CODING_AGENT_DIR = harness.agentDir;
      const preflightStarted = Promise.withResolvers<undefined>();
      const shutdownStarted = Promise.withResolvers<undefined>();
      const releasePreflight = Promise.withResolvers<undefined>();
      let preflightFinished = false;
      let shutdownCount = 0;

      const runtime = await createChildRuntime({
        ...runtimeRequest(harness),
        bridge: (pi) => {
          const suspend = async () => {
            preflightStarted.resolve(undefined);
            await shutdownStarted.promise;
            await releasePreflight.promise;
            preflightFinished = true;
          };

          if (preflightEvent === "input") {
            pi.on("input", suspend);
          } else {
            pi.on("before_agent_start", suspend);
          }

          pi.on("session_shutdown", () => {
            shutdownCount += 1;
            shutdownStarted.resolve(undefined);
          });
        },
        trusted: true,
      });

      try {
        const turn = runtime.startTurn("initial task");
        await preflightStarted.promise;
        let disposed = false;

        const disposals = Promise.all([runtime.dispose(), runtime.dispose()]).then(() => {
          disposed = true;
        });

        // Shutdown reaches handlers while the suspended preflight still runs.
        await shutdownStarted.promise;
        await tick();
        expect({ disposed, preflightFinished }).toStrictEqual({
          disposed: false,
          preflightFinished: false,
        });

        releasePreflight.resolve(undefined);
        await disposals;
        expect(preflightFinished).toBeTruthy();
        await expect(turn).resolves.toStrictEqual({ status: "interrupted" });
        await runtime.dispose();
        expect(shutdownCount).toBe(1);
      } finally {
        releasePreflight.resolve(undefined);
        await runtime.dispose();
        harness.cleanup();
      }
    },
  );

  it("keeps a turn cancelled during input preflight from compacting", async () => {
    const harness = await compactingHarness({
      enabled: true,
      keepRecentTokens: 1,
      reserveTokens: 0,
    });

    const inputStarted = Promise.withResolvers<undefined>();
    const releaseInput = Promise.withResolvers<undefined>();
    let compactionStarted = false;

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("input", async () => {
          inputStarted.resolve(undefined);
          await releaseInput.promise;
        });
        pi.on("session_before_compact", (event) => {
          compactionStarted = true;

          return compactionResult("preflight compaction")(event);
        });
      },
      history: overflowedHistory(harness),
      trusted: true,
    });

    try {
      const turn = runtime.startTurn("cancelled task");
      await inputStarted.promise;
      runtime.abort();
      await expect(turn).resolves.toStrictEqual({ status: "interrupted" });

      const disposal = runtime.dispose();
      releaseInput.resolve(undefined);
      await disposal;

      expect(compactionStarted).toBeFalsy();
      expect(
        branchOf(runtime.sessionFile, harness).filter((entry) => entry.type === "compaction"),
      ).toHaveLength(0);
      expect(hasUserTask(runtime.sessionFile, harness, "cancelled task")).toBeFalsy();
      expect(harness.getPendingResponseCount()).toBe(0);
    } finally {
      releaseInput.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("keeps a turn cancelled during delayed auth from compacting", async () => {
    const harness = await compactingHarness({
      enabled: true,
      keepRecentTokens: 1,
      reserveTokens: 0,
    });

    const authStarted = Promise.withResolvers<undefined>();
    const releaseAuth = Promise.withResolvers<undefined>();
    const model = harness.faux.getModel();

    const apiKeyAuth = harness.session.extensionRunner
      .getModelRegistry()
      .getRegisteredNativeProvider(model.provider)?.auth.apiKey;

    if (apiKeyAuth?.check === undefined) {
      throw new Error("Faux auth availability check is unavailable");
    }

    const checkAuth = apiKeyAuth.check.bind(apiKeyAuth);
    let blockAuth = false;

    // Pi checks configured auth during preflight, before pre-prompt compaction.
    const authSpy = vi.spyOn(apiKeyAuth, "check").mockImplementation(async (input) => {
      if (!blockAuth) return undefined;
      authStarted.resolve(undefined);
      await releaseAuth.promise;

      return checkAuth(input);
    });

    let compactionStarted = false;

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("session_before_compact", (event) => {
          compactionStarted = true;

          return compactionResult("late preflight compaction")(event);
        });
      },
      history: overflowedHistory(harness),
      trusted: true,
    });

    blockAuth = true;

    try {
      const turn = runtime.startTurn("cancelled task");
      await authStarted.promise;
      runtime.abort();
      releaseAuth.resolve(undefined);
      await runtime.dispose();
      await expect(turn).resolves.toStrictEqual({ status: "interrupted" });

      expect(compactionStarted).toBeFalsy();
      expect(
        branchOf(runtime.sessionFile, harness).filter((entry) => entry.type === "compaction"),
      ).toHaveLength(0);
      expect(hasUserTask(runtime.sessionFile, harness, "cancelled task")).toBeFalsy();
    } finally {
      authSpy.mockRestore();
      releaseAuth.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("aborts signal-aware pre-prompt compaction", async () => {
    const harness = await compactingHarness({
      enabled: true,
      keepRecentTokens: 1,
      reserveTokens: 0,
    });

    const compactionStarted = Promise.withResolvers<undefined>();

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("session_before_compact", async (event) => {
          compactionStarted.resolve(undefined);

          if (!event.signal.aborted) {
            await new Promise<void>((resolve) => {
              event.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }

          return { cancel: true };
        });
      },
      history: overflowedHistory(harness),
      trusted: true,
    });

    try {
      const turn = runtime.startTurn("cancelled task");
      await compactionStarted.promise;
      runtime.abort();
      await runtime.dispose();
      await expect(turn).resolves.toStrictEqual({ status: "interrupted" });

      expect(
        branchOf(runtime.sessionFile, harness).filter((entry) => entry.type === "compaction"),
      ).toHaveLength(0);
      expect(hasUserTask(runtime.sessionFile, harness, "cancelled task")).toBeFalsy();
      expect(harness.getPendingResponseCount()).toBe(0);
    } finally {
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("cancels post-run compaction blocked in summary auth", async () => {
    const harness = await compactingHarness({
      enabled: true,
      keepRecentTokens: 1,
      reserveTokens: 10,
    });

    const authStarted = Promise.withResolvers<undefined>();
    const releaseAuth = Promise.withResolvers<undefined>();
    const model = harness.faux.getModel();

    const apiKeyAuth = harness.session.extensionRunner
      .getModelRegistry()
      .getRegisteredNativeProvider(model.provider)?.auth.apiKey;

    if (apiKeyAuth === undefined) {
      throw new Error("Faux API key auth is unavailable");
    }

    const resolveAuth = apiKeyAuth.resolve.bind(apiKeyAuth);
    let blockAuth = false;

    const authSpy = vi.spyOn(apiKeyAuth, "resolve").mockImplementation(async (input) => {
      if (blockAuth) {
        authStarted.resolve(undefined);
        await releaseAuth.promise;
      }

      return resolveAuth(input);
    });

    harness.setResponses([
      async () => {
        blockAuth = true;

        return {
          ...fauxAssistantMessage("child answer"),
          api: model.api,
          model: model.id,
          provider: model.provider,
          usage: usage(91),
        };
      },
      fauxAssistantMessage("unexpected summary"),
    ]);

    const runtime = await createChildRuntime({ ...runtimeRequest(harness), trusted: true });

    try {
      const turn = runtime.startTurn("initial task");
      await authStarted.promise;
      runtime.abort();
      releaseAuth.resolve(undefined);

      await expect(turn).resolves.toStrictEqual({ status: "completed", text: "child answer" });
      expect(
        branchOf(runtime.sessionFile, harness).filter((entry) => entry.type === "compaction"),
      ).toHaveLength(0);
      expect(harness.getPendingResponseCount()).toBe(1);
    } finally {
      authSpy.mockRestore();
      releaseAuth.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("does not retry after an overflow compaction once cancelled", async () => {
    const harness = await compactingHarness(
      { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
      1000,
    );

    const compacted = Promise.withResolvers<undefined>();
    const releaseCompaction = Promise.withResolvers<undefined>();
    const model = harness.faux.getModel();
    let willRetry = false;

    harness.setResponses([
      {
        ...fauxAssistantMessage("partial answer", { stopReason: "length" }),
        api: model.api,
        model: model.id,
        provider: model.provider,
        usage: usage(100),
      },
      fauxAssistantMessage("unexpected retry"),
    ]);

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("session_before_compact", compactionResult("overflow compaction"));
        pi.on("session_compact", async (event) => {
          willRetry = event.willRetry;
          compacted.resolve(undefined);
          await releaseCompaction.promise;
        });
      },
      trusted: true,
    });

    try {
      const turn = runtime.startTurn("x".repeat(5000));
      await compacted.promise;
      expect(willRetry).toBeTruthy();
      runtime.abort();
      releaseCompaction.resolve(undefined);

      await expect(turn).resolves.toStrictEqual({ status: "interrupted" });
      expect(harness.getPendingResponseCount()).toBe(1);
    } finally {
      releaseCompaction.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });

  it("does not send an overflow retry cancelled during context conversion", async () => {
    const harness = await compactingHarness(
      { enabled: true, keepRecentTokens: 1, reserveTokens: 0 },
      1000,
    );

    const streamSpy = vi.spyOn(ModelRuntime.prototype, "streamSimple");
    const retryContextStarted = Promise.withResolvers<undefined>();
    const releaseRetryContext = Promise.withResolvers<undefined>();
    const model = harness.faux.getModel();
    let blockRetryContext = false;

    harness.setResponses([
      {
        ...fauxAssistantMessage("partial answer", { stopReason: "length" }),
        api: model.api,
        model: model.id,
        provider: model.provider,
        usage: usage(100),
      },
      fauxAssistantMessage("unexpected retry"),
    ]);

    const runtime = await createChildRuntime({
      ...runtimeRequest(harness),
      bridge: (pi) => {
        pi.on("context", async (event) => {
          if (blockRetryContext) {
            retryContextStarted.resolve(undefined);
            await releaseRetryContext.promise;
          }

          return { messages: event.messages };
        });
        pi.on("session_before_compact", compactionResult("overflow compaction"));
        pi.on("session_compact", () => {
          blockRetryContext = true;
        });
      },
      trusted: true,
    });

    try {
      const turn = runtime.startTurn("x".repeat(5000));
      await retryContextStarted.promise;
      expect(streamSpy).toHaveBeenCalledTimes(1);
      runtime.abort();
      await tick();
      releaseRetryContext.resolve(undefined);

      await expect(turn).resolves.toStrictEqual({ status: "interrupted" });
      // The retry reaches the provider only with an aborted signal, so no request is built.
      expect(
        harness.providerPayloads(Type.Object({}, { additionalProperties: true })),
      ).toHaveLength(1);
      expect(harness.getPendingResponseCount()).toBe(1);
    } finally {
      streamSpy.mockRestore();
      releaseRetryContext.resolve(undefined);
      await runtime.dispose();
      harness.cleanup();
    }
  });
});
